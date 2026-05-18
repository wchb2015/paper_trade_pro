import WebSocket from "ws";
import { getLogger } from "@chongbei/web-basics/server";
import type {
  AlpacaFeed,
  AssetLookup,
  Bar,
  BarTimeframe,
  Quote,
  UnavailableReason,
} from "../../../shared/src";
import type { AppConfig } from "../config";
import type {
  PriceProvider,
  PriceStreamHandlers,
  UnsubscribeFn,
} from "./PriceProvider";

const log = getLogger("providers.AlpacaProvider");

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

/**
 * Subset of the Trading-API `/v2/assets/{symbol}` response we care about.
 * Full shape: https://docs.alpaca.markets/reference/getassetbysymbol
 */
interface AlpacaAsset {
  symbol: string;
  name?: string;
  exchange?: string;
  tradable?: boolean;
  status?: string;
}

type WsAuthMsg = {
  T: "success" | "error" | "subscription";
  msg?: string;
  code?: number;
  trades?: string[];
};
type WsTradeMsg = { T: "t"; S: string; p: number; t: string };
type WsQuoteMsg = {
  T: "q";
  S: string;
  ap: number;
  bp: number;
  t: string;
};
type WsMsg = WsAuthMsg | WsTradeMsg | WsQuoteMsg;

export class AlpacaProvider implements PriceProvider {
  readonly name = "alpaca";

  private ws: WebSocket | null = null;
  private handlers: PriceStreamHandlers | null = null;
  private subscribed = new Set<string>();
  private pendingSubscribe = new Set<string>();
  private pendingUnsubscribe = new Set<string>();
  private authenticated = false;
  private shuttingDown = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  // Live WS feed currently in use. Initialized from cfg at construction;
  // setLiveFeed() mutates it at runtime when the user flips the chart's
  // Ext (IEX/SIP) toggle.
  private liveFeed: AlpacaFeed;
  // Set when the most recent 'error' frame from Alpaca was auth-class
  // ('insufficient subscription', 'connection limit exceeded', etc.). The
  // close handler reads this to decide whether to schedule an auto-reconnect
  // — auth errors will repeat forever on the same URL/creds, so spinning on
  // them just spams Alpaca.
  private lastErrorWasAuth = false;

  constructor(private readonly cfg: AppConfig) {
    this.liveFeed = cfg.alpaca.feed;
  }

  /** Currently active live WS feed (drives ProviderStatusPayload.feed). */
  getLiveFeed(): AlpacaFeed {
    return this.liveFeed;
  }

  /**
   * Switch the live WS feed at runtime. Closes the current connection,
   * opens a new one against the requested feed, and re-subscribes to the
   * existing symbol set after auth completes.
   *
   * Awaits successful authentication on the new feed before resolving so
   * callers can synchronously detect "this feed isn't authorized for your
   * account" (free-tier accounts → SIP). On failure, restores the prior
   * feed and rethrows so PriceStreamHub can surface a fallback toast.
   */
  async setLiveFeed(feed: AlpacaFeed): Promise<void> {
    if (feed === this.liveFeed && this.ws) return;
    const previous = this.liveFeed;
    log.info(
      { from: previous, to: feed, operation: "alpaca.setLiveFeed" },
      "switching live WS feed",
    );
    this.liveFeed = feed;
    try {
      await this.reconnectWithCurrentFeed();
    } catch (err) {
      log.error(
        { err, requested: feed, fallingBackTo: previous, operation: "alpaca.setLiveFeed" },
        "ERROR setLiveFeed failed; falling back to previous feed",
      );
      this.liveFeed = previous;
      // Best-effort restore. If this also fails, the caller's onStatusChange
      // already surfaced the disconnect.
      await this.reconnectWithCurrentFeed().catch((restoreErr: unknown) => {
        log.error(
          { err: restoreErr, operation: "alpaca.setLiveFeed.restore" },
          "ERROR failed to restore previous feed after a failed switch",
        );
      });
      throw err;
    }
  }

