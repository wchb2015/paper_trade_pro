import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Alert,
  Market,
  Order,
  Portfolio,
  Position,
  Valuation,
} from '../lib/types';

export const INITIAL_CASH = 100_000;
const STORAGE_KEY = 'ptp_portfolio_v1';

function defaultPortfolio(cash = INITIAL_CASH): Portfolio {
  return {
    cash,
    initialCash: cash,
    positions: [],
    orders: [],
    alerts: [],
    watchlist: ['AAPL', 'NVDA', 'TSLA', 'AMZN', 'COIN'],
    history: [],
  };
}

function loadPortfolio(): Portfolio | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Portfolio;
  } catch {
    return null;
  }
}

function savePortfolio(p: Portfolio) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* ignore quota / privacy */
  }
}

// Apply a filled order to portfolio state (cash + positions + history)
function fillOrder(p: Portfolio, order: Order): Portfolio {
  const { ticker, side, qty } = order;
  const fillPrice = order.fillPrice ?? 0;
  let positions: Position[] = [...p.positions];
  let cash = p.cash;

  const matchingSide =
    side === 'buy' || side === 'sell' ? 'long' : 'short';
  const existing = positions.find(
    (x) => x.ticker === ticker && x.side === matchingSide,
  );

  if (side === 'buy') {
    cash -= qty * fillPrice;
    if (existing && existing.side === 'long') {
      const total = existing.qty + qty;
      const avg =
        (existing.qty * existing.avgPrice + qty * fillPrice) / total;
      positions = positions.map((x) =>
        x === existing ? { ...x, qty: total, avgPrice: +avg.toFixed(4) } : x,
      );
    } else {
      positions.push({
        id: `pos_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        ticker,
        side: 'long',
        qty,
        avgPrice: fillPrice,
        openedAt: Date.now(),
      });
    }
  } else if (side === 'sell') {
    const longPos = positions.find(
      (x) => x.ticker === ticker && x.side === 'long',
    );
    if (longPos) {
      const closeQty = Math.min(qty, longPos.qty);
      cash += closeQty * fillPrice;
      const remaining = longPos.qty - closeQty;
      positions = positions
        .map((x) => (x === longPos ? { ...x, qty: remaining } : x))
        .filter((x) => x.qty > 0);
    }
  } else if (side === 'short') {
    cash += qty * fillPrice;
    if (existing && existing.side === 'short') {
      const total = existing.qty + qty;
      const avg =
        (existing.qty * existing.avgPrice + qty * fillPrice) / total;
      positions = positions.map((x) =>
        x === existing ? { ...x, qty: total, avgPrice: +avg.toFixed(4) } : x,
      );
    } else {
      positions.push({
        id: `pos_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        ticker,
        side: 'short',
        qty,
        avgPrice: fillPrice,
        openedAt: Date.now(),
      });
    }
  } else if (side === 'cover') {
    const shortPos = positions.find(
      (x) => x.ticker === ticker && x.side === 'short',
    );
    if (shortPos) {
      const closeQty = Math.min(qty, shortPos.qty);
      cash -= closeQty * fillPrice;
      const remaining = shortPos.qty - closeQty;
      positions = positions
        .map((x) => (x === shortPos ? { ...x, qty: remaining } : x))
        .filter((x) => x.qty > 0);
    }
  }

  const filled: Order = {
    ...order,
    status: 'filled',
    filledAt: Date.now(),
    fillPrice,
  };

  return {
    ...p,
    cash: +cash.toFixed(2),
    positions,
    orders: p.orders.map((o) => (o.id === order.id ? filled : o)),
    history: [filled, ...p.history].slice(0, 200),
  };
}

export type PlaceOrderInput = Omit<
  Order,
  'id' | 'status' | 'createdAt' | 'fillPrice' | 'filledAt' | 'cancelledAt'
>;

export interface UsePortfolioResult {
  portfolio: Portfolio;
  valuation: Valuation;
  placeOrder: (order: PlaceOrderInput) => void;
  cancelOrder: (id: string) => void;
  resetFunds: (amount?: number) => void;
  toggleWatch: (ticker: string) => void;
  addAlert: (alert: Omit<Alert, 'id' | 'active' | 'createdAt'>) => void;
  removeAlert: (id: string) => void;
  toggleAlert: (id: string) => void;
}

