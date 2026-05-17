import { Router, type Request, type Response } from "express";
import { getLogger } from "@chongbei/web-basics/server";

const log = getLogger("routes.portfolio");

// Express 5 widens `req.params.id` to `string | string[] | undefined`, even
// for routes where the pattern obviously yields a single string. Narrow it
// once in a helper so the handler bodies stay tidy.
function pickId(req: Request): string {
  const v = req.params.id;
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`invalid :id path param`);
  }
  return v;
}
import type {
  AddAlertInput,
  FillOrderInput,
  HistoryRange,
  OkResponse,
  PlaceOrderInput,
  PortfolioHistoryResponse,
  ResetFundsInput,
  ToggleWatchInput,
  TriggerAlertInput,
  UpdatePeakInput,
} from "../../../shared/src";
import { isHistoryRange } from "../../../shared/src";
import type { PortfolioStore } from "../store/PortfolioStore";
import type { EquitySnapshotter } from "../services/EquitySnapshotter";

// -----------------------------------------------------------------------------
// Portfolio REST routes. Every mutating endpoint returns the refreshed
// Portfolio so the client can replace its state in one shot (same pattern
// the old localStorage hook used internally).
//
// All endpoints operate on a single user id injected by the caller. For
// pre-auth, server.ts passes `cfg.currentUserId`; when we add login, swap
// this to a session lookup — no route code needs to change.
//
// Logging: every catch logs with `log.error({ err, route, userId }, ...)`
// before responding. `attachRef` in server.ts auto-attaches a per-request
// `ref` to each line. No silent failures (CLAUDE.md rules 1, 6, 8).
// -----------------------------------------------------------------------------

interface RouteDeps {
  store: PortfolioStore;
  snapshotter: EquitySnapshotter;
  getUserId: (req: Request) => string;
}

function asError(err: unknown): { status: number; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  // Our store throws on client-correctable issues (bad enum, missing
  // price, wrong order state). Treat these as 400s.
  const clientErrorMarkers = [
    "invalid",
    "required",
    "must be",
    "not found",
    "not cancellable",
    "cannot fill",
    "already triggered",
  ];
  const isClient = clientErrorMarkers.some((m) =>
    message.toLowerCase().includes(m),
  );
  return { status: isClient ? 400 : 500, message };
}

