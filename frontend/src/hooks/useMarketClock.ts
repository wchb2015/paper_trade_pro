import { useEffect, useRef, useState } from "react";
import { marketClient } from "../lib/marketClient";
import type { MarketClockResponse } from "../../../shared/src";

// -----------------------------------------------------------------------------
// useMarketClock — polls /api/market/clock so the trade ticket can disable
// market orders outside of regular hours. Server cache TTL is 30s, so polling
// every 30s here means the worst-case staleness is one minute. That's plenty
// for the use case (telling the user "Market closed — opens 9:30 AM ET").
//
// Resilience:
//   - First fetch errors leave `clock` null and `error` populated. Callers
//     should treat `null` as "unknown — disable risky actions" rather than
//     "open" or "closed". The TradeTicket handles this explicitly.
//   - Subsequent errors keep the last successful clock visible (it's cheap
//     accuracy — the ET wall-clock didn't suddenly stop ticking) and just
//     update `error`.
// -----------------------------------------------------------------------------

const POLL_MS = 30_000;

export interface UseMarketClockResult {
  clock: MarketClockResponse | null;
  error: string | null;
  /** True before the first fetch resolves either way. */
  loading: boolean;
}

export function useMarketClock(): UseMarketClockResult {
  const [clock, setClock] = useState<MarketClockResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    const tick = () => {
      marketClient
        .getClock()
        .then((c) => {
          if (!mounted.current) return;
          setClock(c);
          setError(null);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (!mounted.current) return;
          const msg = err instanceof Error ? err.message : String(err);
          // CLAUDE.md rule 1/6 — never silently swallow. The toast from the
          // shared `api()` wrapper is the user-visible log surface; we also
          // log to the console so it shows up in DevTools without a toast.
          console.error("ERROR /api/market/clock fetch failed", { err });
          setError(msg);
          setLoading(false);
        });
    };

    tick();
    const handle = window.setInterval(tick, POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(handle);
    };
  }, []);

  return { clock, error, loading };
}
