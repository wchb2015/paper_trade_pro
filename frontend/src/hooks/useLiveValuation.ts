import { useMemo } from "react";
import type { Market, Portfolio, Valuation } from "../lib/types";

/**
 * Reconcile portfolio valuation against the live market. Returns the live
 * valuation when at least one position has a quote (or there are no positions
 * at all); falls back to the precomputed `fallback` from usePortfolio while
 * the market is still warming up to avoid flashing a $0 equity.
 */
export function useLiveValuation(
  market: Market,
  portfolio: Portfolio,
  fallback: Valuation,
): Valuation {
  const live = useMemo<Valuation>(() => {
    let marketValue = 0;
    let unrealizedPnL = 0;
    portfolio.positions.forEach((p) => {
      const m = market[p.ticker];
      if (!m) return;
      if (p.side === "long") {
        marketValue += m.price * p.qty;
        unrealizedPnL += (m.price - p.avgPrice) * p.qty;
      } else {
        marketValue += p.avgPrice * p.qty;
        unrealizedPnL += (p.avgPrice - m.price) * p.qty;
      }
    });
    const shortDiff = portfolio.positions
      .filter((p) => p.side === "short")
      .reduce((s, p) => {
        const m = market[p.ticker];
        if (!m) return s;
        return s + (p.avgPrice - m.price) * p.qty;
      }, 0);
    const equity = portfolio.cash + marketValue + shortDiff;
    const totalPnL = equity - portfolio.initialCash;
    return {
      marketValue,
      unrealizedPnL,
      equity,
      totalPnL,
      dayPnL: unrealizedPnL,
    };
  }, [market, portfolio.positions, portfolio.cash, portfolio.initialCash]);

  return live.marketValue > 0 || portfolio.positions.length === 0
    ? live
    : fallback;
}
