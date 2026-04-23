// Canonical price/quote contracts shared between frontend and backend.
// Every price in the app flows through these shapes — no provider-specific
// fields leak past the provider layer.

/**
 * Runtime status of a quote. Drives UI affordances ("Live" vs "Stale" vs "—").
 */
export type PriceStatus = 'live' | 'stale' | 'unavailable';

/**
 * A normalized market quote. Any field that a provider cannot supply is null
 * rather than a made-up number — the UI renders "—" for nulls.
 */
export interface Quote {
  symbol: string;
  /** Most recent trade price. */
  price: number;
  /** Top-of-book best bid / ask (null if provider doesn't expose it). */
  bid: number | null;
  ask: number | null;
  /** Today's session OHLC so far. */
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  /** Previous session's close — useful for day-change %. */
  prevClose: number | null;
  /** Today's cumulative volume. */
  volume: number | null;
  /** Epoch ms of the latest trade. */
  timestamp: number;
  /** Provider freshness as of the response. */
  status: PriceStatus;
}

/**
 * A single OHLC bar for historical charts.
 */
export interface Bar {
  t: number; // epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type BarTimeframe = '1Min' | '5Min' | '15Min' | '1Hour' | '1Day';

/** REST responses. */
export interface QuotesResponse {
  quotes: Record<string, Quote>;
  /** Provider-wide status (e.g. "unavailable" if creds are missing). */
  providerStatus: PriceStatus;
  /** Provider name (surfacing in UI for debug / "provider: alpaca"). */
  provider: string;
}

export interface BarsResponse {
  symbol: string;
  timeframe: BarTimeframe;
  bars: Bar[];
  provider: string;
}

export interface SubscriptionsResponse {
  subscribed: string[];
}

/**
 * Socket.io tick payload — trimmed to just what the UI needs per tick.
 */
export interface PriceTickPayload {
  symbol: string;
  price: number;
  timestamp: number;
}

/** Connection-level status pushed over the socket. */
export interface ProviderStatusPayload {
  status: PriceStatus;
  provider: string;
  /** Optional human-readable detail for the UI. */
  message?: string;
}
