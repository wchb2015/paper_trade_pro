# Real Portfolio Value History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the synthetic sine-wave Portfolio-value chart on the dashboard with real, persisted equity history; wire the 1M / 3M / YTD / ALL range selectors to a backend endpoint that reads from a new `equity_snapshots` table.

**Architecture:**
- New `paper_trade_pro.equity_snapshots` table records `(user_id, taken_at, equity, cash, market_value)` rows.
- A scheduled snapshotter (in-process `setInterval`, started by `server.ts`) writes one row per user every `SNAPSHOT_INTERVAL_MS` during a heartbeat tick by valuing each user's positions against the live `QuoteCache`.
- `PortfolioStore` writes an additional snapshot inside the same transaction whenever cash or positions change (`applyFill`, `resetFunds`) so a chart always reflects the exact equity at fill time.
- `resetFunds` deletes all prior snapshots for that user — the user explicitly chose "wipe history" on reset.
- New `GET /api/portfolio/history?range=1M|3M|YTD|ALL` returns `{ points: [{ t, p }] }` ready to feed into `PriceChart`.
- Range strings live as a central enum in `shared/src/contracts/portfolio.ts` next to the existing enums; runtime guard `isHistoryRange` validates inbound values.
- Frontend `DashboardPage.tsx` deletes the `Math.sin` block, fetches via a new `portfolioClient.getHistory(range)`, and wires `onClick` handlers on the segmented buttons.

**Tech Stack:** PostgreSQL 18 (`uuidv7()`, `timestamptz`), `pg` (Node), Express 5, React 18, Recharts-free custom `PriceChart` (already supports `points`).

---

## File Structure

**Database:**
- Create: `backend/scripts/2026-05-16-equity-snapshots.sql` (new DDL, ALSO copy the same DDL into `backend/scripts/init-db.sql` so fresh installs pick it up).

**Shared (single source of truth for enums + types):**
- Modify: `shared/src/contracts/portfolio.ts` — add `HistoryRange`, `HISTORY_RANGES`, `isHistoryRange`, `EquityPoint`, `PortfolioHistoryResponse`.

**Backend:**
- Modify: `backend/src/store/PortfolioStore.ts`
  - Add `recordEquitySnapshot(client, userId, equity, cash, marketValue)` private helper.
  - Call it from `applyFill` and `resetFunds`.
  - Add `getHistory(userId, range)` public method.
  - In `resetFunds`, also `DELETE FROM equity_snapshots WHERE user_id = $1`.
- Create: `backend/src/services/EquitySnapshotter.ts` — periodic in-process job that values every active user's positions against `QuoteCache` and writes one snapshot per user.
- Modify: `backend/src/routes/portfolio.ts` — add `GET /portfolio/history` route with range validation.
- Modify: `backend/src/server.ts` — start the snapshotter after the store is constructed; stop it in the shutdown handler.
- Modify: `backend/src/config.ts` — add `historySnapshotIntervalMs` (default 60_000) under a new optional env var `EQUITY_SNAPSHOT_INTERVAL_MS`.

**Frontend:**
- Modify: `frontend/src/lib/portfolioClient.ts` — add `getHistory(range)`.
- Modify: `frontend/src/pages/DashboardPage.tsx` — remove the synthetic `equityHist`, add `useState<HistoryRange>('1M')`, fetch on mount + range change, pass `points` (not `data`) to `PriceChart`.
- (No changes needed to `PriceChart.tsx` — it already accepts `points: PriceChartPoint[]`.)

---

## Task 1: Add the equity_snapshots DDL

**Files:**
- Create: `backend/scripts/2026-05-16-equity-snapshots.sql`
- Modify: `backend/scripts/init-db.sql` (append the same block at the end)

The user runs the migration manually. We keep one canonical block in two places: a dated migration file the user runs once, and the same block appended to `init-db.sql` so new clones still get it. Both are idempotent (`CREATE TABLE IF NOT EXISTS`).

- [ ] **Step 1: Write the migration file**

Create `backend/scripts/2026-05-16-equity-snapshots.sql` with exactly this content:

