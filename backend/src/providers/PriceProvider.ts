import type {
  AlpacaFeed,
  AssetLookup,
  Bar,
  BarTimeframe,
  Quote,
  UnavailableReason,
} from '../../../shared/src';

// -----------------------------------------------------------------------------
// Provider abstraction. Everything the rest of the server knows about pricing
// goes through this interface. To switch providers later (Polygon, Finnhub,
// IEX Cloud, etc.) you write a new class and change the factory — nothing
// else in the app should need to change.
// -----------------------------------------------------------------------------

export type UnsubscribeFn = () => void;

/**
 * Optional per-tick metadata that a provider may attach. Today only
 * ReplayProvider sets `simTimestamp` (the historical clock the tick maps
 * to in the original session) so the UI can render a running replay clock.
 */
export interface TickMeta {
  simTimestamp?: number;
}

export interface PriceStreamHandlers {
  onQuote: (quote: Quote, meta?: TickMeta) => void;
  onStatusChange: (status: 'connected' | 'disconnected' | 'error', detail?: string) => void;
}

export interface PriceProvider {
  /** Short name for debug surfaces ("alpaca"). */
  readonly name: string;

  /**
   * Fetch the latest snapshot (price + OHLC + bid/ask) for a batch of
   * symbols in a single call.
   */
  fetchQuotes(symbols: string[]): Promise<Record<string, Quote>>;

  /**
   * Fetch historical OHLC bars for a single symbol. Used for charts.
   * `feed` lets the caller override the configured Alpaca feed for this
   * one request (only honored by AlpacaProvider; ignored elsewhere) so the
   * UI can flip iex↔sip per request without a server restart.
   */
  fetchBars(
    symbol: string,
    timeframe: BarTimeframe,
    limit: number,
    opts?: { feed?: AlpacaFeed },
  ): Promise<Bar[]>;

  /**
   * Start (or extend) a real-time stream for `symbols`. Idempotent — calling
   * with the same set is a no-op; calling with a larger set adds the new
   * symbols; calling with a smaller set removes the missing ones.
   *
   * Returns an unsubscribe that tears down the whole stream (used on
   * shutdown; individual symbol churn goes through `updateSubscriptions`).
   */
  startStream(
    initialSymbols: string[],
    handlers: PriceStreamHandlers,
  ): Promise<UnsubscribeFn>;

  /** Replace the current subscription set. */
  updateSubscriptions(symbols: string[]): Promise<void>;

  /**
   * Synchronously report any of the requested symbols this provider knows it
   * cannot currently price. Returns an empty object when everything is fine.
   * Intentionally sync — implementations should be cheap (cached file-stat,
   * in-memory lookup). Don't make HTTP calls here.
   */
  getUnavailableSymbols(symbols: string[]): Record<string, UnavailableReason>;

  /**
   * Validate a single symbol against the upstream catalog. Returns null when
   * the symbol is unknown to the catalog — distinct from "the symbol is
   * known but we don't have a price right now". This must NOT depend on
   * runtime feed state (replay fixtures, IEX silence, etc.) — it's the
   * "is this a real, tradable ticker?" check. Replay providers should
   * proxy to the underlying live catalog.
   */
  lookupAsset(symbol: string): Promise<AssetLookup | null>;

  /**
   * Replay-only: playback rate (1 = real-time, 10 = 10x, 0 = ASAP). Returns
   * undefined for live providers — the frontend uses this to extrapolate the
   * sim clock between ticks for the running replay clock display.
   */
  getReplaySpeed?(): number;

  /**
   * Replay-only: the trading date being replayed (YYYY-MM-DD, ET wall-clock).
   * Returns undefined for live providers. Used to label the status pill.
   */
  getReplayDate?(): string;

  /**
   * Alpaca-only: the live WS feed currently in use ('iex' | 'sip'). Used by
   * the hub to surface the feed in ProviderStatusPayload and by the live-feed
   * route to report current state on read.
   */
  getLiveFeed?(): AlpacaFeed;

  /**
   * Alpaca-only: tear down the current WS, reopen against `feed`, and
   * re-subscribe to the existing symbol set. Resolves once the new feed is
   * authenticated; rejects if Alpaca rejects auth (e.g. account not entitled
   * to SIP) — caller is expected to fall back. Idempotent on no-op.
   */
  setLiveFeed?(feed: AlpacaFeed): Promise<void>;
}
