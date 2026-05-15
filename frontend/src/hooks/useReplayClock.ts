import { useEffect, useState } from "react";
import type { ReplayClockAnchor } from "./useMarket";

// -----------------------------------------------------------------------------
// useReplayClock: turns a `ReplayClockAnchor` (last-tick sim time + wall time
// + replay speed) into a 1-Hz ticking sim time suitable for display.
//
// The anchor is re-set on every replay tick by useMarket, so accumulated
// extrapolation error stays bounded by the time between trades. Between
// ticks we just advance the sim clock at `speed * wall_dt`.
//
// Returns null when the active provider is not replay (or hasn't sent a
// tick yet). Callers should fall back to the wall clock or hide the
// display element entirely.
// -----------------------------------------------------------------------------

export function useReplayClock(
  anchor: ReplayClockAnchor | null,
  intervalMs = 1000,
): number | null {
  const [tickNow, setTickNow] = useState(() => Date.now());

  useEffect(() => {
    if (!anchor) return;
    // Update every `intervalMs` so the rendered seconds tick visibly.
    const id = window.setInterval(() => setTickNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [anchor, intervalMs]);

  if (!anchor) return null;
  // Hard zero-or-negative speed (REPLAY_SPEED=0 = drain ASAP) — there's no
  // meaningful "running clock" since the data is consumed instantly. Return
  // the latest sim timestamp so the UI just shows the most recent trade time.
  if (anchor.speed <= 0) return anchor.simTimestamp;
  return (
    anchor.simTimestamp + (tickNow - anchor.wallTimestamp) * anchor.speed
  );
}
