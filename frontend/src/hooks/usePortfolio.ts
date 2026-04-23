import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AddAlertInput,
  Market,
  PlaceOrderInput as SharedPlaceOrderInput,
  Portfolio,
  Valuation,
} from '../lib/types';
import { askOrPrice, bidOrPrice } from '../lib/quote';
import { portfolioClient } from '../lib/portfolioClient';

// -----------------------------------------------------------------------------
// usePortfolio — the single surface UI code uses for positions, orders,
// alerts, and the watchlist. Server-authoritative: every mutation is a REST
// call and the response Portfolio replaces local state atomically.
//
// The hook also runs a per-tick evaluator that watches working orders + live
// alerts against the market and fires /fill, /trigger, etc. when a condition
// crosses. Double-firing is prevented with a small `inFlight` set.
// -----------------------------------------------------------------------------

/** Client-visible cash fallback before the first /portfolio response. */
export const INITIAL_CASH = 100_000;

/**
 * What callers of `placeOrder` need to supply. `fillPrice` is filled in by
 * the hook for market orders from the current market, so callers (the
 * trade ticket) don't have to look up ask/bid themselves.
 */
export type PlaceOrderInput = Omit<SharedPlaceOrderInput, 'fillPrice'>;

export interface UsePortfolioResult {
  portfolio: Portfolio;
  valuation: Valuation;
  placeOrder: (order: PlaceOrderInput) => void;
  cancelOrder: (id: string) => void;
  resetFunds: (amount?: number) => void;
  toggleWatch: (ticker: string) => void;
  addAlert: (alert: AddAlertInput) => void;
  removeAlert: (id: string) => void;
  toggleAlert: (id: string) => void;
  /** True once the initial GET /api/portfolio has resolved. */
  loaded: boolean;
  /** Last server error message (if any). Cleared on next successful call. */
  error: string | null;
}

// Placeholder portfolio shown between hook mount and the first server
// response. Keeps UI code from handling undefined everywhere.
const emptyPortfolio: Portfolio = {
  cash: INITIAL_CASH,
  initialCash: INITIAL_CASH,
  positions: [],
  orders: [],
  alerts: [],
  watchlist: [],
  history: [],
};

