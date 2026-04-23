import type { Bar, BarTimeframe, Quote } from '../../../shared/src';

// -----------------------------------------------------------------------------
// Provider abstraction. Everything the rest of the server knows about pricing
// goes through this interface. To switch providers later (Polygon, Finnhub,
// IEX Cloud, etc.) you write a new class and change the factory — nothing
// else in the app should need to change.
// -----------------------------------------------------------------------------

export type UnsubscribeFn = () => void;

export interface PriceStreamHandlers {
  onQuote: (quote: Quote) => void;
  onStatusChange: (status: 'connected' | 'disconnected' | 'error', detail?: string) => void;
}

export interface PriceProvider {
  /** Short name for debug surfaces ("alpaca"). */
  readonly name: string;

  /**
   * Fetch the latest snapshot (price + OHLC + bid/ask + volume) for a batch
   * of symbols in a single call.
   */
  fetchQuotes(symbols: string[]): Promise<Record<string, Quote>>;

  /**
   * Fetch historical OHLC bars for a single symbol. Used for charts.
   */
  fetchBars(symbol: string, timeframe: BarTimeframe, limit: number): Promise<Bar[]>;

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
}