```sql
-- =============================================================================
-- Migration 2026-05-16 — equity_snapshots
--
-- Stores per-user portfolio-value samples used by the Dashboard's
-- "Portfolio value" chart (range buttons 1M / 3M / YTD / ALL). Snapshots are
-- written by:
--   (a) EquitySnapshotter (in-process scheduled job, default every 60s)
--   (b) PortfolioStore.applyFill (inside the same transaction as the fill)
--   (c) PortfolioStore.resetFunds — first deletes all prior rows for the
--       user, then inserts a single starting snapshot at the new initial cash.
--
-- Apply via:
--   psql "$DATABASE_URL" -f backend/scripts/2026-05-16-equity-snapshots.sql
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS paper_trade_pro;
SET LOCAL search_path = paper_trade_pro, public;

CREATE TABLE IF NOT EXISTS paper_trade_pro.equity_snapshots (
  id            UUID         PRIMARY KEY DEFAULT uuidv7(),
  user_id       UUID         NOT NULL,
  taken_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  equity        NUMERIC(16,2) NOT NULL,
  cash          NUMERIC(14,2) NOT NULL,
  market_value  NUMERIC(16,2) NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT equity_snapshots_equity_finite CHECK (equity = equity),
  CONSTRAINT equity_snapshots_cash_finite   CHECK (cash = cash),
  CONSTRAINT equity_snapshots_mv_nonneg     CHECK (market_value >= 0)
);

CREATE OR REPLACE TRIGGER equity_snapshots_set_updated_at
  BEFORE UPDATE ON paper_trade_pro.equity_snapshots
  FOR EACH ROW EXECUTE FUNCTION paper_trade_pro.set_updated_at();

-- Hot path: range queries scan by (user_id, taken_at).
CREATE INDEX IF NOT EXISTS equity_snapshots_user_taken_idx
  ON paper_trade_pro.equity_snapshots (user_id, taken_at ASC);
```

- [ ] **Step 2: Append the same block to init-db.sql**

Open `backend/scripts/init-db.sql`, scroll to the very end (after the `watchlist` block), and append this exact block (note: do NOT include the migration header comment — the init-db.sql already documents itself):

```sql
-- -----------------------------------------------------------------------------
-- equity_snapshots — per-user portfolio-value samples.
-- Written by (a) the EquitySnapshotter in-process scheduled job, (b)
-- PortfolioStore.applyFill (same tx as the fill), (c) PortfolioStore.resetFunds
-- (which first deletes all prior rows for the user). Used by
-- GET /api/portfolio/history.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_trade_pro.equity_snapshots (
  id            UUID         PRIMARY KEY DEFAULT uuidv7(),
  user_id       UUID         NOT NULL,
  taken_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  equity        NUMERIC(16,2) NOT NULL,
  cash          NUMERIC(14,2) NOT NULL,
  market_value  NUMERIC(16,2) NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT equity_snapshots_equity_finite CHECK (equity = equity),
  CONSTRAINT equity_snapshots_cash_finite   CHECK (cash = cash),
  CONSTRAINT equity_snapshots_mv_nonneg     CHECK (market_value >= 0)
);

CREATE OR REPLACE TRIGGER equity_snapshots_set_updated_at
  BEFORE UPDATE ON paper_trade_pro.equity_snapshots
  FOR EACH ROW EXECUTE FUNCTION paper_trade_pro.set_updated_at();

CREATE INDEX IF NOT EXISTS equity_snapshots_user_taken_idx
  ON paper_trade_pro.equity_snapshots (user_id, taken_at ASC);
```

- [ ] **Step 3: User runs the migration**

The user runs:

```bash
psql "$DATABASE_URL" -f backend/scripts/2026-05-16-equity-snapshots.sql
```

Then, from psql:

```sql
\d paper_trade_pro.equity_snapshots
```

Expected: shows the 7 columns (id, user_id, taken_at, equity, cash, market_value, created_at, updated_at) plus the index `equity_snapshots_user_taken_idx`.

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/2026-05-16-equity-snapshots.sql backend/scripts/init-db.sql
git commit -m "feat(db): add equity_snapshots table for portfolio history chart"
```

---

## Task 2: Add HistoryRange enum + response shape to shared contracts

**Files:**
- Modify: `shared/src/contracts/portfolio.ts`

Per user direction, the central place for enums is `shared/src/contracts/portfolio.ts` (alongside `OrderType`, `OrderSide`, etc.), and value-space validation is enforced in application code only (no DB CHECK constraint for the range — it's a query-string param, not a column).

- [ ] **Step 1: Add HistoryRange type, list, guard, and response shape**

Open `shared/src/contracts/portfolio.ts`. After the `CONDITIONAL_OPS` const declaration block (currently near line 65), and BEFORE the `isOrderType` function, insert this block:

```typescript
export type HistoryRange = '1M' | '3M' | 'YTD' | 'ALL';