export function usePortfolio(market: Market): UsePortfolioResult {
  const [portfolio, setPortfolio] = useState<Portfolio>(
    () => loadPortfolio() ?? defaultPortfolio(),
  );

  useEffect(() => {
    savePortfolio(portfolio);
  }, [portfolio]);

  // Live valuations
  const valuation = useMemo<Valuation>(() => {
    let marketValue = 0;
    let unrealizedPnL = 0;
    portfolio.positions.forEach((p) => {
      const m = market[p.ticker];
      if (!m) return;
      if (p.side === 'long') {
        marketValue += m.price * p.qty;
        unrealizedPnL += (m.price - p.avgPrice) * p.qty;
      } else {
        marketValue += p.avgPrice * p.qty; // collateral value
        unrealizedPnL += (p.avgPrice - m.price) * p.qty;
      }
    });
    const shortDiff = portfolio.positions
      .filter((p) => p.side === 'short')
      .reduce((s, p) => {
        const m = market[p.ticker];
        if (!m) return s;
        return s + (p.avgPrice - m.price) * p.qty;
      }, 0);
    const equity = portfolio.cash + marketValue + shortDiff;
    const totalPnL = equity - portfolio.initialCash;
    const dayPnL = unrealizedPnL; // simplified
    return { marketValue, unrealizedPnL, equity, totalPnL, dayPnL };
  }, [portfolio.positions, portfolio.cash, portfolio.initialCash, market]);

  const placeOrder = useCallback(
    (order: PlaceOrderInput) => {
      setPortfolio((p) => {
        const id = `ord_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const newOrder: Order = {
          ...order,
          id,
          status: order.type === 'market' ? 'pending_fill' : 'pending',
          createdAt: Date.now(),
        };
        // Market order fills immediately at current price
        if (order.type === 'market') {
          const m = market[order.ticker];
          if (!m) return p;
          const fillPrice =
            order.side === 'buy' || order.side === 'cover' ? m.ask : m.bid;
          return fillOrder(
            { ...p, orders: [newOrder, ...p.orders] },
            { ...newOrder, fillPrice },
          );
        }
        return { ...p, orders: [newOrder, ...p.orders] };
      });
    },
    [market],
  );

  const cancelOrder = useCallback((id: string) => {
    setPortfolio((p) => ({
      ...p,
      orders: p.orders.map((o) =>
        o.id === id ? { ...o, status: 'cancelled', cancelledAt: Date.now() } : o,
      ),
    }));
  }, []);

  const resetFunds = useCallback((amount: number = INITIAL_CASH) => {
    setPortfolio(defaultPortfolio(amount));
  }, []);

  const toggleWatch = useCallback((ticker: string) => {
    setPortfolio((p) => ({
      ...p,
      watchlist: p.watchlist.includes(ticker)
        ? p.watchlist.filter((t) => t !== ticker)
        : [...p.watchlist, ticker],
    }));
  }, []);

  const addAlert = useCallback(
    (alert: Omit<Alert, 'id' | 'active' | 'createdAt'>) => {
      setPortfolio((p) => ({
        ...p,
        alerts: [
          {
            id: `alt_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            active: true,
            createdAt: Date.now(),
            ...alert,
          },
          ...p.alerts,
        ],
      }));
    },
    [],
  );

  const removeAlert = useCallback((id: string) => {
    setPortfolio((p) => ({
      ...p,
      alerts: p.alerts.filter((a) => a.id !== id),
    }));
  }, []);

  const toggleAlert = useCallback((id: string) => {
    setPortfolio((p) => ({
      ...p,
      alerts: p.alerts.map((a) =>
        a.id === id ? { ...a, active: !a.active } : a,
      ),
    }));
  }, []);

  // Evaluate open orders + alerts against live market on every tick
  useEffect(() => {
    setPortfolio((p) => {
      let changed = false;
      let next: Portfolio = p;

      for (const order of p.orders) {
        if (order.status !== 'pending' && order.status !== 'pending_fill')
          continue;
        const m = market[order.ticker];
        if (!m) continue;

        let trigger: number | null = null;

        if (order.type === 'limit') {
          if (
            order.side === 'buy' &&
            order.limitPrice != null &&
            m.ask <= order.limitPrice
          )
            trigger = order.limitPrice;
          if (
            order.side === 'sell' &&
            order.limitPrice != null &&
            m.bid >= order.limitPrice
          )
            trigger = order.limitPrice;
        } else if (order.type === 'stop') {
          if (
            order.side === 'sell' &&
            order.stopPrice != null &&
            m.price <= order.stopPrice
          )
            trigger = m.bid;
          if (
            order.side === 'buy' &&
            order.stopPrice != null &&
            m.price >= order.stopPrice
          )
            trigger = m.ask;
        } else if (order.type === 'stop_limit') {
          if (
            order.side === 'sell' &&
            order.stopPrice != null &&
            order.limitPrice != null &&
            m.price <= order.stopPrice
          )
            trigger = order.limitPrice;
          if (
            order.side === 'buy' &&
            order.stopPrice != null &&
            order.limitPrice != null &&
            m.price >= order.stopPrice
          )
            trigger = order.limitPrice;
        } else if (order.type === 'trailing_stop' && order.trailPct != null) {
          const peak = order.peak ?? m.price;
          const newPeak =
            order.side === 'sell'
              ? Math.max(peak, m.price)
              : Math.min(peak, m.price);
          const stopLevel =
            order.side === 'sell'
              ? newPeak * (1 - order.trailPct / 100)
              : newPeak * (1 + order.trailPct / 100);
          if (order.side === 'sell' && m.price <= stopLevel) trigger = m.bid;
          if (order.side === 'buy' && m.price >= stopLevel) trigger = m.ask;
          if (trigger == null && newPeak !== peak) {
            next = {
              ...next,
              orders: next.orders.map((o) =>
                o.id === order.id ? { ...o, peak: newPeak } : o,
              ),
            };
            changed = true;
          }
        } else if (order.type === 'conditional' && order.condTrigger) {
          const cond = order.condTrigger;
          const cm = market[cond.ticker];
          if (cm) {
            const hit =
              cond.op === '>='
                ? cm.price >= cond.price
                : cm.price <= cond.price;
            if (hit) trigger = order.side === 'buy' || order.side === 'cover' ? m.ask : m.bid;
          }
        }

        if (trigger != null) {
          next = fillOrder(next, { ...order, fillPrice: trigger });
          changed = true;
        }
      }

      // Evaluate alerts
      for (const a of p.alerts) {
        if (!a.active || a.triggeredAt) continue;
        const m = market[a.ticker];
        if (!m) continue;
        const hit = a.condition === 'above' ? m.price >= a.price : m.price <= a.price;
        if (hit) {
          next = {
            ...next,
            alerts: next.alerts.map((x) =>
              x.id === a.id
                ? { ...x, triggeredAt: Date.now(), triggeredPrice: m.price }
                : x,
            ),
          };
          changed = true;
        }
      }

      return changed ? next : p;
    });
  }, [market]);

  return {
    portfolio,
    valuation,
    placeOrder,
    cancelOrder,
    resetFunds,
    toggleWatch,
    addAlert,
    removeAlert,
    toggleAlert,
  };
}
