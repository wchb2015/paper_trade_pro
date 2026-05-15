import path from "node:path";
import { FREE_TIER, PROVIDERS, type ProviderName } from "../../shared/src";

// -----------------------------------------------------------------------------
// Typed config. Secrets + deployment knobs come from .env. Rate limits,
// timeouts, and derived defaults live here (typed + version-controlled).
//
// Ports / URLs come from ports.cjs at the repo root — single source of truth.
// No .env fallback: if a required key is missing or wrong type, throw at
// startup so we fail fast instead of binding to a wrong port.
// -----------------------------------------------------------------------------

const ports = require("../../ports.cjs") as {
  BACKEND_PORT: number;
  FRONTEND_DEV_PORT: number;
  BACKEND_URL: string;
  FRONTEND_DEV_URL: string;
};
if (typeof ports.BACKEND_PORT !== "number") {
  throw new Error("FATAL: ports.cjs missing BACKEND_PORT (number)");
}
if (typeof ports.FRONTEND_DEV_URL !== "string" || !ports.FRONTEND_DEV_URL) {
  throw new Error("FATAL: ports.cjs missing FRONTEND_DEV_URL (string)");
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(
      `Missing required env var ${name}. See .env.example for the full list.`,
    );
  }
  return v;
}

function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function parseProvider(raw: string | undefined): ProviderName {
  const value = (raw ?? "alpaca").toLowerCase();
  if (!(PROVIDERS as readonly string[]).includes(value)) {
    throw new Error(
      `Unknown PRICE_PROVIDER="${value}". Valid: ${PROVIDERS.join(", ")}`,
    );
  }
  return value as ProviderName;
}

function parseFeed(raw: string | undefined): "iex" | "sip" {
  const v = (raw ?? "iex").toLowerCase();
  if (v !== "iex" && v !== "sip") {
    throw new Error(`Unknown ALPACA_FEED="${v}". Valid: iex, sip`);
  }
  return v;
}

export interface AppConfig {
  port: number;
  frontendOrigin: string;
  provider: ProviderName;
  alpaca: {
    keyId: string;
    secretKey: string;
    /** IEX is free; SIP requires a paid subscription. */
    feed: "iex" | "sip";
    restBaseUrl: string;
    wsUrl: string;
  };
  /**
   * ReplayProvider settings. Only read when provider === 'replay'. Defaults
   * are permissive so switching providers is a one-env-var toggle.
   */
  replay: {
    /** Which folder under cacheDir to read (YYYY-MM-DD). */
    date: string;
    /** 1 = real-time, 10 = 10× faster, 0 = as-fast-as-possible. */
    speed: number;
    /** Reopen all readers from start after EOD so the feed never dies. */
    loop: boolean;
    /** Absolute path to the NDJSON root — usually backend/.replay-cache. */
    cacheDir: string;
  };
  /** Postgres connection string (e.g. Neon pooled URL). */
  databaseUrl: string;
  /**
   * Pre-auth: every portfolio request is scoped to this single user_id.
   * Swap for the authenticated session subject once login exists — that's
   * the only line that changes.
   */
  currentUserId: string;
  /** Starting cash for auto-provisioned accounts / reset-funds. */
  initialCash: number;
  /** Re-exported for convenience so consumers don't double-import. */
  limits: typeof FREE_TIER;
}

let cached: AppConfig | null = null;

/**
 * Build + validate config. Idempotent — validates once per process.
 * Throws loudly at startup if anything is missing or malformed so we fail
 * fast rather than 500 on the first request.
 */
export function loadConfig(): AppConfig {
  if (cached) return cached;

  const provider = parseProvider(optionalEnv("PRICE_PROVIDER"));
  const feed = parseFeed(optionalEnv("ALPACA_FEED"));

  const cfg: AppConfig = {
    port: ports.BACKEND_PORT,
    frontendOrigin: ports.FRONTEND_DEV_URL,
    provider,
    alpaca: {
      keyId: requireEnv("APCA_KEY_ID"),
      secretKey: requireEnv("APCA_SECRET_KEY"),
      feed,
      // Data endpoints are the same for paper + live accounts.
      restBaseUrl:
        optionalEnv("ALPACA_DATA_URL") ?? "https://data.alpaca.markets",
      wsUrl:
        optionalEnv("ALPACA_STREAM_URL") ??
        `wss://stream.data.alpaca.markets/v2/${feed}`,
    },
    databaseUrl: requireEnv("DATABASE_URL"),
    currentUserId:
      optionalEnv("CURRENT_USER_ID") ?? "3f7c9b2e-8a41-4d6c-b5f3-1e9a72c4d8ab",
    initialCash: Number(optionalEnv("INITIAL_CASH") ?? 100_000),
    limits: FREE_TIER,
    replay: {
      date: optionalEnv("REPLAY_DATE") ?? "2026-05-01",
      speed: Number(optionalEnv("REPLAY_SPEED") ?? 1),
      loop: (optionalEnv("REPLAY_LOOP") ?? "true").toLowerCase() !== "false",
      cacheDir:
        optionalEnv("REPLAY_CACHE_DIR") ??
        path.resolve(__dirname, "..", ".replay-cache"),
    },
  };

  cached = cfg;
  return cfg;
}