export const HISTORY_RANGES: readonly HistoryRange[] = [
  '1M',
  '3M',
  'YTD',
  'ALL',
] as const;
```

Then in the runtime-guard block (around line 67–81), add this function next to the other `is*` guards:

```typescript
export function isHistoryRange(v: unknown): v is HistoryRange {
  return (
    typeof v === 'string' && (HISTORY_RANGES as readonly string[]).includes(v)
  );
}
```

Finally, at the end of the file (after `ResetFundsInput`, currently line 192), add:

```typescript
/** One sample of a user's portfolio value at `t` (epoch-ms). */
export interface EquityPoint {
  /** Epoch milliseconds (UTC over the wire — see CLAUDE.md timezone rule). */
  t: number;
  /** Total portfolio equity at that instant: cash + market value of positions. */
  p: number;
}

export interface PortfolioHistoryResponse {
  range: HistoryRange;
  points: EquityPoint[];
}
```

- [ ] **Step 2: Verify the shared package still type-checks**

Run from the repo root:

```bash
cd /Users/chongbei/Workspace/personal/paper_trade_pro && (cd shared && npx tsc --noEmit) && echo TYPECHECK_OK
```

Expected: prints `TYPECHECK_OK` and no errors. (If `shared/` doesn't have a tsc target, the next step's backend build covers it via the `../../shared/src` import.)

- [ ] **Step 3: Commit**

```bash
git add shared/src/contracts/portfolio.ts
git commit -m "feat(shared): add HistoryRange enum + EquityPoint/PortfolioHistoryResponse"
```

---

## Task 3: PortfolioStore — write snapshots inside applyFill and resetFunds

**Files:**
- Modify: `backend/src/store/PortfolioStore.ts`

Snapshot writes inside an existing transaction guarantee the stored `equity` matches the post-fill cash + position state. Idle ticks are handled by Task 4's separate snapshotter.

- [ ] **Step 1: Add a private helper `recordEquitySnapshot`**

Open `backend/src/store/PortfolioStore.ts`. Find the section comment `// ---- Internals -------------` (currently around line 587). Just BEFORE the `private async ensureAccount(...)` method, add:

```typescript
  /**
   * Insert a single equity-snapshot row inside the given transaction client.
   * Caller is responsible for computing `equity` and `marketValue` from the
   * post-mutation state (typically right before getPortfolioInTx).
   */
  private async recordEquitySnapshot(
    client: PoolClient,
    userId: string,
    equity: number,
    cash: number,
    marketValue: number,
  ): Promise<void> {
    await client.query(
      `INSERT INTO paper_trade_pro.equity_snapshots
         (user_id, equity, cash, market_value)
       VALUES ($1, $2, $3, $4)`,
      [userId, equity, cash, marketValue],
    );
  }
```

- [ ] **Step 2: Add a helper to value positions inside a transaction**

Still in `backend/src/store/PortfolioStore.ts`, just below `recordEquitySnapshot`, add:

```typescript
  /**
   * Compute (cash, marketValue, equity) for a user inside a transaction.
   * Market value uses the row's `avg_price` because the store has no live
   * quote — the live-priced curve is generated by EquitySnapshotter, which
   * runs outside transactions and reads QuoteCache. For fill-time snapshots
   * this is the right number anyway: an at-fill snapshot prices the just-
   * adjusted positions at their own cost basis, which equals the equity the
   * user observes the instant after the fill.
   */
  private async valueAtCost(
    client: PoolClient,
    userId: string,
  ): Promise<{ cash: number; marketValue: number; equity: number }> {
    const acct = await client.query<{ cash: number }>(
      `SELECT cash FROM paper_trade_pro.accounts WHERE user_id = $1`,
      [userId],
    );
    const cash = acct.rows[0]?.cash ?? 0;
    const positions = await client.query<{
      side: string;
      qty: number;
      avg_price: number;
    }>(
      `SELECT side, qty, avg_price
         FROM paper_trade_pro.positions
        WHERE user_id = $1`,
      [userId],
    );
    let marketValue = 0;
    for (const r of positions.rows) {
      // Long contributes qty*price; short netting against the avg_price is
      // already reflected in cash, so we count the notional once.
      marketValue += r.qty * r.avg_price;
    }
    const equity = cash + marketValue;
    return { cash, marketValue, equity };
  }
```

- [ ] **Step 3: Call `recordEquitySnapshot` at the end of `applyFill`**

Find the end of `applyFill` (currently `await client.query(\`UPDATE paper_trade_pro.orders ... fill_price = $3 ...\`)` — around line 754–760). After that final query and BEFORE the closing `}` of the method, add:

