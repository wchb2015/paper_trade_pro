import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';

import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from '../../shared/src';
import { loadConfig } from './config';
import { closePool } from './db';
import { createPriceProvider } from './providers';
import { QuoteCache } from './services/QuoteCache';
import { PriceStreamHub } from './services/PriceStreamHub';
import { createQuotesRouter } from './routes/quotes';
import { createPortfolioRouter } from './routes/portfolio';
import { PortfolioStore } from './store/PortfolioStore';

// -----------------------------------------------------------------------------
// Server entry point. Wires the provider, cache, stream hub, and REST routes
// together. No Alpaca-specific code lives here — swap providers via
// PRICE_PROVIDER env + providers/index.ts factory.
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig();

  const app = express();
  app.use(cors({ origin: cfg.frontendOrigin }));
  app.use(express.json());

  const server = http.createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
    cors: { origin: cfg.frontendOrigin },
  });

  const provider = createPriceProvider(cfg);
  const cache = new QuoteCache(provider, cfg.limits.SNAPSHOT_CACHE_TTL_MS);
  const hub = new PriceStreamHub(io, provider, cache, cfg);

  app.use(
    '/api',
    createQuotesRouter({
      provider,
      cache,
      hub,
      barsCacheTtlMs: cfg.limits.BARS_CACHE_TTL_MS,
    }),
  );

  // Portfolio (positions, orders, alerts, watchlist). Pre-auth: every
  // request maps to cfg.currentUserId. When we add login, replace the
  // getUserId callback with a session lookup.
  const portfolioStore = new PortfolioStore({ initialCash: cfg.initialCash });
  app.use(
    '/api',
    createPortfolioRouter({
      store: portfolioStore,
      getUserId: () => cfg.currentUserId,
    }),
  );

  // Kick off the WS stream with an empty subscription set; the frontend
  // drives symbol choice via GET /quotes and POST /subscriptions, which in
  // turn call hub.ensureSubscribed.
  await hub.start([]);

  io.on('connection', (socket) => {
    console.log(`socket connected: ${socket.id}`);
    socket.on('disconnect', () => {
      console.log(`socket disconnected: ${socket.id}`);
    });
  });

  server.listen(cfg.port, () => {
    console.log(
      `paper-trade-pro backend listening on :${cfg.port} ` +
        `(provider=${provider.name}, feed=${cfg.alpaca.feed})`,
    );
  });

  // Graceful shutdown — drain the pg pool so Neon doesn't keep idle
  // connections open past our process lifetime.
  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    server.close();
    await closePool().catch(() => {
      /* best effort */
    });
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('fatal startup error:', err);
  process.exit(1);
});
