import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Quote, UnavailableReason } from "../../../shared/src";
import { config } from "../config";
import { priceClient } from "../lib/priceClient";
import type { Market, StockSnapshot } from "../lib/types";

// -----------------------------------------------------------------------------
// useMarket: the only place the UI touches price data. Given a set of tickers
// (typically watchlist ∪ current detail ticker ∪ any trade-ticket ticker) it:
//   1. Requests an initial snapshot via REST.
//   2. Subscribes the backend's WS to those tickers.
//   3. Updates the Market map on every tick.
//   4. Periodically re-fetches snapshots to refresh bid/ask/dayHigh
//      (the tick stream only carries price).
//   5. Marks symbols as 'stale' if no tick arrives within STALE_AFTER_MS.
// -----------------------------------------------------------------------------

/**
 * Anchor for the running replay clock. The frontend extrapolates each
 * `Date.now()` render to:
 *   simNow = simTimestamp + (Date.now() - wallTimestamp) * speed
 * and re-anchors on every replay tick so drift stays bounded by tick rate.
 */
export interface ReplayClockAnchor {
  /** Simulated market time (epoch ms) at the moment of the most recent tick. */
  simTimestamp: number;
  /** Wall-clock time (Date.now()) when that tick arrived. */
  wallTimestamp: number;
  /** Playback rate; 1 = real-time, 10 = 10x, 0 = ASAP. */
  speed: number;
}

export interface UseMarketResult {
  market: Market;
  /** Symbols the backend can't price right now, with reason. Empty when none. */
  unavailable: Record<string, UnavailableReason>;
  liveConnected: boolean;
  providerStatus: "live" | "stale" | "unavailable";
  provider: string;
  /** Non-null when the latest snapshot fetch failed. */
  error: string | null;
  /**
   * Set only when the active provider is replay AND we've received at least
   * one tick. Callers extrapolate forward via `useReplayClock` (or directly
   * with the formula above) to render the running clock.
   */
  replayClock: ReplayClockAnchor | null;
  /** Replay-only: the trading date being replayed (YYYY-MM-DD, ET wall-clock). */
  replayDate: string | null;
}

function quoteToSnapshot(
  q: Quote,
  prior: StockSnapshot | undefined,
): StockSnapshot {
  const prev = prior?.price ?? q.price;
  const history = prior
    ? prior.price === q.price
      ? prior.history
      : [...prior.history, q.price].slice(-config.sparklinePoints)
    : [q.price];
  return {
    ticker: q.symbol,
    price: q.price,
    prev,
    history,
    bid: q.bid,
    ask: q.ask,
    dayOpen: q.dayOpen,
    dayHigh: q.dayHigh,
    dayLow: q.dayLow,
    prevClose: q.prevClose,
    lastUpdated: q.timestamp,
    freshness: "live",
  };
}

function applyTick(
  prior: StockSnapshot,
  price: number,
  ts: number,
): StockSnapshot {
  if (prior.price === price) {
    return { ...prior, lastUpdated: ts, freshness: "live" };
  }
  return {
    ...prior,
    prev: prior.price,
    price,
    history: [...prior.history, price].slice(-config.sparklinePoints),
    lastUpdated: ts,
    freshness: "live",
  };
}

