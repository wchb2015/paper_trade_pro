import fs from "node:fs";
import path from "node:path";
import { getLogger } from "@chongbei/web-basics/server";
import type {
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
import { openNdjson, type LineReader } from "./replay/ndjsonLineReader";
import { MinHeap } from "./replay/minHeap";

const log = getLogger("providers.ReplayProvider");

// -----------------------------------------------------------------------------
// ReplayProvider
//
// Reads historical trades that fetchTrades.ts downloaded into
//   backend/.replay-cache/<date>/<SYMBOL>.ndjson
// and emits them through the same PriceProvider interface AlpacaProvider uses.
// PriceStreamHub then forwards each tick over Socket.io — the frontend sees
// identical `price:tick` events regardless of source.
//
// Key properties:
//  * Streaming reader per symbol (no whole-file buffering).
//  * Min-heap merge across symbols → global chronological order.
//  * Simulated clock with configurable speed (1x real-time, 10x, or
//    REPLAY_SPEED=0 = as-fast-as-possible for stress testing).
//  * Optional loop at EOD so the UI stays alive indefinitely.
// -----------------------------------------------------------------------------

interface AlpacaTradeLine {
  t: string;
  p: number;
  s?: number;
  x?: string;
  c?: string[];
  z?: string;
  i?: number;
}

interface SymbolStream {
  symbol: string;
  reader: LineReader;
  /** The next un-emitted trade (peek buffer for the heap). */
  nextTrade: AlpacaTradeLine | null;
  /** Parsed epoch-ms of nextTrade.t for quick heap compare. */
  nextTradeMs: number;
  ended: boolean;
}

export class ReplayProvider implements PriceProvider {
  readonly name = "replay";

  private handlers: PriceStreamHandlers | null = null;
  private shuttingDown = false;

  /** Per-symbol file cursor + peek buffer. */
  private streams = new Map<string, SymbolStream>();

  /** Symbols the caller currently wants live. Drives add/remove on updates. */
  private subscribed = new Set<string>();

  /** Most recently emitted price per symbol — used by fetchQuotes snapshots. */
  private lastPrice = new Map<string, { price: number; timestamp: number }>();

  /** Bar cache so the chart doesn't re-scan the file on every render. */
  private barsCache = new Map<string, Bar[]>();

  /**
   * Per-symbol intraday accumulators updated as ticks emit. Seeded with the
   * file's first trade on first read so `fetchQuotes` has a non-null `dayOpen`
   * immediately. `high/low` reflect the simulation's progress, not the
   * pre-computed full-day total — that matches the running replay clock.
   */
  private dayStats = new Map<
    string,
    { open: number; high: number; low: number }
  >();

  /** Anchors for sim-clock ↔ wall-clock mapping. */
  private wallStartMs = 0;
  private simStartMs = 0;

  /** Heap key = { symbol, ms } ordered ascending by ms. */
  private heap = new MinHeap<{ symbol: string; ms: number }>(
    (a, b) => a.ms - b.ms,
  );

  private schedulerTimer: NodeJS.Timeout | null = null;

  /**
   * True between `startStream` (or `updateSubscriptions` reviving the stream)
   * and the scheduler exiting on an empty heap with no looping. Used so a
   * later `updateSubscriptions` can wake the scheduler back up — without
   * this, the very common boot-with-empty-subscriptions sequence permanently
   * kills tick emission and the UI stays static at the very first trade.
   */
  private schedulerIdle = true;

  constructor(private readonly cfg: AppConfig) {}

  // -------------------------- REST-style snapshots --------------------------

  async fetchQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    const normalized = symbols.map((s) => s.toUpperCase());
    log.info(
      {
        operation: "replay.fetchQuotes",
        count: normalized.length,
        symbols: normalized,
      },
      "fetchQuotes",
    );
    const out: Record<string, Quote> = {};
    for (const raw of symbols) {
      const sym = raw.toUpperCase();
      const last = this.lastPrice.get(sym);
      if (last) {
        out[sym] = this.buildQuoteForSymbol(sym, last.price, last.timestamp);
        continue;
      }
      // No tick has been emitted yet — peek the first trade on disk if we can
      // so the UI has something to render before the scheduler starts. Also
      // seed dayStats so `dayOpen` is non-null on this first snapshot (the
      // detail page header uses it as the day-change baseline).
      const first = this.peekFirstTrade(sym);
      if (first) {
        this.seedDayStats(sym, first.p);
        out[sym] = this.buildQuoteForSymbol(
          sym,
          first.p,
          Date.parse(first.t) || Date.now(),
        );
      }
    }
    return out;
  }

  /** Initialize the day's OHLC accumulator on first sight of a symbol. */
  private seedDayStats(symbol: string, price: number): void {
    if (this.dayStats.has(symbol)) return;
    this.dayStats.set(symbol, { open: price, high: price, low: price });
  }

  /** Fold a newly-emitted trade into the running OHLC stats. */
  private updateDayStats(symbol: string, price: number): void {
    const cur = this.dayStats.get(symbol);
    if (!cur) {
      this.seedDayStats(symbol, price);
      return;
    }
    if (price > cur.high) cur.high = price;
    if (price < cur.low) cur.low = price;
  }

  private buildQuoteForSymbol(
    symbol: string,
    price: number,
    timestamp: number,
  ): Quote {
    const stats = this.dayStats.get(symbol);
    return {
      symbol,
      price,
      bid: null,
      ask: null,
      dayOpen: stats?.open ?? null,
      dayHigh: stats?.high ?? null,
      dayLow: stats?.low ?? null,
      // Replay only loads a single trading day — there is no prior file to
      // derive prevClose from. TODO: have fetchTrades.ts persist yesterday's
      // close in <SYMBOL>.meta.json and read it here so the day-change column
      // can render in replay mode.
      prevClose: null,
      timestamp,
      status: "live",
    };
  }

  // -------------------------- Historical bars -------------------------------

  async fetchBars(
    symbol: string,
    timeframe: BarTimeframe,
    limit: number,
    // Replay reads from local NDJSON; Alpaca feed selector is irrelevant.
    _opts?: { feed?: 'iex' | 'sip' },
  ): Promise<Bar[]> {
    const sym = symbol.toUpperCase();
    const key = `${sym}::${timeframe}`;
    const cached = this.barsCache.get(key);
    if (cached) return cached.slice(-limit);

    const filePath = this.pathFor(sym);
    if (!fs.existsSync(filePath)) return [];

    const bucketMs = timeframeToMs(timeframe);
    const raw = fs.readFileSync(filePath, "utf8");
    const bars: Bar[] = [];
    let cur: Bar | null = null;

    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      let tr: AlpacaTradeLine;
      try {
        tr = JSON.parse(line) as AlpacaTradeLine;
      } catch {
        continue;
      }
      const ts = Date.parse(tr.t);
      if (!Number.isFinite(ts)) continue;
      const bucket = Math.floor(ts / bucketMs) * bucketMs;
      if (!cur || cur.t !== bucket) {
        if (cur) bars.push(cur);
        cur = { t: bucket, o: tr.p, h: tr.p, l: tr.p, c: tr.p, v: tr.s ?? 0 };
      } else {
        cur.h = Math.max(cur.h, tr.p);
        cur.l = Math.min(cur.l, tr.p);
        cur.c = tr.p;
        cur.v += tr.s ?? 0;
      }
    }
    if (cur) bars.push(cur);

    this.barsCache.set(key, bars);
    return bars.slice(-limit);
  }

  // -------------------------- Streaming -------------------------------------

  async startStream(
    initialSymbols: string[],
    handlers: PriceStreamHandlers,
  ): Promise<UnsubscribeFn> {
    this.handlers = handlers;
    this.shuttingDown = false;

    for (const s of initialSymbols) this.subscribed.add(s.toUpperCase());
    await this.openStreams(Array.from(this.subscribed));

    this.anchorClock();
    this.startScheduler();
    handlers.onStatusChange(
      "connected",
      `replay ${this.cfg.replay.date} @ ${this.cfg.replay.speed}x`,
    );

    return async () => {
      this.shuttingDown = true;
      if (this.schedulerTimer) clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
      for (const s of this.streams.values()) await s.reader.close();
      this.streams.clear();
      this.heap = new MinHeap((a, b) => a.ms - b.ms);
    };
  }

  async updateSubscriptions(symbols: string[]): Promise<void> {
    const desired = new Set(symbols.map((s) => s.toUpperCase()));
    const toAdd: string[] = [];
    const toRemove: string[] = [];
    for (const s of desired) if (!this.subscribed.has(s)) toAdd.push(s);
    for (const s of this.subscribed) if (!desired.has(s)) toRemove.push(s);

    for (const s of toAdd) this.subscribed.add(s);
    for (const s of toRemove) {
      this.subscribed.delete(s);
      const stream = this.streams.get(s);
      if (stream) {
        await stream.reader.close();
        this.streams.delete(s);
      }
    }
    if (toAdd.length > 0) {
      await this.openStreams(toAdd);
      // New streams need to join the heap; re-anchor if we were idle.
      if (this.heap.size === 0) this.anchorClock();
      // Boot path opens the upstream stream with no subscribed symbols, so
      // the scheduler hits an empty heap on its first tick and exits. When
      // the watchlist later subscribes, we have to bring the scheduler back
      // up — otherwise emitted ticks never leave the heap.
      if (this.schedulerIdle && this.heap.size > 0) {
        this.anchorClock();
        this.handlers?.onStatusChange(
          "connected",
          `replay ${this.cfg.replay.date} @ ${this.cfg.replay.speed}x`,
        );
        this.startScheduler();
      }
    }
  }

  getReplaySpeed(): number {
    return this.cfg.replay.speed;
  }

  getReplayDate(): string {
    return this.cfg.replay.date;
  }

  /**
   * Catalog lookup is provider-mode-independent — the user is asking "is JD
   * a real, tradable ticker?" not "do you have today's replay file?". We
   * proxy directly to the Alpaca trading API using the same creds the rest
   * of the app already requires. If those creds aren't usable (offline,
   * 401, etc.) the route will surface the upstream error to the client.
   */
  async lookupAsset(symbol: string): Promise<AssetLookup | null> {
    const sym = symbol.toUpperCase();
    const url = new URL(
      `/v2/assets/${encodeURIComponent(sym)}`,
      this.cfg.alpaca.tradingBaseUrl,
    );
    const res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": this.cfg.alpaca.keyId,
        "APCA-API-SECRET-KEY": this.cfg.alpaca.secretKey,
        Accept: "application/json",
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Alpaca assets failed: ${res.status} ${res.statusText} ${body}`,
      );
    }
    const raw = (await res.json()) as {
      symbol?: string;
      name?: string;
      exchange?: string;
      tradable?: boolean;
    };
    return {
      symbol: (raw.symbol ?? sym).toUpperCase(),
      name: raw.name ?? null,
      tradable: raw.tradable === true,
      exchange: raw.exchange ?? null,
    };
  }

  getUnavailableSymbols(symbols: string[]): Record<string, UnavailableReason> {
    const out: Record<string, UnavailableReason> = {};
    for (const raw of symbols) {
      const sym = raw.toUpperCase();
      // pathFor() consults this.cfg.replay.cacheDir + replay.date — same path
      // openStreams() uses, so this answer is consistent with what the live
      // stream would do.
      if (!fs.existsSync(this.pathFor(sym))) {
        out[sym] = {
          code: "no-replay-data",
          message: `No replay file for ${sym} on ${this.cfg.replay.date}.`,
        };
      }
    }
    return out;
  }

  // -------------------------- internals -------------------------------------

  private pathFor(symbol: string): string {
    return path.join(
      this.cfg.replay.cacheDir,
      this.cfg.replay.date,
      `${symbol}.ndjson`,
    );
  }

  private peekFirstTrade(symbol: string): AlpacaTradeLine | null {
    const filePath = this.pathFor(symbol);
    if (!fs.existsSync(filePath)) return null;
    // Read the first ~2KB and grab the first complete line.
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(2048);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const chunk = buf.slice(0, n).toString("utf8");
      const nl = chunk.indexOf("\n");
      const line = nl === -1 ? chunk : chunk.slice(0, nl);
      if (line.trim().length === 0) return null;
      return JSON.parse(line) as AlpacaTradeLine;
    } catch {
      return null;
    } finally {
      fs.closeSync(fd);
    }
  }

  private async openStreams(symbols: string[]): Promise<void> {
    for (const sym of symbols) {
      if (this.streams.has(sym)) continue;
      const filePath = this.pathFor(sym);
      if (!fs.existsSync(filePath)) {
        this.handlers?.onStatusChange(
          "error",
          `replay: no data for ${sym} on ${this.cfg.replay.date}`,
        );
        continue;
      }
      const reader = openNdjson(filePath);
      const first = (await reader.next()) as AlpacaTradeLine | null;
      if (!first) {
        await reader.close();
        continue;
      }
      const ms = Date.parse(first.t);
      const stream: SymbolStream = {
        symbol: sym,
        reader,
        nextTrade: first,
        nextTradeMs: ms,
        ended: false,
      };
      this.streams.set(sym, stream);
      this.heap.push({ symbol: sym, ms });
    }
  }

  private anchorClock(): void {
    // Align the sim clock to the earliest un-emitted trade across all streams.
    const head = this.heap.peek();
    this.simStartMs = head ? head.ms : Date.now();
    this.wallStartMs = Date.now();
  }

  private simNow(): number {
    const speed = this.cfg.replay.speed;
    if (speed <= 0) return Number.POSITIVE_INFINITY; // drain as fast as possible
    return this.simStartMs + (Date.now() - this.wallStartMs) * speed;
  }

  private startScheduler(): void {
    this.schedulerIdle = false;
    const tick = async (): Promise<void> => {
      if (this.shuttingDown) return;
      try {
        await this.drainDue();
      } catch (err) {
        log.error(
          { err, operation: "replay.drainDue" },
          "EXCEPTION replay scheduler tick failed",
        );
        this.handlers?.onStatusChange(
          "error",
          `replay scheduler: ${(err as Error).message}`,
        );
      }
      if (this.heap.size === 0) {
        if (this.cfg.replay.loop && this.streams.size > 0) {
          await this.reopenLoop();
          this.schedulerTimer = setTimeout(tick, 50);
        } else {
          this.handlers?.onStatusChange("disconnected", "replay ended");
          this.schedulerTimer = null;
          this.schedulerIdle = true;
        }
        return;
      }
      this.schedulerTimer = setTimeout(tick, 20);
    };
    this.schedulerTimer = setTimeout(tick, 0);
  }

  private async drainDue(): Promise<void> {
    const cutoff = this.simNow();
    while (true) {
      const head = this.heap.peek();
      if (!head || head.ms > cutoff) return;
      this.heap.pop();
      const stream = this.streams.get(head.symbol);
      if (!stream || !stream.nextTrade) continue;

      const trade = stream.nextTrade;
      const tsMs = stream.nextTradeMs;
      this.emitTrade(stream.symbol, trade, tsMs);

      // Advance the stream: read the next line, push back onto heap.
      const next = (await stream.reader.next()) as AlpacaTradeLine | null;
      if (!next) {
        stream.ended = true;
        stream.nextTrade = null;
        continue;
      }
      const nextMs = Date.parse(next.t);
      stream.nextTrade = next;
      stream.nextTradeMs = nextMs;
      this.heap.push({ symbol: stream.symbol, ms: nextMs });
    }
  }

  private emitTrade(
    symbol: string,
    trade: AlpacaTradeLine,
    tsMs: number,
  ): void {
    // Map replay timestamps onto *now* so the frontend's "stale" detection
    // (which compares against Date.now()) doesn't immediately flag everything
    // as stale. Preserve real timestamps in lastPrice for snapshots.
    const emittedTs = Date.now();
    this.lastPrice.set(symbol, { price: trade.p, timestamp: emittedTs });
    this.updateDayStats(symbol, trade.p);
    const quote: Quote = this.buildQuoteForSymbol(symbol, trade.p, emittedTs);
    // Pass tsMs as `simTimestamp` so the frontend can show a running replay
    // clock anchored to the historical session, not wall-clock time.
    this.handlers?.onQuote(quote, { simTimestamp: tsMs });
  }

  private async reopenLoop(): Promise<void> {
    const symbols = Array.from(this.streams.keys());
    for (const s of this.streams.values()) await s.reader.close();
    this.streams.clear();
    this.heap = new MinHeap((a, b) => a.ms - b.ms);
    // New "day" — reset running OHLCV so the next loop starts at the file's
    // first trade as that day's open, not yesterday's running totals.
    this.dayStats.clear();
    await this.openStreams(symbols);
    this.anchorClock();
  }
}

function timeframeToMs(tf: BarTimeframe): number {
  switch (tf) {
    case "1Min":
      return 60_000;
    case "5Min":
      return 5 * 60_000;
    case "15Min":
      return 15 * 60_000;
    case "1Hour":
      return 60 * 60_000;
    case "1Day":
      return 24 * 60 * 60_000;
  }
}
