// Non-secret constants shared by both tiers.

/**
 * Alpaca free-tier guardrails. Everything here is conservative on purpose —
 * it's easier to loosen than it is to recover from a rate-limit lockout.
 *
 * Reference: Alpaca free-tier allows up to 200 REST requests/min and a single
 * concurrent WebSocket connection on the IEX feed.
 */
export const FREE_TIER = {
  /** How long a cached /snapshots response is reused before re-fetching. */
  SNAPSHOT_CACHE_TTL_MS: 10_000,
  /** How long a cached bars response is reused. Bars rarely move intraday. */
  BARS_CACHE_TTL_MS: 5 * 60_000,
  /** Ceiling on live WS subscriptions we'll request (free tier is generous). */
  MAX_STREAM_SYMBOLS: 30,
  /**
   * If no WS tick has arrived for a subscribed symbol for this long, the UI
   * marks it as `stale`. 60s is generous — IEX has quiet periods for
   * illiquid symbols during regular hours.
   */
  STALE_AFTER_MS: 60_000,
  /** WS reconnect backoff floor. */
  WS_RECONNECT_DELAY_MS: 5_000,
} as const;

/**
 * Default watchlist used when a user has no saved portfolio. Tickers only —
 * prices come from the provider, not hard-coded values.
 */
export const DEFAULT_WATCHLIST: readonly string[] = [
  'TQQQ',
  'SQQQ',
  'TSLA',
  'AMZN',
  'COIN',
];

export const PROVIDERS = ['alpaca'] as const;
export type ProviderName = (typeof PROVIDERS)[number];
