// ============================================================================
// SINGLE SOURCE OF TRUTH for all port numbers in paper_trade_pro.
// ----------------------------------------------------------------------------
// Consumers (auto-synced via require/createRequire):
//   - backend/src/config.ts     (Express listen port + CORS origin)
//   - frontend/vite.config.ts   (Vite dev server port + define for client)
//
// Format: CommonJS (.cjs) so it works in PM2 ecosystem files natively, and
// is loaded from TS via createRequire(import.meta.url) (Vite ESM) or plain
// require (backend CJS).
//
// Ports are NOT to be set in .env. If you need to override for a specific
// machine, edit this file (it's checked in — coordinate with the team).
// ============================================================================
module.exports = {
  BACKEND_PORT: 5010,
  FRONTEND_DEV_PORT: 5011,
  BACKEND_URL: "http://localhost:5010",
  FRONTEND_DEV_URL: "http://localhost:5011",
};