export function usePortfolio(market: Market): UsePortfolioResult {
  const [portfolio, setPortfolio] = useState<Portfolio>(emptyPortfolio);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guard against redundant calls for the same id while one is in flight.
  // Keyed by order id (for fill/cancel) or alert id (for trigger).
  const inFlight = useRef<Set<string>>(new Set());
  const mounted = useRef(true);

  // Local trailing-stop peaks. We deliberately don't persist these on every
  // tick — re-seeding from the server's stored `peak` on reload is close
  // enough for a paper-trading sim and spares us a POST per tick.
  const localPeaks = useRef<Map<string, number>>(new Map());

  const handleError = useCallback((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (mounted.current) setError(msg);
    console.error('[portfolio]', msg);
  }, []);

  const applyPortfolio = useCallback((p: Portfolio) => {
    if (!mounted.current) return;
    setPortfolio(p);
    setError(null);
  }, []);

  // Initial load.
  useEffect(() => {
    mounted.current = true;
    portfolioClient
      .get()
      .then((p) => {
        applyPortfolio(p);
        setLoaded(true);
      })
      .catch(handleError);
    return () => {
      mounted.current = false;
    };
  }, [applyPortfolio, handleError]);

  // ---- valuation (same math as before, driven off server-provided state) --
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
        marketValue += p.avgPrice * p.qty;
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
    const dayPnL = unrealizedPnL;
    return { marketValue, unrealizedPnL, equity, totalPnL, dayPnL };
  }, [portfolio.positions, portfolio.cash, portfolio.initialCash, market]);

  // ---- mutation wrappers --------------------------------------------------

  const placeOrder = useCallback(
    (order: PlaceOrderInput) => {
      const body: SharedPlaceOrderInput = { ...order };
      // Market orders need fillPrice — take the fresh ask/bid off the
      // tick-driven market map. Non-market orders let the server sit on
      // 'pending' until the client evaluator fires a /fill.
      if (order.type === 'market') {
        const m = market[order.ticker];
        if (!m) {
          handleError(new Error(`no market data for ${order.ticker}`));
          return;
        }
        body.fillPrice =
          order.side === 'buy' || order.side === 'cover'
            ? askOrPrice(m)
            : bidOrPrice(m);
      }
      portfolioClient.placeOrder(body).then(applyPortfolio).catch(handleError);
    },
    [market, applyPortfolio, handleError],
  );

  const cancelOrder = useCallback(
    (id: string) => {
      portfolioClient.cancelOrder(id).then(applyPortfolio).catch(handleError);
    },
    [applyPortfolio, handleError],
  );

  const resetFunds = useCallback(
    (amount?: number) => {
      const body = amount != null ? { cash: amount } : {};
      portfolioClient.reset(body).then(applyPortfolio).catch(handleError);
    },
    [applyPortfolio, handleError],
  );

  const toggleWatch = useCallback(
    (ticker: string) => {
      portfolioClient
        .toggleWatch({ ticker })
        .then(applyPortfolio)
        .catch(handleError);
    },
    [applyPortfolio, handleError],
  );

  const addAlert = useCallback(
    (alert: AddAlertInput) => {
      portfolioClient.addAlert(alert).then(applyPortfolio).catch(handleError);
    },
    [applyPortfolio, handleError],
  );

  const removeAlert = useCallback(
    (id: string) => {
      portfolioClient.removeAlert(id).then(applyPortfolio).catch(handleError);
    },
    [applyPortfolio, handleError],
  );

  const toggleAlert = useCallback(
    (id: string) => {
      portfolioClient.toggleAlert(id).then(applyPortfolio).catch(handleError);
    },
    [applyPortfolio, handleError],
  );

  // ---- tick-driven evaluator ---------------------------------------------
  //
  // Walks working orders + active alerts. When a condition fires we POST
  // /fill or /trigger and dedup with `inFlight` so the next tick doesn't
  // re-fire the same id before the server replies.

  useEffect(() => {
    if (!loaded) return;

    for (const order of portfolio.orders) {
      if (order.status !== 'pending' && order.status !== 'pending_fill')
        continue;
      if (inFlight.current.has(order.id)) continue;
      const m = market[order.ticker];
      if (!m) continue;

      let trigger: number | null = null;

      if (order.type === 'limit') {
        if (
          order.side === 'buy' &&
          order.limitPrice != null &&
          askOrPrice(m) <= order.limitPrice
        )
          trigger = order.limitPrice;
        if (
          order.side === 'sell' &&
          order.limitPrice != null &&
          bidOrPrice(m) >= order.limitPrice
        )
          trigger = order.limitPrice;
      } else if (order.type === 'stop') {
        if (
          order.side === 'sell' &&
          order.stopPrice != null &&
          m.price <= order.stopPrice
        )
          trigger = bidOrPrice(m);
        if (
          order.side === 'buy' &&
          order.stopPrice != null &&
          m.price >= order.stopPrice
        )
          trigger = askOrPrice(m);
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
        const prevPeak =
          localPeaks.current.get(order.id) ?? order.peak ?? m.price;
        const newPeak =
          order.side === 'sell'
            ? Math.max(prevPeak, m.price)
            : Math.min(prevPeak, m.price);
        if (newPeak !== prevPeak) localPeaks.current.set(order.id, newPeak);
        const stopLevel =
          order.side === 'sell'
            ? newPeak * (1 - order.trailPct / 100)
            : newPeak * (1 + order.trailPct / 100);
        if (order.side === 'sell' && m.price <= stopLevel)
          trigger = bidOrPrice(m);
        if (order.side === 'buy' && m.price >= stopLevel)
          trigger = askOrPrice(m);
      } else if (order.type === 'conditional' && order.condTrigger) {
        const cond = order.condTrigger;
        const cm = market[cond.ticker];
        if (cm) {
          const hit =
            cond.op === '>='
              ? cm.price >= cond.price
              : cm.price <= cond.price;
          if (hit)
            trigger =
              order.side === 'buy' || order.side === 'cover'
                ? askOrPrice(m)
                : bidOrPrice(m);
        }
      }

      if (trigger != null) {
        const id = order.id;
        inFlight.current.add(id);
        portfolioClient
          .fillOrder(id, { fillPrice: trigger })
          .then((p) => {
            localPeaks.current.delete(id);
            applyPortfolio(p);
          })
          .catch(handleError)
          .finally(() => {
            inFlight.current.delete(id);
          });
      }
    }

    for (const a of portfolio.alerts) {
      if (!a.active || a.triggeredAt) continue;
      const fireKey = `alert:${a.id}`;
      if (inFlight.current.has(fireKey)) continue;
      const m = market[a.ticker];
      if (!m) continue;
      const hit =
        a.condition === 'above' ? m.price >= a.price : m.price <= a.price;
      if (hit) {
        inFlight.current.add(fireKey);
        portfolioClient
          .triggerAlert(a.id, { price: m.price })
          .then(applyPortfolio)
          .catch(handleError)
          .finally(() => {
            inFlight.current.delete(fireKey);
          });
      }
    }
    // Intentionally excluding `portfolio.orders`/`portfolio.alerts` from deps:
    // they change with every applyPortfolio and we only want to re-eval on
    // market ticks. We read current values off the state closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, loaded]);

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
    loaded,
    error,
  };
}
