import { useMemo } from "react";
import type { AlertCtx, PageKey, Portfolio, TradeCtx } from "../lib/types";

/**
 * Build the union of symbols the backend should stream quotes for: watchlist
 * + position tickers + working-order tickers + alert tickers + whatever the
 * current page/modals are looking at.
 *
 * Held back to [] until `portfolioLoaded`; otherwise we'd fire one
 * POST /api/subscriptions with the empty set on first render and immediately
 * fire it again with the real set.
 */
export function useInterestingSymbols(args: {
  portfolio: Portfolio;
  portfolioLoaded: boolean;
  page: PageKey;
  detailTicker: string;
  tradeCtx: TradeCtx | null;
  alertCtx: AlertCtx | null;
}): string[] {
  const {
    portfolio,
    portfolioLoaded,
    page,
    detailTicker,
    tradeCtx,
    alertCtx,
  } = args;

  return useMemo(() => {
    if (!portfolioLoaded) return [];
    const set = new Set<string>();
    portfolio.watchlist.forEach((t) => set.add(t));
    portfolio.positions.forEach((p) => set.add(p.ticker));
    portfolio.orders.forEach((o) => set.add(o.ticker));
    portfolio.alerts.forEach((a) => set.add(a.ticker));
    if (page === "detail" && detailTicker) set.add(detailTicker);
    if (tradeCtx?.ticker) set.add(tradeCtx.ticker);
    if (alertCtx?.ticker) set.add(alertCtx.ticker);
    return Array.from(set).map((s) => s.toUpperCase());
  }, [
    portfolioLoaded,
    portfolio.watchlist,
    portfolio.positions,
    portfolio.orders,
    portfolio.alerts,
    page,
    detailTicker,
    tradeCtx?.ticker,
    alertCtx?.ticker,
  ]);
}