  private wsUrlForCurrentFeed(): string {
    // Honor an explicit override if env set one (rare — used in tests),
    // otherwise derive from the in-memory liveFeed.
    if (
      this.cfg.alpaca.wsUrl &&
      !this.cfg.alpaca.wsUrl.endsWith("/iex") &&
      !this.cfg.alpaca.wsUrl.endsWith("/sip")
    ) {
      return this.cfg.alpaca.wsUrl;
    }
    return `wss://stream.data.alpaca.markets/v2/${this.liveFeed}`;
  }

  private async reconnectWithCurrentFeed(): Promise<void> {
    if (!this.handlers) {
      // Stream hasn't started yet; nothing to reconnect. setFeed() before
      // start() just changes the value used when start() eventually fires.
      return;
    }
    // Suppress the close-listener's timer-based auto-reconnect; we drive the
    // reconnect explicitly below. Cancel any pending one too.
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Wait for the prior socket to fully close before opening a new one.
    // Alpaca's free tier allows exactly 1 concurrent WS per account; if we
    // open the second one before the first finishes tearing down, we get
    // 'connection limit exceeded' on the new connection. Manual close +
    // wait-for-close is the only reliable way around this.
    await this.closeCurrentSocket();

    this.authenticated = false;
    this.shuttingDown = false;

    // Resolve when auth succeeds on the new feed; reject if Alpaca returns
    // an auth error (e.g. account not entitled to SIP) within a short window.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Alpaca WS auth timed out (5s) after feed switch"));
      }, 5_000);
      const originalHandlers = this.handlers;
      if (!originalHandlers) {
        clearTimeout(timeout);
        resolve();
        return;
      }
      // Wrap the existing handlers so we can resolve/reject this promise
      // without losing the hub's subscriber.
      this.handlers = {
        onQuote: originalHandlers.onQuote,
        onStatusChange: (status, detail) => {
          originalHandlers.onStatusChange(status, detail);
          if (status === "connected") {
            clearTimeout(timeout);
            // Restore the original handler so future status events aren't
            // intercepted by our promise-resolver.
            this.handlers = originalHandlers;
            resolve();
          } else if (status === "error") {
            clearTimeout(timeout);
            this.handlers = originalHandlers;
            reject(new Error(detail ?? "Alpaca WS error during feed switch"));
          }
        },
      };
      this.connect();
    });
  }

  /**
   * Close the current WebSocket and resolve only after the upstream actually
   * closes (or after a 3s safety cap). Handles all three states: no socket,
   * already-closed socket, mid-handshake socket. Used to enforce the free
   * tier's 1-concurrent-connection limit during a feed switch.
   */
  private closeCurrentSocket(): Promise<void> {
    const sock = this.ws;
    if (!sock) return Promise.resolve();
    if (sock.readyState === WebSocket.CLOSED) {
      this.ws = null;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      // Best-effort cap: if Alpaca holds the close response, don't deadlock
      // the feed switch — proceed and let the new connect race the cleanup.
      const cap = setTimeout(() => {
        log.warn(
          { operation: "alpaca.closeCurrentSocket.timeout" },
          "WS close did not complete within 3s; proceeding anyway",
        );
        finish();
      }, 3_000);
      sock.once("close", () => {
        clearTimeout(cap);
        finish();
      });
      try {
        sock.close();
      } catch (closeErr) {
        log.warn(
          { err: closeErr, operation: "alpaca.closeCurrentSocket" },
          "non-fatal error invoking ws.close()",
        );
        clearTimeout(cap);
        finish();
      }
      this.ws = null;
    });
  }

  // -------------------------- REST: snapshots -------------------------------

  async fetchQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    if (symbols.length === 0) return {};
    const unique = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
    log.debug(
      {
        operation: "alpaca.fetchQuotes",
        count: unique.length,
        symbols: unique,
      },
      "fetchQuotes",
    );
    const url = new URL("/v2/stocks/snapshots", this.cfg.alpaca.restBaseUrl);
    url.searchParams.set("symbols", unique.join(","));
    // Track the active live feed so quote snapshots stay coherent with
    // whatever the WS stream is currently delivering.
    url.searchParams.set("feed", this.liveFeed);

    const res = await fetch(url, { headers: this.restHeaders() });
    if (!res.ok) {
      const body = await res.text().catch((readErr: unknown) => {
        log.error(
          {
            err: readErr,
            operation: "alpaca.snapshots.readErrorBody",
            status: res.status,
          },
          "failed to read Alpaca snapshots error body",
        );
        return "";
      });
      throw new Error(
        `Alpaca snapshots failed: ${res.status} ${res.statusText} ${body}`,
      );
    }
    const raw = (await res.json()) as Record<string, unknown>;

    // Alpaca has varied between returning the object keyed directly by symbol
    // and returning { snapshots: {...} }. Accept both.
    const snapshots: AlpacaSnapshotsResponse =
      typeof raw.snapshots === "object" && raw.snapshots !== null
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
    opts?: { feed?: AlpacaFeed },
  ): Promise<Bar[]> {
    const sym = symbol.toUpperCase();
    // Per-request override wins; otherwise default to the active live feed
    // (so historical bars and live ticks stay coherent by default).
    const feed = opts?.feed ?? this.liveFeed;
    const url = new URL("/v2/stocks/bars", this.cfg.alpaca.restBaseUrl);
    url.searchParams.set("symbols", sym);
    url.searchParams.set("timeframe", timeframe);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("feed", feed);
    url.searchParams.set("adjustment", "raw");
    // Without `start`, Alpaca defaults it to today 00:00 UTC and returns just
    // today's bar regardless of `limit`. Ask for the most recent `limit` bars
    // by walking back far enough to cover weekends/holidays, then sort=desc
    // so the newest bars come first; we reverse to ascending below.
    url.searchParams.set(
      "start",
      new Date(Date.now() - barsLookbackMs(timeframe, limit)).toISOString(),
    );
    url.searchParams.set("sort", "desc");

    const res = await fetch(url, { headers: this.restHeaders() });
    if (!res.ok) {
      const body = await res.text().catch((readErr: unknown) => {
        log.error(
          {
            err: readErr,
            operation: "alpaca.bars.readErrorBody",
            status: res.status,
          },
          "failed to read Alpaca bars error body",
        );
        return "";
      });
      throw new Error(
        `Alpaca bars failed: ${res.status} ${res.statusText} ${body}`,
      );
    }
    const json = (await res.json()) as AlpacaBarsResponse;
    const raw = json.bars?.[sym] ?? [];
    return raw.map(alpacaBarToBar).reverse();
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
      this.ws.send(JSON.stringify({ action: "subscribe", trades: toAdd }));
    }
    if (toRemove.length > 0) {
      this.ws.send(JSON.stringify({ action: "unsubscribe", trades: toRemove }));
    }
  }

  getUnavailableSymbols(_symbols: string[]): Record<string, UnavailableReason> {
    // Alpaca doesn't expose per-symbol availability synchronously. Anything
    // unknown will surface as an empty Quote on fetchQuotes / a stream-side
    // error — same behavior as today.
    return {};
  }

  // -------------------------- REST: assets catalog --------------------------

  async lookupAsset(symbol: string): Promise<AssetLookup | null> {
    const sym = symbol.toUpperCase();
    const url = new URL(
      `/v2/assets/${encodeURIComponent(sym)}`,
      this.cfg.alpaca.tradingBaseUrl,
    );
    const res = await fetch(url, { headers: this.restHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch((readErr: unknown) => {
        log.error(
          {
            err: readErr,
            operation: "alpaca.assets.readErrorBody",
            status: res.status,
          },
          "failed to read Alpaca assets error body",
        );
        return "";
      });
      throw new Error(
        `Alpaca assets failed: ${res.status} ${res.statusText} ${body}`,
      );
    }
    const raw = (await res.json()) as AlpacaAsset;
    return {
      symbol: (raw.symbol ?? sym).toUpperCase(),
      name: raw.name ?? null,
      tradable: raw.tradable === true,
      exchange: raw.exchange ?? null,
    };
  }

  // -------------------------- internals -------------------------------------

  private restHeaders(): Record<string, string> {
    return {
      "APCA-API-KEY-ID": this.cfg.alpaca.keyId,
      "APCA-API-SECRET-KEY": this.cfg.alpaca.secretKey,
      Accept: "application/json",
    };
  }

  private connect(): void {
    if (this.shuttingDown) return;
    this.authenticated = false;
    this.lastErrorWasAuth = false;
    // Recompute every connect so a runtime feed switch picks up the new
    // URL on reconnect. wsUrlForCurrentFeed() honors an env override only
    // when it isn't a /iex|/sip suffix (so tests can pin a local stub URL).
    this.ws = new WebSocket(this.wsUrlForCurrentFeed());

    this.ws.on("open", () => {
      this.ws?.send(
        JSON.stringify({
          action: "auth",
          key: this.cfg.alpaca.keyId,
          secret: this.cfg.alpaca.secretKey,
        }),
      );
    });

    this.ws.on("message", (raw) => {
      let msgs: WsMsg[];
      try {
        msgs = JSON.parse(raw.toString()) as WsMsg[];
      } catch {
        return;
      }
      for (const msg of msgs) this.handleMessage(msg);
    });

    this.ws.on("error", (err: Error) => {
      this.handlers?.onStatusChange("error", err.message);
    });

    this.ws.on("close", () => {
      this.authenticated = false;
      this.handlers?.onStatusChange("disconnected");
      if (this.shuttingDown) return;
      // Don't auto-reconnect on auth-class errors ('insufficient subscription',
      // 'connection limit exceeded', 'auth failed') — those will fail forever
      // on the same URL with the same credentials. The setLiveFeed flow is
      // expected to drive an explicit reconnect on a different URL when the
      // feed changes; otherwise we'd just spam Alpaca every 5s.
      if (this.lastErrorWasAuth) {
        log.warn(
          { operation: "alpaca.connect.skipAutoReconnect" },
          "skipping auto-reconnect after auth-class WS error",
        );
        return;
      }
      // Coalesce — if a timer is already pending we don't need a second one.
      if (this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, this.cfg.limits.WS_RECONNECT_DELAY_MS);
    });
  }

  private handleMessage(msg: WsMsg): void {
    if (msg.T === "t") {
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
        timestamp,
        status: "live",
      };
      this.handlers?.onQuote(quote);
      return;
    }
    if (msg.T === "success" && msg.msg === "authenticated") {
      this.authenticated = true;
      this.handlers?.onStatusChange("connected");
      // Drain pending subscriptions built up before auth completed.
      const initial = Array.from(this.subscribed);
      if (initial.length > 0) {
        this.ws?.send(JSON.stringify({ action: "subscribe", trades: initial }));
      }
      if (this.pendingUnsubscribe.size > 0) {
        this.ws?.send(
          JSON.stringify({
            action: "unsubscribe",
            trades: Array.from(this.pendingUnsubscribe),
          }),
        );
        this.pendingUnsubscribe.clear();
      }
      this.pendingSubscribe.clear();
      return;
    }
    if (msg.T === "error") {
      // Alpaca error codes that mean "this connection will never authenticate
      // with these inputs" (https://docs.alpaca.markets/docs/real-time-stock-pricing-data#error-codes):
      //   402 = auth failed
      //   406 = connection limit exceeded
      //   409 = insufficient subscription
      // For these, suppress auto-reconnect — caller is expected to drive
      // setLiveFeed() with a different feed or accept the failure.
      const code = msg.code;
      if (code === 402 || code === 406 || code === 409) {
        this.lastErrorWasAuth = true;
      }
      this.handlers?.onStatusChange("error", msg.msg);
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
    timestamp,
    status: "live",
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

// Window of wall-clock time we need to look back to *probably* contain `limit`
// bars of `timeframe`. For 1Day we 2× to cover weekends + holidays; for
// intraday we go an extra day to cover overnight gaps. Over-fetching is fine —
// Alpaca trims to `limit` and the route layer caches by (sym, tf, limit).
function barsLookbackMs(timeframe: BarTimeframe, limit: number): number {
  const DAY = 86_400_000;
  switch (timeframe) {
    case "1Day":
      return Math.max(limit * 2 * DAY, 7 * DAY);
    case "1Hour":
      return Math.max(Math.ceil(limit / 7) * DAY + DAY, 2 * DAY);
    case "15Min":
      return Math.max(Math.ceil(limit / 26) * DAY + DAY, 2 * DAY);
    case "5Min":
      return Math.max(Math.ceil(limit / 78) * DAY + DAY, 2 * DAY);
    case "1Min":
      return Math.max(Math.ceil(limit / 390) * DAY + DAY, 2 * DAY);
  }
}
