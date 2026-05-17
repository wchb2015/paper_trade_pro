import { TradeTicket } from "./TradeTicket";
import { NewAlertModal } from "./NewAlertModal";
import { AddStockModal } from "./AddStockModal";
import type { AlertCtx, Market, Portfolio, TradeCtx } from "../lib/types";
import type { UsePortfolioResult } from "../hooks/usePortfolio";

interface ModalStackProps {
  market: Market;
  portfolio: Portfolio;
  tradeCtx: TradeCtx | null;
  alertCtx: AlertCtx | null;
  addOpen: boolean;
  setTradeCtx: (ctx: TradeCtx | null) => void;
  setAlertCtx: (ctx: AlertCtx | null) => void;
  setAddOpen: (open: boolean) => void;
  placeOrder: UsePortfolioResult["placeOrder"];
  addAlert: UsePortfolioResult["addAlert"];
  toggleWatch: UsePortfolioResult["toggleWatch"];
}

export function ModalStack({
  market,
  portfolio,
  tradeCtx,
  alertCtx,
  addOpen,
  setTradeCtx,
  setAlertCtx,
  setAddOpen,
  placeOrder,
  addAlert,
  toggleWatch,
}: ModalStackProps) {
  return (
    <>
      {tradeCtx && (
        <TradeTicket
          open={!!tradeCtx}
          onClose={() => setTradeCtx(null)}
          ticker={tradeCtx.ticker}
          initialSide={tradeCtx.side}
          market={market}
          portfolio={portfolio}
          placeOrder={placeOrder}
        />
      )}
      {alertCtx && (
        <NewAlertModal
          open={!!alertCtx}
          onClose={() => setAlertCtx(null)}
          ticker={alertCtx.ticker}
          market={market}
          addAlert={addAlert}
        />
      )}
      {addOpen && (
        <AddStockModal
          open={addOpen}
          onClose={() => setAddOpen(false)}
          onAdd={(t) => toggleWatch(t)}
          existing={portfolio.watchlist}
        />
      )}
    </>
  );
}
