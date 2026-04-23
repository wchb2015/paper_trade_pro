import { Router, type Request, type Response } from 'express';

// Express 5 widens `req.params.id` to `string | string[] | undefined`, even
// for routes where the pattern obviously yields a single string. Narrow it
// once in a helper so the handler bodies stay tidy.
function pickId(req: Request): string {
  const v = req.params.id;
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`invalid :id path param`);
  }
  return v;
}
import type {
  AddAlertInput,
  FillOrderInput,
  PlaceOrderInput,
  ResetFundsInput,
  ToggleWatchInput,
  TriggerAlertInput,
  UpdatePeakInput,
} from '../../../shared/src';
import type { PortfolioStore } from '../store/PortfolioStore';

// -----------------------------------------------------------------------------
// Portfolio REST routes. Every mutating endpoint returns the refreshed
// Portfolio so the client can replace its state in one shot (same pattern
// the old localStorage hook used internally).
//
// All endpoints operate on a single user id injected by the caller. For
// pre-auth, server.ts passes `cfg.currentUserId`; when we add login, swap
// this to a session lookup — no route code needs to change.
// -----------------------------------------------------------------------------

interface RouteDeps {
  store: PortfolioStore;
  getUserId: (req: Request) => string;
}

function asError(err: unknown): { status: number; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  // Our store throws on client-correctable issues (bad enum, missing
  // price, wrong order state). Treat these as 400s.
  const clientErrorMarkers = [
    'invalid',
    'required',
    'must be',
    'not found',
    'not cancellable',
    'cannot fill',
    'already triggered',
  ];
  const isClient = clientErrorMarkers.some((m) =>
    message.toLowerCase().includes(m),
  );
  return { status: isClient ? 400 : 500, message };
}

export function createPortfolioRouter(deps: RouteDeps): Router {
  const router = Router();
  const { store, getUserId } = deps;

  // GET /api/portfolio — full snapshot
  router.get('/portfolio', async (req: Request, res: Response) => {
    try {
      const portfolio = await store.getPortfolio(getUserId(req));
      res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      console.error('[GET /portfolio]', message);
      res.status(status).json({ error: message });
    }
  });

  // POST /api/orders — place a new order (market orders fill in-line)
  router.post('/orders', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as PlaceOrderInput;
      const portfolio = await store.placeOrder(getUserId(req), body);
      res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      console.error('[POST /orders]', message);
      res.status(status).json({ error: message });
    }
  });

  // POST /api/orders/:id/cancel
  router.post('/orders/:id/cancel', async (req: Request, res: Response) => {
    try {
      const portfolio = await store.cancelOrder(getUserId(req), pickId(req));
      res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      console.error('[POST /orders/:id/cancel]', message);
      res.status(status).json({ error: message });
    }
  });

  // POST /api/orders/:id/fill — triggered fill for limit/stop/trailing/conditional
  router.post('/orders/:id/fill', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as FillOrderInput;
      if (typeof body.fillPrice !== 'number') {
        return res.status(400).json({ error: 'fillPrice (number) required' });
      }
      const portfolio = await store.fillOrder(
        getUserId(req),
        pickId(req),
        body.fillPrice,
      );
      return res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      console.error('[POST /orders/:id/fill]', message);
      return res.status(status).json({ error: message });
    }
  });

  // POST /api/orders/:id/peak — trailing-stop peak update
  router.post('/orders/:id/peak', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as UpdatePeakInput;
      if (typeof body.peak !== 'number') {
        return res.status(400).json({ error: 'peak (number) required' });
      }
      const portfolio = await store.updateTrailingPeak(
        getUserId(req),
        pickId(req),
        body.peak,
      );
      return res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      console.error('[POST /orders/:id/peak]', message);
      return res.status(status).json({ error: message });
    }
  });

  // POST /api/alerts — add
  router.post('/alerts', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as AddAlertInput;
      const portfolio = await store.addAlert(getUserId(req), body);
      res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      console.error('[POST /alerts]', message);
      res.status(status).json({ error: message });
    }
  });

  // POST /api/alerts/:id/toggle
  router.post('/alerts/:id/toggle', async (req: Request, res: Response) => {
    try {
      const portfolio = await store.toggleAlert(getUserId(req), pickId(req));
      res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      console.error('[POST /alerts/:id/toggle]', message);
      res.status(status).json({ error: message });
    }
  });

  // POST /api/alerts/:id/trigger — client observed the price crossing
  router.post('/alerts/:id/trigger', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as TriggerAlertInput;
      if (typeof body.price !== 'number') {
        return res.status(400).json({ error: 'price (number) required' });
      }
      const portfolio = await store.markAlertTriggered(
        getUserId(req),
        pickId(req),
        body.price,
      );
      return res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      console.error('[POST /alerts/:id/trigger]', message);
      return res.status(status).json({ error: message });
    }
  });

  // DELETE /api/alerts/:id
  router.delete('/alerts/:id', async (req: Request, res: Response) => {
    try {
      const portfolio = await store.removeAlert(getUserId(req), pickId(req));
      res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      console.error('[DELETE /alerts/:id]', message);
      res.status(status).json({ error: message });
    }
  });

  // POST /api/watchlist/toggle
  router.post('/watchlist/toggle', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as ToggleWatchInput;
      if (typeof body.ticker !== 'string' || !body.ticker) {
        return res.status(400).json({ error: 'ticker (string) required' });
      }
      const portfolio = await store.toggleWatch(getUserId(req), body.ticker);
      return res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      console.error('[POST /watchlist/toggle]', message);
      return res.status(status).json({ error: message });
    }
  });

  // POST /api/portfolio/reset — dev: wipes positions/orders/alerts/watchlist
  router.post('/portfolio/reset', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as ResetFundsInput;
      const portfolio = await store.resetFunds(getUserId(req), body.cash);
      res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      console.error('[POST /portfolio/reset]', message);
      res.status(status).json({ error: message });
    }
  });

  return router;
}
