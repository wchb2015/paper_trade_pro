// -----------------------------------------------------------------------------
// Frontend-local types. Domain types (Portfolio, Order, Alert, etc.) live in
// shared/ and are re-exported here so existing imports keep working.
// This file holds only UI-scoped types: view-models, page keys, modal ctx,
// and theme/tweak preferences.
// -----------------------------------------------------------------------------

export type {
  AlertCondition,
  OrderSide,
  OrderType,
  TimeInForce,
  Alert,
  Order,
  Portfolio,
  AddAlertInput,
  PlaceOrderInput,
} from '../../../shared/src';

/**
 * Freshness of a quote as observed by the frontend:
 *   loading  — request pending; no value yet
 *   live     — tick seen within STALE_AFTER_MS
 *   stale    — had a tick but nothing recent
 *   error    — last fetch failed
 */
export type PriceFreshness = 'loading' | 'live' | 'stale' | 'error';

/**
 * A ticker's view-model. Metadata (name/sector) is display-only and
 * comes from STOCK_META; the rest is sourced from the backend provider.
 *
 * Fields that the provider may not supply are null — the UI renders "—".
 */
export interface StockSnapshot {
  ticker: string;
  name: string;
  sector: string;
  price: number;
  /** Last tick before the current one; drives flash-on-change. */
  prev: number;
  /** Rolling history built from live ticks for the sparkline. */
  history: number[];
  bid: number | null;
  ask: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  prevClose: number | null;
  volume: number | null;
  /** Epoch ms of the latest update. */
  lastUpdated: number;
  freshness: PriceFreshness;
}

export type Market = Record<string, StockSnapshot>;

export interface Valuation {
  marketValue: number;
  unrealizedPnL: number;
  equity: number;
  totalPnL: number;
  dayPnL: number;
}

export type PageKey =
  | 'dashboard'
  | 'watchlist'
  | 'detail'
  | 'positions'
  | 'orders'
  | 'alerts'
  | 'account';

export interface TradeCtx {
  ticker: string;
  side: import('../../../shared/src').OrderSide;
}

export interface AlertCtx {
  ticker: string;
}

export interface Tweaks {
  accent: string;
  gainColor: string;
  lossColor: string;
}

export type Theme = 'light' | 'dark';
