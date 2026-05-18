import { Router, type Request, type Response } from 'express';
import { getLogger } from '@chongbei/web-basics/server';
import type { MarketClock } from '../services/MarketClock';
import type { MarketClockResponse } from '../../../shared/src';

const log = getLogger('routes.market');

// -----------------------------------------------------------------------------
// Market metadata routes. Today this is just the clock; if we add a
// "trading-status by symbol" endpoint later it goes here too.
//
//   GET /api/market/clock — Alpaca /v2/clock proxy. Cached in MarketClock so
//   this route is essentially free (in-memory read most of the time).
// -----------------------------------------------------------------------------

interface RouteDeps {
  marketClock: MarketClock;
}

export function createMarketRouter(deps: RouteDeps): Router {
  const router = Router();

  router.get('/market/clock', async (req: Request, res: Response) => {
    try {
      // Use tryGetStatus so a transient Alpaca outage doesn't 5xx the UI
      // (the frontend uses this to decide whether the submit button is
      // enabled — a 500 there would be confusing). On null we surface a
      // 503 with a clear message; the UI can show "Market status
      // unavailable" and disable trading.
      const status = await deps.marketClock.tryGetStatus();
      if (!status) {
        return res.status(503).json({
          error: 'market clock unavailable',
        });
      }
      const body: MarketClockResponse = status;
      return res.json(body);
    } catch (err) {
      // Defensive — tryGetStatus shouldn't throw, but if it ever does we
      // log loudly per CLAUDE.md rule 1/6.
      log.error(
        { err, route: 'GET /market/clock' },
        'ERROR GET /market/clock failed',
      );
      return res.status(500).json({ error: 'failed to read market clock' });
    }
  });

  return router;
}
