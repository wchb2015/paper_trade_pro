import { Router, type Request, type Response } from 'express';
import type {
  Bar,
  BarTimeframe,
  BarsResponse,
  QuotesResponse,
  SubscriptionsResponse,
} from '../../../shared/src';
import type { PriceProvider } from '../providers/PriceProvider';
import type { QuoteCache } from '../services/QuoteCache';
import type { PriceStreamHub } from '../services/PriceStreamHub';

// -----------------------------------------------------------------------------
// REST endpoints. These are the only HTTP routes the frontend needs:
//   GET  /api/quotes?symbols=A,B,C   - batch snapshot fetch (cached)
//   GET  /api/bars?symbol=A&timeframe=1Day&limit=90
//   POST /api/subscriptions          - ensure WS subscribed to symbols
//   GET  /api/subscriptions          - list current WS subscriptions (debug)
//   GET  /api/health                 - liveness + provider status
// -----------------------------------------------------------------------------

interface RouteDeps {
  provider: PriceProvider;
  cache: QuoteCache;
  hub: PriceStreamHub;
  barsCacheTtlMs: number;
}

interface BarsCacheEntry {
  bars: Bar[];
  cachedAt: number;
}

const VALID_TIMEFRAMES: readonly BarTimeframe[] = [
  '1Min',
  '5Min',
  '15Min',
  '1Hour',
  '1Day',
];

export function createQuotesRouter(deps: RouteDeps): Router {
  const router = Router();
  const barsCache = new Map<string, BarsCacheEntry>();

  router.get('/quotes', async (req: Request, res: Response) => {
    try {
      const raw = String(req.query.symbols ?? '');
      const symbols = raw
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      if (symbols.length === 0) {
        return res.status(400).json({ error: 'symbols query param required' });
      }

      const quotes = await deps.cache.getMany(symbols);

      // Eagerly ensure those symbols are also streaming. Cheap when they're
      // already subscribed; kicks off the WS subscribe otherwise.
      await deps.hub.ensureSubscribed(symbols).catch((err) => {
        console.warn('ensureSubscribed failed:', (err as Error).message);
      });

      const body: QuotesResponse = {
        quotes,
        providerStatus: deps.hub.getStatus().status,
        provider: deps.provider.name,
      };
      return res.json(body);
    } catch (err) {
      console.error('[GET /quotes]', err);
      const body: QuotesResponse = {
        quotes: {},
        providerStatus: 'unavailable',
        provider: deps.provider.name,
      };
      return res.status(502).json(body);
    }
  });

  router.get('/bars', async (req: Request, res: Response) => {
    try {
      const symbol = String(req.query.symbol ?? '').toUpperCase();
      const timeframe = String(req.query.timeframe ?? '1Day') as BarTimeframe;
      const limit = Math.min(
        Math.max(Number(req.query.limit ?? 90), 1),
        1000,
      );
      if (!symbol) {
        return res.status(400).json({ error: 'symbol query param required' });
      }
      if (!VALID_TIMEFRAMES.includes(timeframe)) {
        return res.status(400).json({
          error: `invalid timeframe; one of ${VALID_TIMEFRAMES.join(', ')}`,
        });
      }

      const key = `${symbol}|${timeframe}|${limit}`;
      const now = Date.now();
      const hit = barsCache.get(key);
      if (hit && now - hit.cachedAt < deps.barsCacheTtlMs) {
        const body: BarsResponse = {
          symbol,
          timeframe,
          bars: hit.bars,
          provider: deps.provider.name,
        };
        return res.json(body);
      }

      const bars = await deps.provider.fetchBars(symbol, timeframe, limit);
      barsCache.set(key, { bars, cachedAt: now });
      const body: BarsResponse = {
        symbol,
        timeframe,
        bars,
        provider: deps.provider.name,
      };
      return res.json(body);
    } catch (err) {
      console.error('[GET /bars]', err);
      return res.status(502).json({ error: (err as Error).message });
    }
  });

  router.post('/subscriptions', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        symbols?: unknown;
        replace?: unknown;
      };
      const raw = body.symbols;
      const list = Array.isArray(raw)
        ? raw.filter((x): x is string => typeof x === 'string')
        : [];
      const replace = body.replace === true;
      const subscribed = await deps.hub.ensureSubscribed(list, { replace });
      const out: SubscriptionsResponse = { subscribed };
      return res.json(out);
    } catch (err) {
      console.error('[POST /subscriptions]', err);
      return res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get('/subscriptions', (_req: Request, res: Response) => {
    const body: SubscriptionsResponse = {
      subscribed: deps.hub.listSubscriptions(),
    };
    res.json(body);
  });

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      provider: deps.provider.name,
      providerStatus: deps.hub.getStatus().status,
      subscribed: deps.hub.listSubscriptions(),
    });
  });

  return router;
}
