import { PortfolioPage } from "../pages/PortfolioPage";
import { WatchlistPage } from "../pages/WatchlistPage";
import { TradePage } from "../pages/TradePage";
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
        <PortfolioPage
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
          setAlertCtx={setAlertCtx}
        />
      );
    case "trade":
      return (
        <TradePage
          ticker={activeTradeTicker}
          market={market}
          portfolio={portfolio}
          toggleWatch={toggleWatch}
          setTradeCtx={setTradeCtx}
          setAlertCtx={setAlertCtx}
          cancelOrder={cancelOrder}
          removeAlert={removeAlert}
          onNavigate={onNavigate}
          liveFeed={liveFeed}
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