export function useMarket(symbols: string[]): UseMarketResult {
  const [market, setMarket] = useState<Market>({});
  const [unavailable, setUnavailable] = useState<
    Record<string, UnavailableReason>
  >({});
  const [liveConnected, setLiveConnected] = useState(false);
  const [providerStatus, setProviderStatus] = useState<
    "live" | "stale" | "unavailable"
  >("unavailable");
  const [provider, setProvider] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [replaySpeed, setReplaySpeed] = useState<number | null>(null);
  const [replayDate, setReplayDate] = useState<string | null>(null);
  const [replayClock, setReplayClock] = useState<ReplayClockAnchor | null>(
    null,
  );
  // Keep speed in a ref so onTick (declared once on mount) sees the latest
  // value without needing to be re-bound on every status change.
  const replaySpeedRef = useRef<number | null>(null);
  replaySpeedRef.current = replaySpeed;

  // Stable sorted list so useEffect dependencies fire only on real changes.
  const symbolKey = useMemo(
    () =>
      Array.from(new Set(symbols.map((s) => s.toUpperCase())))
        .sort()
        .join(","),
    [symbols],
  );
  const symbolList = useMemo(
    () => (symbolKey ? symbolKey.split(",") : []),
    [symbolKey],
  );

  // Keep a ref to symbolList for the socket handlers so we don't re-subscribe
  // on every render.
  const symbolListRef = useRef<string[]>(symbolList);
  symbolListRef.current = symbolList;

  // ---- single global socket connection ---------------------------------------
  useEffect(() => {
    priceClient.connect({
      onTick: (tick) => {
        setMarket((prev) => {
          const current = prev[tick.symbol];
          if (!current) return prev;
          return {
            ...prev,
            [tick.symbol]: applyTick(current, tick.price, tick.timestamp),
          };
        });
        // Re-anchor the replay clock on every tick that carries a sim time.
        // We don't gate by symbol — the global clock advances even for
        // tickers the user isn't viewing. Use the most recent speed we got
        // from a status payload (default 1 if we somehow saw a sim tick
        // before any status).
        if (tick.simTimestamp !== undefined) {
          setReplayClock({
            simTimestamp: tick.simTimestamp,
            wallTimestamp: Date.now(),
            speed: replaySpeedRef.current ?? 1,
          });
        }
      },
      onStatus: (status) => {
        setProviderStatus(status.status);
        setProvider(status.provider);
        if (status.replaySpeed !== undefined) {
          setReplaySpeed(status.replaySpeed);
        } else {
          setReplaySpeed(null);
          setReplayClock(null);
        }
        setReplayDate(status.replayDate ?? null);
      },
      onConnectionChange: (connected) => {
        setLiveConnected(connected);
        // When the socket drops, stop extrapolating the replay clock —
        // otherwise the header keeps ticking simulated time under an
        // "Unavailable" pill, which is misleading. We re-anchor on the
        // next tick once the socket reconnects.
        if (!connected) {
          setReplayClock(null);
          setReplaySpeed(null);
          setReplayDate(null);
        }
      },
    });
    return () => {
      // Keep the client alive across hot-reloads / StrictMode double-mounts.
      // We intentionally don't disconnect here.
    };
  }, []);

  // ---- initial snapshot + subscription -----------------------------------
  const loadSnapshots = useCallback(async (): Promise<void> => {
    if (symbolList.length === 0) {
      setMarket({});
      setUnavailable({});
      return;
    }
    try {
      setError(null);
      const response = await priceClient.fetchQuotes(symbolList);
      setProvider(response.provider);
      setProviderStatus(response.providerStatus);

      setMarket((prev) => {
        const next: Market = {};
        for (const sym of symbolList) {
          const q = response.quotes[sym];
          if (q) {
            next[sym] = quoteToSnapshot(q, prev[sym]);
          } else if (prev[sym]) {
            // Keep what we had — provider didn't return this symbol (e.g. an
            // invalid ticker the user typed). Mark stale so the UI can show
            // a hint.
            next[sym] = { ...prev[sym], freshness: "stale" };
          }
        }
        return next;
      });

      const fresh = response.unavailable ?? {};
      const next: Record<string, UnavailableReason> = {};
      for (const sym of symbolList) {
        const u = fresh[sym];
        if (u) next[sym] = u;
      }
      setUnavailable(next);
    } catch (err) {
      // api() already toasted the user-visible error with a ref id. We
      // additionally surface it in `error` state + mark symbols as
      // freshness:'error' so the UI renders an inline hint. No
      // console.error needed (CLAUDE.md rule 10: failed fetches must log
      // detailed errors — the toast is our client log surface).
      setError((err as Error).message);
      setMarket((prev) => {
        const next: Market = { ...prev };
        for (const sym of symbolList) {
          if (next[sym]) next[sym] = { ...next[sym], freshness: "error" };
        }
        return next;
      });
      setUnavailable({});
    }
  }, [symbolList]);

  useEffect(() => {
    void loadSnapshots();
    if (symbolList.length > 0) {
      // ensureSubscribed failure is non-fatal: snapshots still work via
      // REST polling, we just won't get live ticks for these symbols until
      // the next call. api() already toasted — we reflect the state as
      // 'unavailable' via the provider-status handler. Don't silently
      // swallow: capture into `error` so the UI can surface it too.
      priceClient.ensureSubscribed(symbolList).catch((err: unknown) => {
        setError((err as Error).message);
      });
    }
  }, [loadSnapshots, symbolList]);

  // ---- periodic refresh to catch bid/ask/OHLC drift -----------------------
  useEffect(() => {
    if (symbolList.length === 0) return;
    const id = window.setInterval(() => {
      void loadSnapshots();
    }, config.snapshotRefreshMs);
    return () => window.clearInterval(id);
  }, [loadSnapshots, symbolList]);

  // ---- staleness scan every few seconds -----------------------------------
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      setMarket((prev) => {
        let changed = false;
        const next: Market = { ...prev };
        for (const [sym, snap] of Object.entries(prev)) {
          if (
            snap.freshness === "live" &&
            now - snap.lastUpdated > config.staleAfterMs
          ) {
            next[sym] = { ...snap, freshness: "stale" };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 5_000);
    return () => window.clearInterval(id);
  }, []);

  // Consolidated provider status: unavailable if socket is down.
  const derivedProviderStatus: "live" | "stale" | "unavailable" =
    useMemo(() => {
      if (!liveConnected) return "unavailable";
      return providerStatus;
    }, [liveConnected, providerStatus]);

  return {
    market,
    unavailable,
    liveConnected,
    providerStatus: derivedProviderStatus,
    provider,
    error,
    replayClock,
    replayDate,
  };
}
