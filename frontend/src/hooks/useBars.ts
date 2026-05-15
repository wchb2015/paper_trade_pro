import { useEffect, useState } from "react";
import type { Bar, BarTimeframe } from "../../../shared/src";
import { priceClient } from "../lib/priceClient";

// -----------------------------------------------------------------------------
// useBars: batched OHLC fetch for a list of symbols. Returns a per-symbol
// array of bars and refreshes on `refreshMs` so a sparkline drawn from the
// result reflects the latest minute.
//
// The underlying /api/bars endpoint is server-side-cached per
// (symbol, timeframe, limit) for `BARS_CACHE_TTL_MS`, so polling here is
// cheap — we just hand out the cached value during the cache window.
//
// Errors are logged via the api() toast layer and dropped per-symbol so
// one failing ticker doesn't blank out the whole watchlist.
// -----------------------------------------------------------------------------

export function useBars(
  symbols: string[],
  timeframe: BarTimeframe = "1Min",
  limit = 400,
  refreshMs = 60_000,
): Record<string, Bar[]> {
  const [bars, setBars] = useState<Record<string, Bar[]>>({});

  // Stable string key so we re-fire only when the actual list changes.
  const key = symbols
    .map((s) => s.toUpperCase())
    .sort()
    .join(",");

  useEffect(() => {
    if (key.length === 0) {
      setBars({});
      return;
    }
    let cancelled = false;
    const list = key.split(",");

    const fetchAll = async () => {
      const next: Record<string, Bar[]> = {};
      const results = await Promise.allSettled(
        list.map((sym) => priceClient.fetchBars(sym, timeframe, limit)),
      );
      results.forEach((r, i) => {
        const sym = list[i];
        if (!sym) return;
        if (r.status === "fulfilled") {
          next[sym] = r.value.bars;
        } else {
          // Per-symbol failure: keep prior data so the sparkline doesn't
          // blank during a transient upstream blip. api() already toasted.
          console.error(
            "ERROR useBars: fetchBars failed",
            sym,
            timeframe,
            r.reason,
          );
        }
      });
      if (cancelled) return;
      setBars((prev) => {
        const merged: Record<string, Bar[]> = { ...prev };
        for (const sym of list) {
          if (next[sym]) merged[sym] = next[sym];
        }
        // Drop bars for symbols no longer in the list.
        for (const sym of Object.keys(merged)) {
          if (!list.includes(sym)) delete merged[sym];
        }
        return merged;
      });
    };

    void fetchAll();
    const id = window.setInterval(() => {
      void fetchAll();
    }, refreshMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [key, timeframe, limit, refreshMs]);

  return bars;
}
