import WebSocket from 'ws';
import type { Bar, BarTimeframe, Quote } from '../../../shared/src';
import type { AppConfig } from '../config';
import type {
  PriceProvider,
  PriceStreamHandlers,
  UnsubscribeFn,
} from './PriceProvider';

// -----------------------------------------------------------------------------
// Alpaca implementation of PriceProvider.
//
// REST: https://docs.alpaca.markets/reference/stocksnapshots-1
// WS:   https://docs.alpaca.markets/docs/real-time-stock-pricing-data
//
// Free-tier notes:
//  - IEX feed only. SIP requires a paid data subscription.
//  - REST is limited to 200 req/min. We rely on QuoteCache for throttling.
//  - Exactly 1 concurrent WS connection per account (free tier). All frontend
//    clients share this single upstream connection via PriceStreamHub.
//
// Everything Alpaca-specific lives in this file. Nothing outside imports from
// the 'ws' package or hits data.alpaca.markets directly.
// -----------------------------------------------------------------------------

interface AlpacaLatestTrade {
  p: number;
  t: string;
}
interface AlpacaLatestQuote {
  ap: number;
  bp: number;
  t: string;
}
interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
interface AlpacaSnapshot {
  latestTrade?: AlpacaLatestTrade;
  latestQuote?: AlpacaLatestQuote;
  dailyBar?: AlpacaBar;
  prevDailyBar?: AlpacaBar;
  minuteBar?: AlpacaBar;
}
type AlpacaSnapshotsResponse = Record<string, AlpacaSnapshot | null>;

interface AlpacaBarsResponse {
  bars?: Record<string, AlpacaBar[] | undefined>;
}

type WsAuthMsg = {
  T: 'success' | 'error' | 'subscription';
  msg?: string;
  code?: number;
  trades?: string[];
};
type WsTradeMsg = { T: 't'; S: string; p: number; t: string };
type WsQuoteMsg = {
  T: 'q';
  S: string;
  ap: number;
  bp: number;
  t: string;
};
type WsMsg = WsAuthMsg | WsTradeMsg | WsQuoteMsg;

export class AlpacaProvider implements PriceProvider {
  readonly name = 'alpaca';