```typescript
    // Snapshot the post-fill equity in the same transaction so the chart
    // always shows the exact equity at fill time.
    const snap = await this.valueAtCost(client, userId);
    await this.recordEquitySnapshot(
      client,
      userId,
      snap.equity,
      snap.cash,
      snap.marketValue,
    );
```

- [ ] **Step 4: Wipe + reseed snapshots in `resetFunds`**

Find `resetFunds` (currently around line 546–585). Inside the `withTransaction` callback, AFTER the existing `DELETE FROM paper_trade_pro.watchlist` and BEFORE the `INSERT INTO paper_trade_pro.accounts ...` block, add:

```typescript
      await client.query(
        `DELETE FROM paper_trade_pro.equity_snapshots WHERE user_id = $1`,
        [userId],
      );
```

Then, AFTER the final `for (const sym of DEFAULT_WATCHLIST)` loop and BEFORE `return this.getPortfolioInTx(client, userId)`, add:

```typescript
      // Seed a single starting snapshot at the new initial cash so the chart
      // has at least one point to render from t=now onward.
      await this.recordEquitySnapshot(client, userId, amount, amount, 0);
```

- [ ] **Step 5: Add `getHistory(userId, range)` public method**

Still in `PortfolioStore.ts`, add this method after `resetFunds` (and before the `// ---- Internals` comment):

```typescript
  /**
   * Fetch equity snapshots for a user, oldest first, filtered by `range`.
   *   1M  — last 31 days
   *   3M  — last 93 days
   *   YTD — from Jan 1 of the current calendar year (server tz-agnostic; uses UTC)
   *   ALL — every snapshot
   */
  async getHistory(
    userId: string,
    range: string,
  ): Promise<{ t: number; p: number }[]> {
    let where = `user_id = $1`;
    const params: unknown[] = [userId];
    if (range === '1M') {
      where += ` AND taken_at >= now() - interval '31 days'`;
    } else if (range === '3M') {
      where += ` AND taken_at >= now() - interval '93 days'`;
    } else if (range === 'YTD') {
      // Anchor YTD to the start of the calendar year in UTC. Per CLAUDE.md
      // the server is timezone-ignorant; UTC is the deterministic choice.
      where += ` AND taken_at >= (date_trunc('year', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
    }
    // ALL: no extra filter.

    const res = await this.pool.query<{ taken_at: Date; equity: number }>(
      `SELECT taken_at, equity
         FROM paper_trade_pro.equity_snapshots
        WHERE ${where}
        ORDER BY taken_at ASC`,
      params,
    );
    return res.rows.map((r) => ({ t: r.taken_at.getTime(), p: r.equity }));
  }
```

The route handler (Task 5) is responsible for typing the `range` parameter via `isHistoryRange` before calling this method, but we keep the type wide here so the store stays the boundary that the route validates against. (Application-code enum check, per user direction.)

- [ ] **Step 6: Verify the backend type-checks**

```bash
cd /Users/chongbei/Workspace/personal/paper_trade_pro/backend && npx tsc --noEmit && echo BACKEND_TS_OK
```

Expected: prints `BACKEND_TS_OK` and no errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/store/PortfolioStore.ts
git commit -m "feat(store): write equity_snapshots on fill/reset; add getHistory(range)"
```

---

## Task 4: EquitySnapshotter — periodic in-process job

**Files:**
- Create: `backend/src/services/EquitySnapshotter.ts`
- Modify: `backend/src/config.ts`

The snapshotter values every active account against the live `QuoteCache` and writes one row per user every `intervalMs`. We do this in-process (no external scheduler) so the developer setup stays one `npm run dev`.

- [ ] **Step 1: Add `historySnapshotIntervalMs` to config**

Open `backend/src/config.ts`. In the `AppConfig` interface (around line 119–145), after `initialCash: number;` add:

```typescript
  /** How often the EquitySnapshotter writes a snapshot per user, in ms.
   *  Set to 0 to disable the periodic job (fill-time snapshots still write). */
  historySnapshotIntervalMs: number;
```

In the `loadConfig()` body (around line 169), after the `initialCash:` line, add:

```typescript
    historySnapshotIntervalMs: Number(
      optionalEnv('EQUITY_SNAPSHOT_INTERVAL_MS') ?? 60_000,
    ),
```

- [ ] **Step 2: Create the snapshotter service**

Create `backend/src/services/EquitySnapshotter.ts` with this exact content:

