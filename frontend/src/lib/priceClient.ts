import { io, type Socket } from "socket.io-client";
import { api } from "@chongbei/web-basics/client";
import { dump } from "./dump";
import type {
  AlpacaFeed,
  AssetLookupResponse,
  BarsResponse,
  BarTimeframe,
  ClientToServerEvents,
  LiveFeedResponse,
  PriceTickPayload,
  ProviderStatusPayload,
  Quote,
  QuotesResponse,
  ServerToClientEvents,
  SubscriptionsResponse,
} from "../../../shared/src";
import { SOCKET_EVENTS } from "../../../shared/src";
import { config } from "../config";

// -----------------------------------------------------------------------------
// Single source of truth for talking to the backend. REST calls are cached
// by the server; the socket delivers live trade ticks. All UI code that
// needs a price goes through here — no component fetches prices directly.
// -----------------------------------------------------------------------------

export interface PriceClientSubscribers {
  onTick: (tick: PriceTickPayload) => void;
  onStatus: (status: ProviderStatusPayload) => void;
  onConnectionChange: (connected: boolean) => void;
}

export class PriceClient {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null =
    null;
  private readonly baseUrl: string;
  // Coalesce concurrent ensureSubscribed() calls with identical args. React
  // StrictMode in dev double-invokes effect bodies, so without this we'd fire
  // POST /api/subscriptions twice on every symbol change. Keyed by the
  // sorted symbol set; cleared once the in-flight promise settles.
  private inflightSubs = new Map<string, Promise<SubscriptionsResponse>>();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /** Batched snapshot fetch. Errors throw ApiError + fire a toast. */
  async fetchQuotes(symbols: string[]): Promise<QuotesResponse> {
    const q = new URLSearchParams({
      symbols: symbols.map((s) => s.toUpperCase()).join(","),
    });
    return api<QuotesResponse>(`${this.baseUrl}/api/quotes?${q}`);
  }

  /**
   * Historical OHLC bars. Backend caches per (symbol, timeframe, limit) so
   * repeating these calls is cheap. Used to seed the intraday sparkline.
   */
  async fetchBars(
    symbol: string,
    timeframe: BarTimeframe,
    limit: number,
    opts?: { feed?: AlpacaFeed },
  ): Promise<BarsResponse> {
    const q = new URLSearchParams({
      symbol: symbol.toUpperCase(),
      timeframe,
      limit: String(limit),
    });
    if (opts?.feed) q.set("feed", opts.feed);
    return api<BarsResponse>(`${this.baseUrl}/api/bars?${q}`);
  }

  /**
   * Switch the live WS feed at runtime (Alpaca only). The server tears down
   * the current WS, reopens against `feed`, and re-subscribes. On failure
   * (e.g. account not entitled to SIP for streaming), the response carries
   * `fellBack: true` and `feed` is the *restored* prior feed — UI should
   * surface a toast and reflect the actual active feed.
   */
  async setLiveFeed(feed: AlpacaFeed): Promise<LiveFeedResponse> {
    return api<LiveFeedResponse>(`${this.baseUrl}/api/live-feed`, {
      method: "POST",
      body: JSON.stringify({ feed }),
    });
  }

  /** Read the currently active live WS feed. */
  async getLiveFeed(): Promise<LiveFeedResponse> {
    return api<LiveFeedResponse>(`${this.baseUrl}/api/live-feed`);
  }

  /**
   * "Is this a real, tradable symbol?" — provider-mode-independent. Used by
   * the watchlist add flow so users can add valid tickers even when the
   * live feed (or replay fixture) has nothing to show right now. Returns
   * `{ asset: null }` when the upstream catalog has no record of `symbol`.
   */
  async lookupAsset(symbol: string): Promise<AssetLookupResponse> {
    const q = new URLSearchParams({ symbol: symbol.toUpperCase() });
    return api<AssetLookupResponse>(`${this.baseUrl}/api/assets/lookup?${q}`);
  }

  /**
   * Mirror the backend's WS subscription set to exactly `symbols` — the
   * full union of UI interest (watchlist ∪ positions ∪ orders ∪ alerts ∪
   * detail/trade/alert tickers). The server uses replace semantics so
   * symbols dropped from the union are unsubscribed upstream. Errors
   * throw ApiError + fire a toast via configureApi.
   */
  async ensureSubscribed(symbols: string[]): Promise<SubscriptionsResponse> {
    const upper = symbols.map((s) => s.toUpperCase());
    const key = [...upper].sort().join(",");
    const existing = this.inflightSubs.get(key);
    if (existing) return existing;
    const p = api<SubscriptionsResponse>(`${this.baseUrl}/api/subscriptions`, {
      method: "POST",
      body: JSON.stringify({ symbols: upper }),
    }).finally(() => {
      this.inflightSubs.delete(key);
    });
    this.inflightSubs.set(key, p);
    return p;
  }

  /** Open the socket and start pushing ticks to the subscriber. */
  connect(subs: PriceClientSubscribers): void {
    console.log("PriceClient.connect subs:\n" + dump(subs));
    if (this.socket) return;
    const socket = io(this.baseUrl, {
      reconnection: true,
      reconnectionDelay: 2_000,
      timeout: 4_000,
    });
    socket.on("connect", () => subs.onConnectionChange(true));
    socket.on("disconnect", () => subs.onConnectionChange(false));
    socket.on("connect_error", () => subs.onConnectionChange(false));
    socket.on(SOCKET_EVENTS.PRICE_TICK, subs.onTick);
    socket.on(SOCKET_EVENTS.PROVIDER_STATUS, subs.onStatus);
    this.socket = socket;
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }
}

/** Module-level singleton — exactly one socket per tab. */
export const priceClient = new PriceClient(config.backendUrl);

// Re-export for callers that want the Quote type without a long path.
export type { Quote, QuotesResponse };