  private ws: WebSocket | null = null;
  private handlers: PriceStreamHandlers | null = null;
  private subscribed = new Set<string>();
  private pendingSubscribe = new Set<string>();
  private pendingUnsubscribe = new Set<string>();
  private authenticated = false;
  private shuttingDown = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly cfg: AppConfig) {}

  // -------------------------- REST: snapshots -------------------------------

  async fetchQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    if (symbols.length === 0) return {};
    const unique = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
    const url = new URL('/v2/stocks/snapshots', this.cfg.alpaca.restBaseUrl);
    url.searchParams.set('symbols', unique.join(','));
    url.searchParams.set('feed', this.cfg.alpaca.feed);

    const res = await fetch(url, { headers: this.restHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Alpaca snapshots failed: ${res.status} ${res.statusText} ${body}`,
      );
    }
    const raw = (await res.json()) as Record<string, unknown>;

    // Alpaca has varied between returning the object keyed directly by symbol
    // and returning { snapshots: {...} }. Accept both.
    const snapshots: AlpacaSnapshotsResponse =
      typeof raw.snapshots === 'object' && raw.snapshots !== null
        ? (raw.snapshots as AlpacaSnapshotsResponse)
        : (raw as AlpacaSnapshotsResponse);

    const out: Record<string, Quote> = {};
    for (const sym of unique) {
      const snap = snapshots[sym];
      if (!snap || !snap.latestTrade) continue;
      out[sym] = alpacaSnapshotToQuote(sym, snap);
    }
    return out;
  }

  // -------------------------- REST: bars ------------------------------------

  async fetchBars(
    symbol: string,
    timeframe: BarTimeframe,
    limit: number,
  ): Promise<Bar[]> {
    const sym = symbol.toUpperCase();
    const url = new URL('/v2/stocks/bars', this.cfg.alpaca.restBaseUrl);
    url.searchParams.set('symbols', sym);
    url.searchParams.set('timeframe', timeframe);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('feed', this.cfg.alpaca.feed);
    url.searchParams.set('adjustment', 'raw');

    const res = await fetch(url, { headers: this.restHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Alpaca bars failed: ${res.status} ${res.statusText} ${body}`,
      );
    }
    const json = (await res.json()) as AlpacaBarsResponse;
    const raw = json.bars?.[sym] ?? [];
    return raw.map(alpacaBarToBar);
  }

  // -------------------------- WebSocket stream ------------------------------

  async startStream(
    initialSymbols: string[],
    handlers: PriceStreamHandlers,
  ): Promise<UnsubscribeFn> {
    this.handlers = handlers;
    this.shuttingDown = false;
    for (const s of initialSymbols) this.subscribed.add(s.toUpperCase());
    this.connect();
    return () => {
      this.shuttingDown = true;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.ws?.close();
      this.ws = null;
      this.authenticated = false;
    };
  }

  async updateSubscriptions(symbols: string[]): Promise<void> {
    const desired = new Set(symbols.map((s) => s.toUpperCase()));
    const toAdd: string[] = [];
    const toRemove: string[] = [];
    for (const s of desired) if (!this.subscribed.has(s)) toAdd.push(s);
    for (const s of this.subscribed) if (!desired.has(s)) toRemove.push(s);

    for (const s of toAdd) this.subscribed.add(s);
    for (const s of toRemove) this.subscribed.delete(s);

    if (!this.ws || !this.authenticated) {
      // Queue for after auth; handled by handleMessage on the 'authenticated' event.
      toAdd.forEach((s) => this.pendingSubscribe.add(s));
      toRemove.forEach((s) => this.pendingUnsubscribe.add(s));
      return;
    }

    if (toAdd.length > 0) {
      this.ws.send(
        JSON.stringify({ action: 'subscribe', trades: toAdd }),
      );
    }
    if (toRemove.length > 0) {
      this.ws.send(
        JSON.stringify({ action: 'unsubscribe', trades: toRemove }),
      );
    }
  }

  // -------------------------- internals -------------------------------------

  private restHeaders(): Record<string, string> {
    return {
      'APCA-API-KEY-ID': this.cfg.alpaca.keyId,
      'APCA-API-SECRET-KEY': this.cfg.alpaca.secretKey,
      Accept: 'application/json',
    };
  }

  private connect(): void {
    if (this.shuttingDown) return;
    this.authenticated = false;
    this.ws = new WebSocket(this.cfg.alpaca.wsUrl);

    this.ws.on('open', () => {
      this.ws?.send(
        JSON.stringify({
          action: 'auth',
          key: this.cfg.alpaca.keyId,
          secret: this.cfg.alpaca.secretKey,
        }),
      );
    });

    this.ws.on('message', (raw) => {
      let msgs: WsMsg[];
      try {
        msgs = JSON.parse(raw.toString()) as WsMsg[];
      } catch {
        return;
      }
      for (const msg of msgs) this.handleMessage(msg);
    });

    this.ws.on('error', (err: Error) => {
      this.handlers?.onStatusChange('error', err.message);
    });

    this.ws.on('close', () => {
      this.authenticated = false;
      this.handlers?.onStatusChange('disconnected');
      if (this.shuttingDown) return;
      this.reconnectTimer = setTimeout(
        () => this.connect(),
        this.cfg.limits.WS_RECONNECT_DELAY_MS,
      );
    });
  }

  private handleMessage(msg: WsMsg): void {
    if (msg.T === 't') {
      // Trade tick.
      const price = msg.p;
      const timestamp = Date.parse(msg.t) || Date.now();
      const quote: Quote = {
        symbol: msg.S,
        price,
        bid: null,
        ask: null,
        dayOpen: null,
        dayHigh: null,
        dayLow: null,
        prevClose: null,
        volume: null,
        timestamp,
        status: 'live',
      };
      this.handlers?.onQuote(quote);
      return;
    }
    if (msg.T === 'success' && msg.msg === 'authenticated') {
      this.authenticated = true;
      this.handlers?.onStatusChange('connected');
      // Drain pending subscriptions built up before auth completed.
      const initial = Array.from(this.subscribed);
      if (initial.length > 0) {
        this.ws?.send(
          JSON.stringify({ action: 'subscribe', trades: initial }),
        );
      }
      if (this.pendingUnsubscribe.size > 0) {
        this.ws?.send(
          JSON.stringify({
            action: 'unsubscribe',
            trades: Array.from(this.pendingUnsubscribe),
          }),
        );
        this.pendingUnsubscribe.clear();
      }
      this.pendingSubscribe.clear();
      return;
    }
    if (msg.T === 'error') {
      this.handlers?.onStatusChange('error', msg.msg);
    }
  }
}

// -------------------------- mapping helpers ---------------------------------

function alpacaSnapshotToQuote(symbol: string, snap: AlpacaSnapshot): Quote {
  const trade = snap.latestTrade;
  const quote = snap.latestQuote;
  const daily = snap.dailyBar;
  const prevDaily = snap.prevDailyBar;

  const price = trade?.p ?? daily?.c ?? 0;
  const timestamp = trade?.t ? Date.parse(trade.t) || Date.now() : Date.now();

  return {
    symbol,
    price,
    bid: quote?.bp ?? null,
    ask: quote?.ap ?? null,
    dayOpen: daily?.o ?? null,
    dayHigh: daily?.h ?? null,
    dayLow: daily?.l ?? null,
    prevClose: prevDaily?.c ?? null,
    volume: daily?.v ?? null,
    timestamp,
    status: 'live',
  };
}

function alpacaBarToBar(bar: AlpacaBar): Bar {
  return {
    t: Date.parse(bar.t) || 0,
    o: bar.o,
    h: bar.h,
    l: bar.l,
    c: bar.c,
    v: bar.v,
  };
}