```typescript
import { getLogger } from '@chongbei/web-basics/server';
import type { Pool } from 'pg';
import { getPool } from '../db';
import type { QuoteCache } from './QuoteCache';

const log = getLogger('services.EquitySnapshotter');

// -----------------------------------------------------------------------------
// EquitySnapshotter — periodic in-process job that writes one
// equity_snapshots row per active user. "Active" = has any positions OR has
// non-default cash (i.e. has been touched by the user). For each active
// user we read positions, look up live prices via QuoteCache.peek(), and
// compute equity = cash + sum(qty * livePrice for long) + sum(qty *
// (avg_price - livePrice) added to cash already on short open … see below).
//
// Pricing rule: for long positions, market value = qty * livePrice. For
// short positions, market value contribution = qty * livePrice (because the
// initial proceeds were credited to cash on the short-open; the liability
// to buy back at livePrice is the negative side). Net equity is therefore:
//   equity = cash + Σ_long(qty*livePrice) - Σ_short(qty*livePrice)
//                                                          + Σ_short(qty*avgPrice)
//          = cash + Σ_long(qty*livePrice) + Σ_short(qty*(avgPrice - livePrice))
// which matches usePortfolio.ts's frontend calc (lines 107–132).
//
// If a position's symbol has no cached quote (cache miss / stale before
// first tick), we fall back to its avg_price so the snapshot is never
// fabricated and never NaN.
// -----------------------------------------------------------------------------

interface ActiveUserRow {
  user_id: string;
  cash: number;
}
interface PositionRow {
  user_id: string;
  ticker: string;
  side: string;
  qty: number;
  avg_price: number;
}

export class EquitySnapshotter {
  private timer: NodeJS.Timeout | null = null;
  private readonly pool: Pool;

  constructor(
    private readonly cache: QuoteCache,
    private readonly intervalMs: number,
  ) {
    this.pool = getPool();
  }

  start(): void {
    if (this.intervalMs <= 0) {
      log.info(
        { intervalMs: this.intervalMs },
        'EquitySnapshotter disabled (interval <= 0)',
      );
      return;
    }
    if (this.timer) return;
    log.info({ intervalMs: this.intervalMs }, 'EquitySnapshotter starting');
    // Fire once on start so a fresh server immediately backfills a point.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Don't keep the event loop alive on shutdown.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info('EquitySnapshotter stopped');
    }
  }

  /**
   * Public for tests + manual triggers. Each iteration:
   *   1. Read all account rows (one row per user).
   *   2. Read all positions in one query.
   *   3. Group positions by user_id, value at live price (or avg_price
   *      fallback), insert one snapshot per user.
   * The whole batch is wrapped in a single transaction-less fan-out to
   * keep the scheduler resilient — a single user's failure doesn't block
   * the others.
   */
  async tick(): Promise<void> {
    let users: ActiveUserRow[] = [];
    try {
      const r = await this.pool.query<ActiveUserRow>(
        `SELECT user_id, cash FROM paper_trade_pro.accounts`,
      );
      users = r.rows;
    } catch (err) {
      log.error(
        { err, operation: 'snapshotter.readAccounts' },
        'ERROR EquitySnapshotter failed reading accounts',
      );
      return;
    }
    if (users.length === 0) return;

    let positions: PositionRow[] = [];
    try {
      const r = await this.pool.query<PositionRow>(
        `SELECT user_id, ticker, side, qty, avg_price
           FROM paper_trade_pro.positions`,
      );
      positions = r.rows;
    } catch (err) {
      log.error(
        { err, operation: 'snapshotter.readPositions' },
        'ERROR EquitySnapshotter failed reading positions',
      );
      return;
    }

    const byUser = new Map<string, PositionRow[]>();
    for (const p of positions) {
      const arr = byUser.get(p.user_id);
      if (arr) arr.push(p);
      else byUser.set(p.user_id, [p]);
    }

    for (const u of users) {
      try {
        const userPositions = byUser.get(u.user_id) ?? [];
        let marketValue = 0;
        let equity = u.cash;
        for (const pos of userPositions) {
          const q = this.cache.peek(pos.ticker);
          const livePrice =
            q && Number.isFinite(q.price) && q.price > 0
              ? q.price
              : pos.avg_price;
          if (pos.side === 'long') {
            marketValue += pos.qty * livePrice;
            equity += pos.qty * livePrice;
          } else {
            // short: avg_price - livePrice times qty added to cash-baseline.
            marketValue += pos.qty * livePrice;
            equity += pos.qty * (pos.avg_price - livePrice);
          }
        }
        await this.pool.query(
          `INSERT INTO paper_trade_pro.equity_snapshots
             (user_id, equity, cash, market_value)
           VALUES ($1, $2, $3, $4)`,
          [u.user_id, equity, u.cash, marketValue],
        );
      } catch (err) {
        // Never let one user's failure stop the rest.
        log.error(
          { err, userId: u.user_id, operation: 'snapshotter.writeSnapshot' },
          'ERROR EquitySnapshotter failed writing user snapshot',
        );
      }
    }
  }
}
```

