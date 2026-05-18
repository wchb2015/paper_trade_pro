import { DashboardPage } from "../pages/DashboardPage";
import { WatchlistPage } from "../pages/WatchlistPage";
import { DetailPage } from "../pages/DetailPage";
import { PositionsPage } from "../pages/PositionsPage";
import { OrdersPage } from "../pages/OrdersPage";
import { AlertsPage } from "../pages/AlertsPage";
import { AccountPage } from "../pages/AccountPage";
import type {
  AlertCtx,
  Market,
  PageKey,
  Portfolio,
  TradeCtx,
  Valuation,
} from "../lib/types";
import type { UnavailableReason } from "../../../shared/src";
import type { UsePortfolioResult } from "../hooks/usePortfolio";

interface PageRouterProps {
  page: PageKey;
  activeTradeTicker: string;
  market: Market;
  unavailable: Record<string, UnavailableReason>;
  portfolio: Portfolio;
  valuation: Valuation;
  toggleWatch: UsePortfolioResult["toggleWatch"];
  cancelOrder: UsePortfolioResult["cancelOrder"];
  toggleAlert: UsePortfolioResult["toggleAlert"];
  removeAlert: UsePortfolioResult["removeAlert"];
  resetFunds: UsePortfolioResult["resetFunds"];
  onNavigate: (p: PageKey, ticker?: string) => void;
  setTradeCtx: (ctx: TradeCtx | null) => void;
  setAlertCtx: (ctx: AlertCtx | null) => void;
  onAddStock: () => void;
  liveFeed: "iex" | "sip" | null;
}

export function PageRouter(props: PageRouterProps) {
  const {
    page,
    activeTradeTicker,
    market,
    unavailable,
    portfolio,
    valuation,
    toggleWatch,
    cancelOrder,
    toggleAlert,
    removeAlert,
    resetFunds,
    onNavigate,
    setTradeCtx,
    setAlertCtx,
    onAddStock,
    liveFeed,
  } = props;

  switch (page) {
    case "portfolio":
      return (
        <DashboardPage
          market={market}
          portfolio={portfolio}
          valuation={valuation}
          onNavigate={onNavigate}
          setTradeCtx={setTradeCtx}
        />
      );
    case "watchlist":
      return (
        <WatchlistPage
          market={market}
          unavailable={unavailable}
          portfolio={portfolio}
          toggleWatch={toggleWatch}
          onNavigate={onNavigate}
          onAdd={onAddStock}
          setTradeCtx={setTradeCtx}
        />
      );
    case "trade":
      return (
        <DetailPage
          ticker={activeTradeTicker}
          market={market}
          portfolio={portfolio}
          toggleWatch={toggleWatch}
          setTradeCtx={setTradeCtx}
          setAlertCtx={setAlertCtx}
          onNavigate={onNavigate}
          liveFeed={liveFeed}
        />
      );
    case "positions":
      return (
        <PositionsPage
          market={market}
          portfolio={portfolio}
          valuation={valuation}
          setTradeCtx={setTradeCtx}
        />
      );
    case "orders":
      return (
        <OrdersPage
          market={market}
          portfolio={portfolio}
          cancelOrder={cancelOrder}
        />
      );
    case "alerts":
      return (
        <AlertsPage
          market={market}
          portfolio={portfolio}
          toggleAlert={toggleAlert}
          removeAlert={removeAlert}
          onAdd={() => setAlertCtx({ ticker: activeTradeTicker || "AAPL" })}
        />
      );
    case "account":
      return (
        <AccountPage
          portfolio={portfolio}
          valuation={valuation}
          resetFunds={resetFunds}
        />
      );
    default:
      return null;
  }
}
