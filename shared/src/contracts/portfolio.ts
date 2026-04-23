// -----------------------------------------------------------------------------
// Portfolio domain contracts — shared by the backend (Postgres-backed store,
// REST routes) and the frontend (usePortfolio hook, UI code).
//
// Value-spaces for the string unions (OrderType, OrderStatus, etc.) are the
// single source of truth. The database stores them as free-form TEXT; every
// write goes through a route handler that validates against these unions.
// -----------------------------------------------------------------------------

export type OrderType =
  | 'market'
  | 'limit'
  | 'stop'
  | 'stop_limit'
  | 'trailing_stop'
  | 'conditional';

export type OrderSide = 'buy' | 'sell' | 'short' | 'cover';

export type OrderStatus =
  | 'pending'
  | 'pending_fill'
  | 'filled'
  | 'cancelled';

export type PositionSide = 'long' | 'short';

export type AlertCondition = 'above' | 'below';

export type TimeInForce = 'day' | 'gtc' | 'ioc';

export type ConditionalOp = '>=' | '<=';

// Runtime guards — used at route boundaries to validate inbound JSON before
// it hits the database. Keep in sync with the unions above.
export const ORDER_TYPES: readonly OrderType[] = [
  'market',
  'limit',
  'stop',
  'stop_limit',
  'trailing_stop',
  'conditional',
] as const;

export const ORDER_SIDES: readonly OrderSide[] = [
  'buy',
  'sell',
  'short',
  'cover',
] as const;

export const ORDER_STATUSES: readonly OrderStatus[] = [
  'pending',
  'pending_fill',
  'filled',
  'cancelled',
] as const;

export const POSITION_SIDES: readonly PositionSide[] = ['long', 'short'] as const;

export const TIMES_IN_FORCE: readonly TimeInForce[] = ['day', 'gtc', 'ioc'] as const;

export const ALERT_CONDITIONS: readonly AlertCondition[] = ['above', 'below'] as const;

export const CONDITIONAL_OPS: readonly ConditionalOp[] = ['>=', '<='] as const;

export function isOrderType(v: unknown): v is OrderType {
  return typeof v === 'string' && (ORDER_TYPES as readonly string[]).includes(v);
}
export function isOrderSide(v: unknown): v is OrderSide {
  return typeof v === 'string' && (ORDER_SIDES as readonly string[]).includes(v);
}
export function isTimeInForce(v: unknown): v is TimeInForce {
  return typeof v === 'string' && (TIMES_IN_FORCE as readonly string[]).includes(v);
}
export function isAlertCondition(v: unknown): v is AlertCondition {
  return typeof v === 'string' && (ALERT_CONDITIONS as readonly string[]).includes(v);
}
export function isConditionalOp(v: unknown): v is ConditionalOp {
  return typeof v === 'string' && (CONDITIONAL_OPS as readonly string[]).includes(v);
}

// -----------------------------------------------------------------------------
// Domain objects. Timestamps are epoch-milliseconds (number) over the wire so
// the frontend can keep using Date.now()-style math without changes; the
// backend converts to/from timestamptz at the SQL boundary.
// -----------------------------------------------------------------------------

export interface ConditionalTrigger {
  ticker: string;
  op: ConditionalOp;
  price: number;
}

export interface Order {
  id: string;
  ticker: string;
  side: OrderSide;
  type: OrderType;
  qty: number;
  tif: TimeInForce;
  status: OrderStatus;
  createdAt: number;
  limitPrice?: number;
  stopPrice?: number;
  trailPct?: number;
  peak?: number;
  condTrigger?: ConditionalTrigger;
  innerType?: OrderType;
  filledAt?: number;
  cancelledAt?: number;
  fillPrice?: number;
}

export interface Position {
  id: string;
  ticker: string;
  side: PositionSide;
  qty: number;
  avgPrice: number;
  openedAt: number;
}

export interface Alert {
  id: string;
  ticker: string;
  condition: AlertCondition;
  price: number;
  active: boolean;
  note?: string;
  createdAt: number;
  triggeredAt?: number;
  triggeredPrice?: number;
}

export interface Portfolio {
  cash: number;
  initialCash: number;
  positions: Position[];
  orders: Order[];
  alerts: Alert[];
  watchlist: string[];
  /** Filled/cancelled orders, newest first. */
  history: Order[];
}

// -----------------------------------------------------------------------------
// REST request shapes. Responses are just Portfolio (everything returns the
// whole thing so the client can replace state atomically).
// -----------------------------------------------------------------------------

export interface PlaceOrderInput {
  ticker: string;
  side: OrderSide;
  type: OrderType;
  qty: number;
  tif: TimeInForce;
  limitPrice?: number;
  stopPrice?: number;
  trailPct?: number;
  condTrigger?: ConditionalTrigger;
  innerType?: OrderType;
  /** Required for market orders — client-computed from current ask/bid. */
  fillPrice?: number;
}

export interface FillOrderInput {
  fillPrice: number;
}

export interface UpdatePeakInput {
  peak: number;
}

export interface AddAlertInput {
  ticker: string;
  condition: AlertCondition;
  price: number;
  note?: string;
}

export interface TriggerAlertInput {
  price: number;
}

export interface ToggleWatchInput {
  ticker: string;
}

export interface ResetFundsInput {
  cash?: number;
}
