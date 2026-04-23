// Frontend runtime config. Only two things are configurable at build-time
// for the UI — the backend URL and a refresh interval. Everything else is
// derived from defaults so we don't accumulate knobs.

const meta = import.meta.env as Record<string, string | undefined>;

export const config = {
  /** URL of the paper-trade-pro backend. */
  backendUrl: meta['VITE_BACKEND_URL'] ?? 'http://localhost:4000',
  /**
   * How often we poll the backend's /api/quotes as a belt-and-suspenders
   * refresh of bid/ask/dayHigh/etc. (the socket only delivers trade price).
   */
  snapshotRefreshMs: Number(meta['VITE_SNAPSHOT_REFRESH_MS'] ?? 30_000),
  /** After this long with no tick, a symbol is shown as "stale". */
  staleAfterMs: Number(meta['VITE_STALE_AFTER_MS'] ?? 60_000),
  /** Max points kept in the rolling history drawn in sparklines. */
  sparklinePoints: 90,
} as const;