- [ ] **Step 3: Wire the snapshotter into `server.ts`**

Open `backend/src/server.ts`. Add this import next to the other service imports (after the `import { PriceStreamHub } from './services/PriceStreamHub';` line, around line 50):

```typescript
import { EquitySnapshotter } from "./services/EquitySnapshotter";
```

Then in `main()`, AFTER the `const portfolioStore = new PortfolioStore({ initialCash: cfg.initialCash });` line and the `app.use("/api", createPortfolioRouter(...))` block (so it sits next to the other service constructions, around line 106), add:

```typescript
  const snapshotter = new EquitySnapshotter(
    cache,
    cfg.historySnapshotIntervalMs,
  );
  snapshotter.start();
```

In the `shutdown` function (around line 138), AFTER `server.close();` and BEFORE `await closePool().catch(...)`, add:

```typescript
    snapshotter.stop();
```

- [ ] **Step 4: Verify the backend type-checks**

```bash
cd /Users/chongbei/Workspace/personal/paper_trade_pro/backend && npx tsc --noEmit && echo BACKEND_TS_OK
```

Expected: prints `BACKEND_TS_OK`.

- [ ] **Step 5: Smoke-test the snapshotter against your dev DB**

Start the backend. The user runs:

```bash
cd /Users/chongbei/Workspace/personal/paper_trade_pro/backend && npm run dev
```

Wait ~70 seconds (one tick + a buffer). Then in psql:

```sql
SELECT user_id, taken_at, equity, cash, market_value
  FROM paper_trade_pro.equity_snapshots
  ORDER BY taken_at DESC LIMIT 5;
```

Expected: at least one row per active user, with `equity = cash + market_value` (within rounding). Stop the backend (Ctrl+C). The log should print `EquitySnapshotter stopped` from the SIGINT handler.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/EquitySnapshotter.ts backend/src/server.ts backend/src/config.ts
git commit -m "feat(backend): add EquitySnapshotter periodic job + wire into server lifecycle"
```

---

## Task 5: Add GET /api/portfolio/history route

**Files:**
- Modify: `backend/src/routes/portfolio.ts`

The route validates `range` against `isHistoryRange` (application-side enum check) and delegates to `store.getHistory`.

- [ ] **Step 1: Update the import block**

Open `backend/src/routes/portfolio.ts`. Find the `import type { ... } from "../../../shared/src";` block (currently around line 16–24). Add `HistoryRange` and `PortfolioHistoryResponse` to it, AND add a value import for `isHistoryRange`. Replace that block with:

```typescript
import type {
  AddAlertInput,
  FillOrderInput,
  HistoryRange,
  PlaceOrderInput,
  PortfolioHistoryResponse,
  ResetFundsInput,
  ToggleWatchInput,
  TriggerAlertInput,
  UpdatePeakInput,
} from "../../../shared/src";
import { isHistoryRange } from "../../../shared/src";
```

- [ ] **Step 2: Add the route handler**

In the same file, find the `// POST /api/portfolio/reset` block (currently around line 290–304). IMMEDIATELY BEFORE that comment, insert:

```typescript
  // GET /api/portfolio/history?range=1M|3M|YTD|ALL
  router.get("/portfolio/history", async (req: Request, res: Response) => {
    try {
      const raw = req.query.range;
      const rangeStr = typeof raw === "string" ? raw : "1M";
      if (!isHistoryRange(rangeStr)) {
        return res
          .status(400)
          .json({ error: `invalid range "${rangeStr}"` });
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
```

- [ ] **Step 3: Verify the backend type-checks**

```bash
cd /Users/chongbei/Workspace/personal/paper_trade_pro/backend && npx tsc --noEmit && echo BACKEND_TS_OK
```

Expected: prints `BACKEND_TS_OK`.

- [ ] **Step 4: Smoke-test the route**

With the backend running, the user runs (replace `<BACKEND_URL>` with whatever ports.cjs declares — typically `http://localhost:4000`):

```bash
curl -sS "http://localhost:4000/api/portfolio/history?range=1M" | head -c 400
echo
curl -sS "http://localhost:4000/api/portfolio/history?range=BAD" -o /dev/null -w "%{http_code}\n"
```

