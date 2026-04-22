// Shared types for Paper Trade Pro

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

export interface SeedStock {
  ticker: string;
  name: string;
  sector: string;
  price: number;
  vol: number;
  mcap: string;
}

export interface StockSnapshot extends SeedStock {
  prev: number;
  history: number[];
  bid: number;
  ask: number;
  dayHigh: number;
  dayLow: number;
  dayOpen: number;
}

export type Market = Record<string, StockSnapshot>;

export interface ConditionalTrigger {
  ticker: string;
  op: '>=' | '<=';
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
  history: Order[];
}

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
  side: OrderSide;
}

export interface AlertCtx {
  ticker: string;
}

export interface Tweaks {
  accent: string;
  density: 'comfortable' | 'compact';
  gainColor: string;
  lossColor: string;
}

export type Theme = 'light' | 'dark';
