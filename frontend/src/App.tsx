import { useEffect, useState } from "react";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { TweaksPanel } from "./components/TweaksPanel";
import { PageRouter } from "./components/PageRouter";
import { ModalStack } from "./components/ModalStack";
import { useMarket } from "./hooks/useMarket";
import { useReplayClock } from "./hooks/useReplayClock";
import { usePortfolio } from "./hooks/usePortfolio";
import { usePersistedState } from "./hooks/usePersistedState";
import { useLiveValuation } from "./hooks/useLiveValuation";
import { useInterestingSymbols } from "./hooks/useInterestingSymbols";
import { useThemeStyles } from "./hooks/useThemeStyles";
import type {
  AlertCtx,
  Market,
  PageKey,
  Theme,
  TradeCtx,
  Tweaks,
} from "./lib/types";

const TWEAK_DEFAULTS: Tweaks = {
  accent: "#4f46e5",
  gainColor: "#059669",
  lossColor: "#e11d48",
};

export default function App() {
  const [theme, setTheme] = usePersistedState<Theme>("ptp_theme", "light");
  const [page, setPage] = usePersistedState<PageKey>("ptp_page", "dashboard");
  const [detailTicker, setDetailTicker] = usePersistedState<string>(
    "ptp_detail",
    "AAPL",
  );
  const [tradeCtx, setTradeCtx] = useState<TradeCtx | null>(null);
  const [alertCtx, setAlertCtx] = useState<AlertCtx | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [tweaks, setTweaks] = useState<Tweaks>(TWEAK_DEFAULTS);

  // ---- portfolio <-> market wiring ----------------------------------------
  // usePortfolio needs the live Market so placeOrder can fill at ask/bid and
  // the order/alert evaluator can trigger against real prices. But useMarket
  // (below) depends on portfolio state to know which symbols to subscribe to,
  // which would be circular.
  //
  // We break the cycle with a mirrored Market state: usePortfolio consumes
  // `marketView`, useMarket returns the live `market`, and an effect further
  // down copies `market` → `marketView` on every update. One extra render per
  // tick; placeOrder always sees fresh data.
  // -----------------------------------------------------------------------
  const [marketView, setMarketView] = useState<Market>({});
  const {
    portfolio,
    valuation,
    placeOrder,
    cancelOrder,
    resetFunds,
    toggleWatch,
    addAlert,
    removeAlert,
    toggleAlert,
    loaded: portfolioLoaded,
  } = usePortfolio(marketView);

  const interestingSymbols = useInterestingSymbols({
    portfolio,
    portfolioLoaded,
    page,
    detailTicker,
    tradeCtx,
    alertCtx,
  });

  const {
    market,
    unavailable,
    liveConnected,
    providerStatus,
    provider,
    error,
    replayClock,
    replayDate,
  } = useMarket(interestingSymbols);
  const replaySimMs = useReplayClock(replayClock);

  // Mirror the live market into `marketView` so usePortfolio sees fresh data.
  // This is the second half of the cycle-break described above.
  useEffect(() => {
    setMarketView(market);
  }, [market]);

  useThemeStyles(theme, tweaks);

  const onNavigate = (p: PageKey, ticker?: string) => {
    if (ticker) setDetailTicker(ticker);
    setPage(p);
  };

  const activeAlerts = portfolio.alerts.filter(
    (a) => a.active && !a.triggeredAt,
  ).length;
  const workingOrders = portfolio.orders.filter(
    (o) => o.status === "pending" || o.status === "pending_fill",
  ).length;

  const effectiveValuation = useLiveValuation(market, portfolio, valuation);

  const totalValue = effectiveValuation.equity;
  const totalPct =
    portfolio.initialCash === 0
      ? 0
      : ((totalValue - portfolio.initialCash) / portfolio.initialCash) * 100;

  return (
    <div className="app">
      <TopBar
        totalValue={totalValue}
        totalPct={totalPct}
        cash={portfolio.cash}
        theme={theme}
        setTheme={setTheme}
        onOpenTweaks={() => setTweaksOpen((v) => !v)}
        onOpenAccount={() => onNavigate("account")}
        liveConnected={liveConnected}
        provider={provider}
        providerStatus={providerStatus}
        error={error}
        replayDate={replayDate}
        replayClock={replayClock}
        replaySimMs={replaySimMs}
      />

      <Sidebar
        page={page}
        onNavigate={onNavigate}
        portfolio={portfolio}
        workingOrders={workingOrders}
        activeAlerts={activeAlerts}
        provider={provider}
      />

      <main className="main">
        <PageRouter
          page={page}
          detailTicker={detailTicker}
          market={market}
          unavailable={unavailable}
          portfolio={portfolio}
          valuation={effectiveValuation}
          toggleWatch={toggleWatch}
          cancelOrder={cancelOrder}
          toggleAlert={toggleAlert}
          removeAlert={removeAlert}
          resetFunds={resetFunds}
          onNavigate={onNavigate}
          setTradeCtx={setTradeCtx}
          setAlertCtx={setAlertCtx}
          onAddStock={() => setAddOpen(true)}
        />
      </main>

      <ModalStack
        market={market}
        portfolio={portfolio}
        tradeCtx={tradeCtx}
        alertCtx={alertCtx}
        addOpen={addOpen}
        setTradeCtx={setTradeCtx}
        setAlertCtx={setAlertCtx}
        setAddOpen={setAddOpen}
        placeOrder={placeOrder}
        addAlert={addAlert}
        toggleWatch={toggleWatch}
      />

      {tweaksOpen && (
        <TweaksPanel
          tweaks={tweaks}
          setTweaks={setTweaks}
          theme={theme}
          setTheme={setTheme}
          onClose={() => setTweaksOpen(false)}
        />
      )}
    </div>
  );
}