Expected:
- First call: JSON `{"range":"1M","points":[{"t":...,"p":...},...]}`
- Second call: `400`

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/portfolio.ts
git commit -m "feat(api): add GET /api/portfolio/history?range=1M|3M|YTD|ALL"
```

---

## Task 6: Frontend — fetch real history and wire range buttons

**Files:**
- Modify: `frontend/src/lib/portfolioClient.ts`
- Modify: `frontend/src/pages/DashboardPage.tsx`

- [ ] **Step 1: Add `getHistory` to the portfolio client**

Open `frontend/src/lib/portfolioClient.ts`. In the `import type { ... } from "../../../shared/src";` block at the top, add `HistoryRange` and `PortfolioHistoryResponse`:

```typescript
import type {
  AddAlertInput,
  FillOrderInput,
  HistoryRange,
  PlaceOrderInput,
  Portfolio,
  PortfolioHistoryResponse,
  ResetFundsInput,
  ToggleWatchInput,
  TriggerAlertInput,
} from "../../../shared/src";
```

Then inside the `portfolioClient` object literal, add this method (insert next to `get()` at the top):

```typescript
  getHistory(range: HistoryRange): Promise<PortfolioHistoryResponse> {
    return api<PortfolioHistoryResponse>(
      url(`/api/portfolio/history?range=${encodeURIComponent(range)}`),
    );
  },
```

- [ ] **Step 2: Replace the synthetic chart in DashboardPage**

Open `frontend/src/pages/DashboardPage.tsx`. At the top of the file, replace the existing imports block (lines 1–14) with:

```typescript
import { useEffect, useMemo, useState } from 'react';
import { dayChangePct } from '../lib/quote';
import { fmtMoney, fmtPct } from '../lib/format';
import { PriceChart, type PriceChartPoint } from '../components/PriceChart';
import { PriceCell } from '../components/PriceCell';
import { Sparkline } from '../components/Sparkline';
import { Empty } from '../components/Empty';
import { portfolioClient } from '../lib/portfolioClient';
import type { HistoryRange } from '../../../shared/src';
import type {
  Market,
  PageKey,
  Portfolio,
  TradeCtx,
  Valuation,
} from '../lib/types';
```

Then DELETE the entire synthetic-history block (currently lines 36–47):

```typescript
  const equityHist = useMemo(() => {
    const arr = Array.from({ length: 60 }, (_, i) => {
      const t = i / 60;
      return (
        initialCash *
        (1 + (totalPct / 100) * t + Math.sin(i / 6) * 0.003)
      );
    });
    arr[arr.length - 1] = totalValue;
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalValue, initialCash]);
```

In its place, insert this block immediately after the `const dayPct = ...;` line (currently line 34):

```typescript
  const [range, setRange] = useState<HistoryRange>('1M');
  const [historyPoints, setHistoryPoints] = useState<PriceChartPoint[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    portfolioClient
      .getHistory(range)
      .then((res) => {
        if (cancelled) return;
        // Server already orders ASC; map the wire shape directly.
        setHistoryPoints(res.points.map((pt) => ({ t: pt.t, p: pt.p })));
        setHistoryError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // CLAUDE.md rule 4/10: do not silently swallow.
        // eslint-disable-next-line no-console
        console.error('ERROR DashboardPage.getHistory failed', {
          err,
          range,
        });
        setHistoryError(msg);
      });
    return () => {
      cancelled = true;
    };
    // We intentionally append a synthetic "now" point below in render so that
    // the chart's right edge always reflects the live equity even between
    // server snapshots — re-fetching on totalValue change would be wasteful.
  }, [range]);

  // Append a "now" point so the rightmost edge tracks the live equity
  // (server snapshots arrive at intervalMs cadence; this keeps the line
  // current without re-querying the API on every tick).
  const chartPoints = useMemo<PriceChartPoint[]>(() => {
    if (historyPoints.length === 0) {
      return [{ t: Date.now(), p: totalValue }];
    }
    const last = historyPoints[historyPoints.length - 1];
    if (last && Date.now() - last.t < 5_000) return historyPoints;
    return [...historyPoints, { t: Date.now(), p: totalValue }];
  }, [historyPoints, totalValue]);
```

Then find the segmented buttons block (currently lines 136–141):

```tsx
            <div className="segmented">
              <button className="active">1M</button>
              <button>3M</button>
              <button>YTD</button>
              <button>ALL</button>
            </div>
```

Replace with:

```tsx
            <div className="segmented">
              {(['1M', '3M', 'YTD', 'ALL'] as const).map((r) => (
                <button
                  key={r}
                  className={range === r ? 'active' : ''}
                  onClick={() => setRange(r)}
                >
                  {r}
                </button>
              ))}
            </div>
