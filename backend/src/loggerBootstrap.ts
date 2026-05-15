import { configureLogger } from "@chongbei/web-basics/server";

// Side-effect-only bootstrap. Must be imported BEFORE any other module
// that touches `getLogger` / `log`, so the singleton root is built with
// our options rather than lazy defaults. 0.8.0 throws on config drift,
// which is exactly what we want — but it means whichever call wins the
// race fixes the options forever, and we want it to be us.
//
// Level is intentionally omitted — the package falls back to LOG_LEVEL
// env var, or 'info' (prod) / 'debug' (dev). Override by setting
// LOG_LEVEL in .env or the OS env.
configureLogger({ service: "paper-trade-pro" });
