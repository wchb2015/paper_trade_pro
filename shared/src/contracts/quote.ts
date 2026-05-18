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

/**
 * Alpaca market-data feed selector. `iex` is the free single-exchange feed
 * (IEX-only trades, ~08:00–17:00 ET coverage). `sip` is the paid consolidated
 * SIP tape (full 04:00–20:00 ET extended-hours session, all exchanges).
 *
 * Threaded as an optional per-request override on `/api/bars` so the UI can
 * switch feeds without restarting the server.
 */
export type AlpacaFeed = 'iex' | 'sip';

/**
 * Why a particular symbol cannot be priced right now. Currently emitted
 * by the replay provider for symbols whose NDJSON file is missing for
 * the configured REPLAY_DATE. The discriminator lets us add new reasons
 * (unknown-symbol, fetch-failed, etc.) later without reshaping clients.
 */
export interface UnavailableReason {
  code: 'no-replay-data';
  /** Human-readable, ready to render verbatim in the UI. */
  message: string;
}

/** REST responses. */
export interface QuotesResponse {
  quotes: Record<string, Quote>;
  /** Provider-wide status (e.g. "unavailable" if creds are missing). */
  providerStatus: PriceStatus;
  /** Provider name (surfacing in UI for debug / "provider: alpaca"). */
  provider: string;
  /**
   * Symbols the provider knows it cannot price right now (e.g. replay
   * has no NDJSON file for the configured date). Keyed by symbol.
   * Optional so existing clients ignore it gracefully.
   */
  unavailable?: Record<string, UnavailableReason>;
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
 * Result of "is this a real, tradable symbol?" — independent of whether the
 * provider has a current price for it. Used by the watchlist add flow so
 * users can add valid tickers even when the live feed (or replay fixture)
 * has nothing to show right this moment.
 */
export interface AssetLookup {
  /** Canonical (uppercased) ticker symbol. */
  symbol: string;
  /** Friendly company / fund name when the upstream catalog supplies one. */
  name: string | null;
  /** Whether the asset is currently tradable. False ⇒ delisted, halted, etc. */
  tradable: boolean;
  /** Free-form exchange code from the upstream catalog (e.g. "NASDAQ"). */
  exchange: string | null;
}

export interface AssetLookupResponse {
  /** Null when the upstream catalog has no record of the symbol. */
  asset: AssetLookup | null;
}

/**
 * Socket.io tick payload — trimmed to just what the UI needs per tick.
 */
export interface PriceTickPayload {
  symbol: string;
  price: number;
  /** Wall-clock epoch ms when the tick was emitted (drives stale detection). */
  timestamp: number;
  /**
   * Replay-only: the *simulated* market timestamp this tick represents
   * (epoch ms in the original session). The frontend extrapolates between
   * ticks using `providerStatus.replaySpeed` to render a running clock.
   * Absent under live providers — the wall clock is the truth there.
   */
  simTimestamp?: number;
}

/** Connection-level status pushed over the socket. */
export interface ProviderStatusPayload {
  status: PriceStatus;
  provider: string;
  /** Optional human-readable detail for the UI. */
  message?: string;
  /**
   * Replay-only: playback rate (1 = real-time, 10 = ten-times faster, 0
   * = drain ASAP). Frontend uses this to extrapolate the sim clock between
   * ticks. Absent under live providers.
   */
  replaySpeed?: number;
  /**
   * Replay-only: trading date being replayed (YYYY-MM-DD, ET wall-clock).
   * Frontend renders it on the status pill so the user can tell at a glance
   * which session they're watching. Absent under live providers.
   */
  replayDate?: string;
  /**
   * Alpaca-only: which market-data feed the live WS is currently using
   * ('iex' free / 'sip' paid). Drives the feed indicator on the TopBar so
   * the UI reflects the actual active feed even after a runtime switch
   * (or an automatic fallback from SIP→IEX). Absent under non-Alpaca
   * providers.
   */
  feed?: AlpacaFeed;
}

/**
 * Response from POST /api/live-feed. `fellBack: true` means the requested
 * feed could not be established and the server reverted to `feed`.
 */
export interface LiveFeedResponse {
  feed: AlpacaFeed;
  fellBack: boolean;
  reason?: string;
}