export function createPortfolioRouter(deps: RouteDeps): Router {
  const router = Router();
  const { store, snapshotter, getUserId } = deps;

  // GET /api/portfolio — full snapshot
  router.get("/portfolio", async (req: Request, res: Response) => {
    try {
      const portfolio = await store.getPortfolio(getUserId(req));
      res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      log.error(
        { err, route: "GET /portfolio", userId: getUserId(req), status },
        "ERROR GET /portfolio failed",
      );
      res.status(status).json({ error: message });
    }
  });

  // POST /api/orders — place a new order (market orders fill in-line).
  // Returns just the post-mutation Order. Cash + positions live on
  // GET /api/portfolio; the client refetches that endpoint after a
  // place to refresh those scopes. Each route owns one concern.
  router.post("/orders", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as PlaceOrderInput;
      const order = await store.placeOrder(getUserId(req), body);
      // Market orders mutate cash + positions in placeOrder; snapshot now so
      // the chart picks up the fill instantly. Non-market just inserts a
      // pending row (no equity change), but snapshotting is cheap.
      if (body.type === "market") {
        void snapshotter.snapshotUser(getUserId(req));
      }
      res.json(order);
    } catch (err) {
      const { status, message } = asError(err);
      log.error(
        { err, route: "POST /orders", userId: getUserId(req), status },
        "ERROR POST /orders failed",
      );
      res.status(status).json({ error: message });
    }
  });

  // POST /api/orders/:id/cancel
  router.post("/orders/:id/cancel", async (req: Request, res: Response) => {
    try {
      const portfolio = await store.cancelOrder(getUserId(req), pickId(req));
      res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      log.error(
        {
          err,
          route: "POST /orders/:id/cancel",
          userId: getUserId(req),
          orderId: req.params.id,
          status,
        },
        "ERROR POST /orders/:id/cancel failed",
      );
      res.status(status).json({ error: message });
    }
  });

  // POST /api/orders/:id/fill — triggered fill for limit/stop/trailing/conditional
  router.post("/orders/:id/fill", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as FillOrderInput;
      if (typeof body.fillPrice !== "number") {
        return res.status(400).json({ error: "fillPrice (number) required" });
      }
      const portfolio = await store.fillOrder(
        getUserId(req),
        pickId(req),
        body.fillPrice,
      );
      void snapshotter.snapshotUser(getUserId(req));
      return res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      log.error(
        {
          err,
          route: "POST /orders/:id/fill",
          userId: getUserId(req),
          orderId: req.params.id,
          status,
        },
        "ERROR POST /orders/:id/fill failed",
      );
      return res.status(status).json({ error: message });
    }
  });

  // POST /api/orders/:id/peak — trailing-stop peak update
  router.post("/orders/:id/peak", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as UpdatePeakInput;
      if (typeof body.peak !== "number") {
        return res.status(400).json({ error: "peak (number) required" });
      }
      const portfolio = await store.updateTrailingPeak(
        getUserId(req),
        pickId(req),
        body.peak,
      );
      return res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      log.error(
        {
          err,
          route: "POST /orders/:id/peak",
          userId: getUserId(req),
          orderId: req.params.id,
          status,
        },
        "ERROR POST /orders/:id/peak failed",
      );
      return res.status(status).json({ error: message });
    }
  });

  // POST /api/alerts — add
  router.post("/alerts", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as AddAlertInput;
      const portfolio = await store.addAlert(getUserId(req), body);
      res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      log.error(
        { err, route: "POST /alerts", userId: getUserId(req), status },
        "ERROR POST /alerts failed",
      );
      res.status(status).json({ error: message });
    }
  });

  // POST /api/alerts/:id/toggle
  router.post("/alerts/:id/toggle", async (req: Request, res: Response) => {
    try {
      const portfolio = await store.toggleAlert(getUserId(req), pickId(req));
      res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      log.error(
        {
          err,
          route: "POST /alerts/:id/toggle",
          userId: getUserId(req),
          alertId: req.params.id,
          status,
        },
        "ERROR POST /alerts/:id/toggle failed",
      );
      res.status(status).json({ error: message });
    }
  });

  // POST /api/alerts/:id/trigger — client observed the price crossing
  router.post("/alerts/:id/trigger", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as TriggerAlertInput;
      if (typeof body.price !== "number") {
        return res.status(400).json({ error: "price (number) required" });
      }
      const portfolio = await store.markAlertTriggered(
        getUserId(req),
        pickId(req),
        body.price,
      );
      return res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      log.error(
        {
          err,
          route: "POST /alerts/:id/trigger",
          userId: getUserId(req),
          alertId: req.params.id,
          status,
        },
        "ERROR POST /alerts/:id/trigger failed",
      );
      return res.status(status).json({ error: message });
    }
  });

  // DELETE /api/alerts/:id
  router.delete("/alerts/:id", async (req: Request, res: Response) => {
    try {
      const portfolio = await store.removeAlert(getUserId(req), pickId(req));
      res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      log.error(
        {
          err,
          route: "DELETE /alerts/:id",
          userId: getUserId(req),
          alertId: req.params.id,
          status,
        },
        "ERROR DELETE /alerts/:id failed",
      );
      res.status(status).json({ error: message });
    }
  });

  // POST /api/watchlist/toggle
  router.post("/watchlist/toggle", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as ToggleWatchInput;
      if (typeof body.ticker !== "string" || !body.ticker) {
        return res.status(400).json({ error: "ticker (string) required" });
      }
      const portfolio = await store.toggleWatch(getUserId(req), body.ticker);
      return res.json(portfolio);
    } catch (err) {
      const { status, message } = asError(err);
      log.error(
        {
          err,
          route: "POST /watchlist/toggle",
          userId: getUserId(req),
          status,
        },
        "ERROR POST /watchlist/toggle failed",
      );
      return res.status(status).json({ error: message });
    }
  });

  // GET /api/portfolio/history?range=1M|3M|YTD|ALL
  router.get("/portfolio/history", async (req: Request, res: Response) => {
    try {
      const raw = req.query.range;
      const rangeStr = typeof raw === "string" ? raw : "1M";
      if (!isHistoryRange(rangeStr)) {
        return res.status(400).json({ error: `invalid range "${rangeStr}"` });
      }
      const range: HistoryRange = rangeStr;
      const points = await store.getHistory(getUserId(req), range);
      const body: PortfolioHistoryResponse = { range, points };
      return res.json(body);
    } catch (err) {
      const { status, message } = asError(err);
      log.error(
        {
          err,
          route: "GET /portfolio/history",
          userId: getUserId(req),
          status,
        },
        "ERROR GET /portfolio/history failed",
      );
      return res.status(status).json({ error: message });
    }
  });

  // POST /api/portfolio/reset — dev: wipes positions/orders/history (and
  // equity snapshots) and restarts the account at the given cash. Alerts
  // and watchlist are preserved across resets.
  // Returns { ok: true } on success; the client refetches /api/portfolio
  // afterwards to refresh state. Each route owns one concern.
  router.post("/portfolio/reset", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as ResetFundsInput;
      await store.resetFunds(getUserId(req), body.cash);
      // After reset, write a single starting-equity snapshot so the chart
      // has at least one point to render at the new initial cash.
      void snapshotter.snapshotUser(getUserId(req));
      const response: OkResponse = { ok: true };
      res.json(response);
    } catch (err) {
      const { status, message } = asError(err);
      log.error(
        { err, route: "POST /portfolio/reset", userId: getUserId(req), status },
        "ERROR POST /portfolio/reset failed",
      );
      res.status(status).json({ error: message });
    }
  });

  return router;
}