```

Finally, find the chart render (currently `<PriceChart data={equityHist} height={260} />`, around line 144) and replace with:

```tsx
            <PriceChart points={chartPoints} height={260} />
            {historyError && (
              <div
                style={{
                  color: 'var(--down)',
                  fontSize: 12,
                  padding: '0 18px 12px',
                }}
              >
                Couldn’t load history: {historyError}
              </div>
            )}
```

- [ ] **Step 3: Verify the frontend type-checks**

```bash
cd /Users/chongbei/Workspace/personal/paper_trade_pro/frontend && npx tsc --noEmit && echo FRONTEND_TS_OK
```

Expected: prints `FRONTEND_TS_OK`. If it complains that `PriceChart`'s `PriceChartPoint` isn't exported, change the import in Step 2 to `import { PriceChart } from '../components/PriceChart';` and inline the local type:

```typescript
type PriceChartPoint = { t: number; p: number };
```

(`PriceChart.tsx` already exports `PriceChartPoint`, so this fallback is only if a tsconfig edge case bites.)

- [ ] **Step 4: Smoke-test in the browser**

The user runs the app:

```bash
cd /Users/chongbei/Workspace/personal/paper_trade_pro/frontend && npm run dev
```

Open the dashboard. Verify:
1. The chart renders. With a freshly migrated DB it may show 1–2 points until the snapshotter fires (default 60s).
2. Clicking 1M / 3M / YTD / ALL changes the active style and re-fetches (Network tab should show `GET /api/portfolio/history?range=...`).
3. Place a market order via the Trade modal. Refresh the chart's range — a new point appears at the fill timestamp.
4. Use the dev "Reset funds" action. The chart drops to a single starting point at the new cash.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/portfolioClient.ts frontend/src/pages/DashboardPage.tsx
git commit -m "feat(dashboard): replace synthetic Portfolio-value curve with real history + working range buttons"
```

---

## Task 7: Final cleanup + smoke pass

- [ ] **Step 1: Re-read the dashboard page once for stragglers**

Open `frontend/src/pages/DashboardPage.tsx`. Confirm:
- No remaining reference to `equityHist` (search the whole file).
- The `useMemo` import is still used somewhere (it should be — `topMovers`, `chartPoints`).
- No unused imports left over from the synthetic block.

If you see a leftover that the type-check missed (e.g. an unused `useMemo` will trigger `noUnusedLocals` if enabled), delete it.

- [ ] **Step 2: End-to-end backend + frontend type-check**

```bash
cd /Users/chongbei/Workspace/personal/paper_trade_pro/backend && npx tsc --noEmit && echo BACKEND_OK \
  && cd ../frontend && npx tsc --noEmit && echo FRONTEND_OK
```

Expected: both `BACKEND_OK` and `FRONTEND_OK`.

- [ ] **Step 3: Manual end-to-end test**

With backend + frontend running:

1. Reset funds → chart shows a single point at $100,000 (or whatever `INITIAL_CASH` is).
2. Buy a market order → chart now shows two points (start + fill).
3. Wait `EQUITY_SNAPSHOT_INTERVAL_MS` (default 60s) → a third point appears, equity tracking the live price.
4. Switch to ALL → all three points visible.
5. Switch to 3M → still 3 points (they're inside the window).
6. Restart backend → chart still loads same data; snapshots resume on the next tick.

- [ ] **Step 4: Final commit (only if Step 1 produced edits)**

If Step 1 found stragglers and you edited the file:

```bash
git add frontend/src/pages/DashboardPage.tsx
git commit -m "chore(dashboard): drop unused symbols from synthetic chart removal"
```

Otherwise, skip this step.

---

## Self-Review Checklist (already applied)

- **Spec coverage:** real data ✅ (Tasks 3+4), 1M/3M/YTD/ALL functional ✅ (Tasks 5+6), DDL file ✅ (Task 1), reset behavior ✅ (Task 3 Step 4 wipes + reseeds), enum central place ✅ (Task 2 in `shared/src/contracts/portfolio.ts`), application-only enum check ✅ (`isHistoryRange` in route handler, no DB CHECK).
- **Placeholder scan:** no TODOs / "implement later" / vague "add validation". Every code block is the actual content to paste.
- **Type consistency:** `HistoryRange`, `EquityPoint`, `PortfolioHistoryResponse` are defined once in shared and imported by name in backend route, store, and frontend client. `getHistory` returns `{ t: number; p: number }[]` from the store and the route wraps it in `PortfolioHistoryResponse`. `PriceChartPoint` (existing) shares the same `{ t, p }` shape so the frontend can pass through without a mapper.
