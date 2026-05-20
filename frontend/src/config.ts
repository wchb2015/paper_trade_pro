// Frontend runtime config. Only two things are configurable at build-time
// for the UI — refresh intervals. The backend URL is empty: every client
// module builds relative paths ('/api/...') that ride on the Vite dev
// proxy in development and on the nginx reverse-proxy in production.

const meta = import.meta.env as Record<string, string | undefined>;

export const config = {
  /**
   * Empty string by design. All client modules call `/api/...` directly,
   * which the dev server (Vite proxy) and prod (nginx) both route to the
   * Node backend. Same-origin everywhere keeps the cookie + CORS story
   * identical between dev and prod. See spec §5.0.
   */
  backendUrl: '',
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
