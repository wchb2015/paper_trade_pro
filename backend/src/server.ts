import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

// Walk up from __dirname to find the repo-root .env. Source runs from
// backend/src (depth 2 below repo root); compiled runs from
// backend/dist/backend/src (depth 4) because tsconfig's rootDir is the repo
// root. A static `../../.env` literal works for one but not the other.
function resolveDotEnv(): string {
  let dir = __dirname;
  while (true) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `FATAL: could not locate .env walking up from ${__dirname}`,
      );
    }
    dir = parent;
  }
}
dotenv.config({ path: resolveDotEnv() });
// Bootstrap the singleton logger BEFORE any other module that calls
// getLogger("...") at module scope (db.ts, routes/*, services/*).
// Side-effect import — must come before those imports so the singleton
// gets built with our service name instead of defaults.
import "./loggerBootstrap";
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import {
  getLogger,
  attachRef,
  errorHandler,
  getDefaultLogger,
} from "@chongbei/web-basics/server";

const log = getLogger("server");

import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../../shared/src";
import { loadConfig } from "./config";
import { closePool } from "./db";
import { createPriceProvider } from "./providers";
import { QuoteCache } from "./services/QuoteCache";
import { PriceStreamHub } from "./services/PriceStreamHub";
import { EquitySnapshotter } from "./services/EquitySnapshotter";
import { MarketClock } from "./services/MarketClock";
import { createQuotesRouter } from "./routes/quotes";
import { createPortfolioRouter } from "./routes/portfolio";
import { createMarketRouter } from "./routes/market";
import { PortfolioStore } from "./store/PortfolioStore";

// -----------------------------------------------------------------------------
// Server entry point. Wires the provider, cache, stream hub, and REST routes
// together. No Alpaca-specific code lives here — swap providers via
// PRICE_PROVIDER env + providers/index.ts factory.
//
// Logging: every request gets a short `ref` id via `attachRef` (stashed in
// AsyncLocalStorage), and every `log.*` call in any downstream service or
// route picks it up automatically. `errorHandler` catches anything thrown
// past route-level try/catches — belt-and-suspenders for the "no silent
// failures" rule in CLAUDE.md.
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig();

  const app = express();
  app.use(cors({ origin: cfg.frontendOrigin }));
  app.use(express.json());
  // Install early so every route handler and service call downstream can emit
  // logs tagged with the request's `ref`.
  app.use(attachRef);

  const server = http.createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
    cors: { origin: cfg.frontendOrigin },
  });

  const provider = createPriceProvider(cfg);
  const cache = new QuoteCache(provider, cfg.limits.SNAPSHOT_CACHE_TTL_MS);
  const hub = new PriceStreamHub(io, provider, cache, cfg);

  app.use(
    "/api",
    createQuotesRouter({
      provider,
      cache,
      hub,
      barsCacheTtlMs: cfg.limits.BARS_CACHE_TTL_MS,
    }),
  );

  // Market clock — single source of truth for "is the U.S. equities market
  // open right now?". Backed by Alpaca's /v2/clock (authoritative for NYSE
  // holidays). Used both by the order-placement gate inside PortfolioStore
  // and by the GET /api/market/clock route the frontend polls.
  const marketClock = new MarketClock(cfg);
  app.use("/api", createMarketRouter({ marketClock }));

  // Portfolio (positions, orders, alerts, watchlist). Pre-auth: every
  // request maps to cfg.currentUserId. When we add login, replace the
  // getUserId callback with a session lookup.
  const portfolioStore = new PortfolioStore({
    initialCash: cfg.initialCash,
    marketClock,
  });
  const snapshotter = new EquitySnapshotter(
    cache,
    cfg.historySnapshotIntervalMs,
  );
  snapshotter.start();
  app.use(
    "/api",
    createPortfolioRouter({
      store: portfolioStore,
      snapshotter,
      getUserId: () => cfg.currentUserId,
    }),
  );

  // Final safety net: anything thrown past a route's try/catch lands here,
  // gets logged (with ref), and returns `{ error: { code, message, ref } }`.
  // Keep last.
  app.use(errorHandler(getDefaultLogger()));

  // Kick off the WS stream with an empty subscription set; the frontend
  // drives symbol choice via GET /quotes and POST /subscriptions, which in
  // turn call hub.ensureSubscribed.
  await hub.start([]);

  io.on("connection", (socket) => {
    log.info({ socketId: socket.id }, "socket connected");
    socket.on("disconnect", () => {
      log.info({ socketId: socket.id }, "socket disconnected");
    });
  });

  server.listen(cfg.port, () => {
    log.info(
      {
        port: cfg.port,
        provider: provider.name,
        feed: cfg.alpaca.feed,
      },
      "paper-trade-pro backend listening",
    );
  });

  // Graceful shutdown — drain the pg pool so Neon doesn't keep idle
  // connections open past our process lifetime.
  const shutdown = async (signal: string) => {
    log.info({ signal }, "received signal, shutting down");
    server.close();
    snapshotter.stop();
    await closePool().catch((err: unknown) => {
      // Log the failure even though we continue — the process is exiting
      // anyway, but silent swallow would violate CLAUDE.md rule 5.
      log.error(
        { err, operation: "closePool" },
        "ERROR pg pool failed to close on shutdown (continuing exit)",
      );
    });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  log.fatal({ err, operation: "main" }, "FATAL backend startup failed");
  process.exit(1);
});
