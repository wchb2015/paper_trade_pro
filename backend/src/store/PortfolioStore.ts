import type { Pool, PoolClient } from 'pg';
import type {
  AddAlertInput,
  Alert,
  ConditionalOp,
  Order,
  OrderSide,
  OrderStatus,
  PlaceOrderInput,
  Portfolio,
  Position,
  PositionSide,
} from '../../../shared/src';
import {
  isAlertCondition,
  isConditionalOp,
  isOrderSide,
  isOrderType,
  isTimeInForce,
} from '../../../shared/src';
import { DEFAULT_WATCHLIST } from '../../../shared/src';
import { getPool, withTransaction } from '../db';

// -----------------------------------------------------------------------------
// PortfolioStore — all Postgres reads/writes for a single user's portfolio.
//
// The database is source of truth. The frontend sends high-level intents
// (placeOrder, fillOrder, toggleWatch, …); this store translates each intent
// into the right SQL inside a transaction and returns the refreshed Portfolio
// so the client can replace its state atomically.
//
// Conventions:
// - All timestamps round-trip as epoch-ms (number) at the wire boundary.
//   Inside this file we convert to/from Date at the SQL edge.
// - Every method takes userId explicitly; no ambient "current user".
// - Enum-like TEXT columns are validated in app code via the shared guards
//   (isOrderSide, isOrderType, …) so we fail fast on bad DB rows too.
// - Working orders live in the `orders` table with status IN
//   ('pending','pending_fill'). Terminal orders stay in the same table with
//   status IN ('filled','cancelled'); the GET returns them as `history`.
// -----------------------------------------------------------------------------

const HISTORY_LIMIT = 200;

// ---- row → domain conversions ----------------------------------------------

interface OrderRow {
  id: string;
  user_id: string;
  ticker: string;
  side: string;
  type: string;
  qty: number;
  tif: string;
  status: string;
  created_at: Date;
  limit_price: number | null;
  stop_price: number | null;
  trail_pct: number | null;
  peak: number | null;
  cond_ticker: string | null;
  cond_op: string | null;
  cond_price: number | null;
  inner_type: string | null;
  filled_at: Date | null;
  cancelled_at: Date | null;
  fill_price: number | null;
}

function rowToOrder(row: OrderRow): Order {
  if (!isOrderSide(row.side)) {
    throw new Error(`orders.side has invalid value "${row.side}"`);
  }
  if (!isOrderType(row.type)) {
    throw new Error(`orders.type has invalid value "${row.type}"`);
  }
  if (!isTimeInForce(row.tif)) {
    throw new Error(`orders.tif has invalid value "${row.tif}"`);
  }
  const statusValues: OrderStatus[] = [
    'pending',
    'pending_fill',
    'filled',
    'cancelled',
  ];
  if (!statusValues.includes(row.status as OrderStatus)) {
    throw new Error(`orders.status has invalid value "${row.status}"`);
  }

  const order: Order = {
    id: row.id,
    ticker: row.ticker,
    side: row.side,
    type: row.type,
    qty: row.qty,
    tif: row.tif,
    status: row.status as OrderStatus,
    createdAt: row.created_at.getTime(),
  };
  if (row.limit_price != null) order.limitPrice = row.limit_price;
  if (row.stop_price != null) order.stopPrice = row.stop_price;
  if (row.trail_pct != null) order.trailPct = row.trail_pct;
  if (row.peak != null) order.peak = row.peak;
  if (row.cond_ticker && row.cond_op && row.cond_price != null) {
    if (!isConditionalOp(row.cond_op)) {
      throw new Error(`orders.cond_op has invalid value "${row.cond_op}"`);
    }
    order.condTrigger = {
      ticker: row.cond_ticker,
      op: row.cond_op,
      price: row.cond_price,
    };
  }
  if (row.inner_type) {
    if (!isOrderType(row.inner_type)) {
      throw new Error(
        `orders.inner_type has invalid value "${row.inner_type}"`,
      );
    }
    order.innerType = row.inner_type;
  }
  if (row.filled_at) order.filledAt = row.filled_at.getTime();
  if (row.cancelled_at) order.cancelledAt = row.cancelled_at.getTime();
  if (row.fill_price != null) order.fillPrice = row.fill_price;

  return order;
}

interface PositionRow {
  id: string;
  ticker: string;
  side: string;
  qty: number;
  avg_price: number;
  opened_at: Date;
}

function rowToPosition(row: PositionRow): Position {
  if (row.side !== 'long' && row.side !== 'short') {
    throw new Error(`positions.side has invalid value "${row.side}"`);
  }
  return {
    id: row.id,
    ticker: row.ticker,
    side: row.side,
    qty: row.qty,
    avgPrice: row.avg_price,
    openedAt: row.opened_at.getTime(),
  };
}

interface AlertRow {
  id: string;
  ticker: string;
  condition: string;
  price: number;
  active: boolean;
  note: string | null;
  created_at: Date;
  triggered_at: Date | null;
  triggered_price: number | null;
}

function rowToAlert(row: AlertRow): Alert {
  if (!isAlertCondition(row.condition)) {
    throw new Error(`alerts.condition has invalid value "${row.condition}"`);
  }
  const a: Alert = {
    id: row.id,
    ticker: row.ticker,
    condition: row.condition,
    price: row.price,
    active: row.active,
    createdAt: row.created_at.getTime(),
  };
  if (row.note) a.note = row.note;
  if (row.triggered_at) a.triggeredAt = row.triggered_at.getTime();
  if (row.triggered_price != null) a.triggeredPrice = row.triggered_price;
  return a;
}

// ---- helpers ---------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function ensurePositiveInt(label: string, n: number): void {
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`${label} must be a positive integer, got ${n}`);
  }
}

function ensurePositiveNumber(label: string, n: number): void {
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} must be a positive number, got ${n}`);
  }
}

function matchingPositionSide(side: OrderSide): PositionSide {
  return side === 'buy' || side === 'sell' ? 'long' : 'short';
}

// ---- the store -------------------------------------------------------------

export class PortfolioStore {
  private readonly pool: Pool;
  private readonly initialCash: number;

  constructor(opts: { initialCash: number }) {
    this.pool = getPool();
    this.initialCash = opts.initialCash;
  }

  // -------------------------------------------------------------------------
  // Read path
  // -------------------------------------------------------------------------

  async getPortfolio(userId: string): Promise<Portfolio> {
    // Self-provision the account row on first read. This keeps the API
    // shape unchanged for clients when we later add real signup.
    await this.ensureAccount(userId);

    const [acct, positions, workingOrders, historyOrders, alerts, watchlist] =
      await Promise.all([
        this.pool.query<{ cash: number; initial_cash: number }>(
          'SELECT cash, initial_cash FROM paper_trade_pro.accounts WHERE user_id = $1',
          [userId],
        ),
        this.pool.query<PositionRow>(
          `SELECT id, ticker, side, qty, avg_price, opened_at
             FROM paper_trade_pro.positions
            WHERE user_id = $1
            ORDER BY opened_at DESC`,
          [userId],
        ),
        this.pool.query<OrderRow>(
          `SELECT * FROM paper_trade_pro.orders
            WHERE user_id = $1
              AND status IN ('pending', 'pending_fill')
            ORDER BY created_at DESC`,
          [userId],
        ),
        this.pool.query<OrderRow>(
          `SELECT * FROM paper_trade_pro.orders
            WHERE user_id = $1
              AND status IN ('filled', 'cancelled')
            ORDER BY COALESCE(filled_at, cancelled_at, created_at) DESC
            LIMIT $2`,
          [userId, HISTORY_LIMIT],
        ),
        this.pool.query<AlertRow>(
          `SELECT id, ticker, condition, price, active, note,
                  created_at, triggered_at, triggered_price
             FROM paper_trade_pro.alerts
            WHERE user_id = $1
            ORDER BY created_at DESC`,
          [userId],
        ),
        this.pool.query<{ ticker: string }>(
          `SELECT ticker FROM paper_trade_pro.watchlist
            WHERE user_id = $1
            ORDER BY added_at ASC`,
          [userId],
        ),
      ]);

    const acctRow = acct.rows[0];
    if (!acctRow) {
      // ensureAccount just inserted — should always be present.
      throw new Error(`accounts row missing for user_id=${userId}`);
    }

    return {
      cash: acctRow.cash,
      initialCash: acctRow.initial_cash,
      positions: positions.rows.map(rowToPosition),
      orders: workingOrders.rows.map(rowToOrder),
      alerts: alerts.rows.map(rowToAlert),
      watchlist: watchlist.rows.map((r) => r.ticker),
      history: historyOrders.rows.map(rowToOrder),
    };
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  /**
   * Place an order. For `type === 'market'`, the caller must pass
   * `fillPrice` (client reads the current ask/bid). Everything runs in one
   * transaction: INSERT the order, then — if market — UPDATE to filled,
   * adjust positions, adjust cash.
   *
   * For non-market orders we just INSERT with status='pending'; the fill
   * loop on the client drives subsequent /fill calls when the trigger hits.
   */
  async placeOrder(userId: string, input: PlaceOrderInput): Promise<Portfolio> {
    await this.ensureAccount(userId);

    if (!isOrderSide(input.side))
      throw new Error(`invalid side "${String(input.side)}"`);
    if (!isOrderType(input.type))
      throw new Error(`invalid type "${String(input.type)}"`);
    if (!isTimeInForce(input.tif))
      throw new Error(`invalid tif "${String(input.tif)}"`);
    ensurePositiveInt('qty', input.qty);

    // Structural checks mirroring the DB's CHECK constraints. We duplicate
    // them here so we can return a friendly 400 instead of a raw 23514.
    if (input.type === 'limit' || input.type === 'stop_limit') {
      if (input.limitPrice == null)
        throw new Error(`${input.type} orders require limitPrice`);
      ensurePositiveNumber('limitPrice', input.limitPrice);
    }
    if (input.type === 'stop' || input.type === 'stop_limit') {
      if (input.stopPrice == null)
        throw new Error(`${input.type} orders require stopPrice`);
      ensurePositiveNumber('stopPrice', input.stopPrice);
    }
    if (input.type === 'trailing_stop') {
      if (input.trailPct == null)
        throw new Error(`trailing_stop orders require trailPct`);
      ensurePositiveNumber('trailPct', input.trailPct);
    }
    if (input.type === 'conditional') {
      if (!input.condTrigger)
        throw new Error(`conditional orders require condTrigger`);
      if (!isConditionalOp(input.condTrigger.op))
        throw new Error(`invalid condTrigger.op "${input.condTrigger.op}"`);
      ensurePositiveNumber('condTrigger.price', input.condTrigger.price);
    }
    if (input.type === 'market') {
      if (input.fillPrice == null)
        throw new Error(`market orders require fillPrice`);
      ensurePositiveNumber('fillPrice', input.fillPrice);
    }

    const ticker = input.ticker.toUpperCase();

    return withTransaction(async (client) => {
      const initialStatus: OrderStatus =
        input.type === 'market' ? 'pending_fill' : 'pending';

      const condTicker = input.condTrigger?.ticker.toUpperCase() ?? null;
      const condOp: ConditionalOp | null = input.condTrigger?.op ?? null;
      const condPrice = input.condTrigger?.price ?? null;

      const inserted = await client.query<OrderRow>(
        `INSERT INTO paper_trade_pro.orders (
           user_id, ticker, side, type, qty, tif, status,
           limit_price, stop_price, trail_pct, peak,
           cond_ticker, cond_op, cond_price, inner_type
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11,
           $12, $13, $14, $15
         )
         RETURNING *`,
        [
          userId,
          ticker,
          input.side,
          input.type,
          input.qty,
          input.tif,
          initialStatus,
          input.limitPrice ?? null,
          input.stopPrice ?? null,
          input.trailPct ?? null,
          // Seed peak to fillPrice-ish reference; the client refines on
          // each tick, but a non-null starting peak keeps the SQL simple.
          input.type === 'trailing_stop' ? (input.fillPrice ?? null) : null,
          condTicker,
          condOp,
          condPrice,
          input.innerType ?? null,
        ],
      );

      const orderRow = inserted.rows[0];
      if (!orderRow) throw new Error('failed to insert order');

      if (input.type === 'market') {
        await this.applyFill(client, userId, orderRow.id, input.fillPrice!);
      }

      return this.getPortfolioInTx(client, userId);
    });
  }

  async cancelOrder(userId: string, orderId: string): Promise<Portfolio> {
    return withTransaction(async (client) => {
      const res = await client.query(
        `UPDATE paper_trade_pro.orders
            SET status = 'cancelled',
                cancelled_at = now()
          WHERE user_id = $1
            AND id = $2
            AND status IN ('pending', 'pending_fill')`,
        [userId, orderId],
      );
      if (res.rowCount === 0) {
        throw new Error(`order ${orderId} not found or not cancellable`);
      }
      return this.getPortfolioInTx(client, userId);
    });
  }

  async fillOrder(
    userId: string,
    orderId: string,
    fillPrice: number,
  ): Promise<Portfolio> {
    ensurePositiveNumber('fillPrice', fillPrice);
    return withTransaction(async (client) => {
      await this.applyFill(client, userId, orderId, fillPrice);
      return this.getPortfolioInTx(client, userId);
    });
  }

  async updateTrailingPeak(
    userId: string,
    orderId: string,
    peak: number,
  ): Promise<Portfolio> {
    ensurePositiveNumber('peak', peak);
    // Not transactional — a single row update. Still scope by user_id.
    const res = await this.pool.query(
      `UPDATE paper_trade_pro.orders
          SET peak = $3
        WHERE user_id = $1
          AND id = $2
          AND status IN ('pending', 'pending_fill')
          AND type = 'trailing_stop'`,
      [userId, orderId, peak],
    );
    if (res.rowCount === 0) {
      throw new Error(`trailing_stop order ${orderId} not found`);
    }
    return this.getPortfolio(userId);
  }

  // -------------------------------------------------------------------------
  // Alerts
  // -------------------------------------------------------------------------

  async addAlert(userId: string, input: AddAlertInput): Promise<Portfolio> {
    await this.ensureAccount(userId);
    if (!isAlertCondition(input.condition))
      throw new Error(`invalid condition "${String(input.condition)}"`);
    ensurePositiveNumber('price', input.price);

    await this.pool.query(
      `INSERT INTO paper_trade_pro.alerts
         (user_id, ticker, condition, price, active, note)
       VALUES ($1, $2, $3, $4, true, $5)`,
      [
        userId,
        input.ticker.toUpperCase(),
        input.condition,
        input.price,
        input.note ?? null,
      ],
    );
    return this.getPortfolio(userId);
  }

  async toggleAlert(userId: string, alertId: string): Promise<Portfolio> {
    const res = await this.pool.query(
      `UPDATE paper_trade_pro.alerts
          SET active = NOT active
        WHERE user_id = $1 AND id = $2`,
      [userId, alertId],
    );
    if (res.rowCount === 0) throw new Error(`alert ${alertId} not found`);
    return this.getPortfolio(userId);
  }

  async removeAlert(userId: string, alertId: string): Promise<Portfolio> {
    const res = await this.pool.query(
      `DELETE FROM paper_trade_pro.alerts
        WHERE user_id = $1 AND id = $2`,
      [userId, alertId],
    );
    if (res.rowCount === 0) throw new Error(`alert ${alertId} not found`);
    return this.getPortfolio(userId);
  }

  async markAlertTriggered(
    userId: string,
    alertId: string,
    price: number,
  ): Promise<Portfolio> {
    ensurePositiveNumber('price', price);
    const res = await this.pool.query(
      `UPDATE paper_trade_pro.alerts
          SET triggered_at = now(),
              triggered_price = $3
        WHERE user_id = $1
          AND id = $2
          AND triggered_at IS NULL`,
      [userId, alertId, price],
    );
    if (res.rowCount === 0) {
      throw new Error(`alert ${alertId} not found or already triggered`);
    }
    return this.getPortfolio(userId);
  }

  // -------------------------------------------------------------------------
  // Watchlist
  // -------------------------------------------------------------------------

  async toggleWatch(userId: string, ticker: string): Promise<Portfolio> {
    await this.ensureAccount(userId);
    const sym = ticker.toUpperCase();
    // Try delete-first; if nothing was removed, it's an add.
    const del = await this.pool.query(
      `DELETE FROM paper_trade_pro.watchlist
        WHERE user_id = $1 AND ticker = $2`,
      [userId, sym],
    );
    if (del.rowCount === 0) {
      await this.pool.query(
        `INSERT INTO paper_trade_pro.watchlist (user_id, ticker)
         VALUES ($1, $2)
         ON CONFLICT (user_id, ticker) DO NOTHING`,
        [userId, sym],
      );
    }
    return this.getPortfolio(userId);
  }

  // -------------------------------------------------------------------------
  // Reset (development convenience — wipes positions/orders/alerts/watchlist)
  // -------------------------------------------------------------------------

  async resetFunds(userId: string, cash?: number): Promise<Portfolio> {
    const amount = cash ?? this.initialCash;
    ensurePositiveNumber('cash', amount);

    return withTransaction(async (client) => {
      await client.query(
        `DELETE FROM paper_trade_pro.positions WHERE user_id = $1`,
        [userId],
      );
      await client.query(
        `DELETE FROM paper_trade_pro.orders WHERE user_id = $1`,
        [userId],
      );
      await client.query(
        `DELETE FROM paper_trade_pro.alerts WHERE user_id = $1`,
        [userId],
      );
      await client.query(
        `DELETE FROM paper_trade_pro.watchlist WHERE user_id = $1`,
        [userId],
      );
      await client.query(
        `INSERT INTO paper_trade_pro.accounts (user_id, cash, initial_cash)
         VALUES ($1, $2, $2)
         ON CONFLICT (user_id) DO UPDATE
           SET cash = EXCLUDED.cash,
               initial_cash = EXCLUDED.initial_cash`,
        [userId, amount],
      );
      for (const sym of DEFAULT_WATCHLIST) {
        await client.query(
          `INSERT INTO paper_trade_pro.watchlist (user_id, ticker)
           VALUES ($1, $2)
           ON CONFLICT (user_id, ticker) DO NOTHING`,
          [userId, sym],
        );
      }
      return this.getPortfolioInTx(client, userId);
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Self-provision: if the user has no account row yet, insert one with the
   * configured initial cash and seed the default watchlist. Idempotent —
   * races are handled by ON CONFLICT.
   */
  private async ensureAccount(userId: string): Promise<void> {
    const existing = await this.pool.query<{ user_id: string }>(
      `SELECT user_id FROM paper_trade_pro.accounts WHERE user_id = $1`,
      [userId],
    );
    if (existing.rowCount && existing.rowCount > 0) return;

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO paper_trade_pro.accounts (user_id, cash, initial_cash)
         VALUES ($1, $2, $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, this.initialCash],
      );
      for (const sym of DEFAULT_WATCHLIST) {
        await client.query(
          `INSERT INTO paper_trade_pro.watchlist (user_id, ticker)
           VALUES ($1, $2)
           ON CONFLICT (user_id, ticker) DO NOTHING`,
          [userId, sym],
        );
      }
    });
  }

  /**
   * Apply a fill inside an open transaction. Updates the order row, merges
   * into existing positions (or opens new ones), and adjusts cash. Pure —
   * doesn't return the portfolio; callers typically follow with
   * `getPortfolioInTx` to return the refreshed snapshot.
   */
  private async applyFill(
    client: PoolClient,
    userId: string,
    orderId: string,
    fillPrice: number,
  ): Promise<void> {
    // Lock and load the order row. FOR UPDATE prevents two concurrent
    // /fill calls from double-filling.
    const orderRes = await client.query<OrderRow>(
      `SELECT * FROM paper_trade_pro.orders
        WHERE user_id = $1 AND id = $2
        FOR UPDATE`,
      [userId, orderId],
    );
    const orderRow = orderRes.rows[0];
    if (!orderRow) throw new Error(`order ${orderId} not found`);
    if (orderRow.status !== 'pending' && orderRow.status !== 'pending_fill') {
      throw new Error(
        `order ${orderId} is ${orderRow.status}; cannot fill twice`,
      );
    }

    const side = orderRow.side as OrderSide;
    const qty = orderRow.qty;
    const ticker = orderRow.ticker;
    const posSide = matchingPositionSide(side);

    // --- Cash delta ---
    // buy/cover: cash out; sell/short: cash in.
    let cashDelta = 0;
    if (side === 'buy' || side === 'cover') {
      cashDelta = -qty * fillPrice;
    } else {
      cashDelta = qty * fillPrice;
    }

    // --- Positions ---
    // Opening sides: buy → long, short → short. Merge with existing row
    // via weighted-average cost. Upsert using the (user_id,ticker,side)
    // unique index.
    if (side === 'buy' || side === 'short') {
      // Read current row (if any) under lock so the avg_price math is safe.
      const existing = await client.query<{
        qty: number;
        avg_price: number;
      }>(
        `SELECT qty, avg_price
           FROM paper_trade_pro.positions
          WHERE user_id = $1 AND ticker = $2 AND side = $3
          FOR UPDATE`,
        [userId, ticker, posSide],
      );
      const prev = existing.rows[0];
      if (prev) {
        const totalQty = prev.qty + qty;
        const newAvg = round4(
          (prev.qty * prev.avg_price + qty * fillPrice) / totalQty,
        );
        await client.query(
          `UPDATE paper_trade_pro.positions
              SET qty = $4, avg_price = $5
            WHERE user_id = $1 AND ticker = $2 AND side = $3`,
          [userId, ticker, posSide, totalQty, newAvg],
        );
      } else {
        await client.query(
          `INSERT INTO paper_trade_pro.positions
             (user_id, ticker, side, qty, avg_price)
           VALUES ($1, $2, $3, $4, $5)`,
          [userId, ticker, posSide, qty, round4(fillPrice)],
        );
      }
    } else {
      // Closing sides: sell reduces long; cover reduces short. If the user
      // has no matching position, we just no-op on the position side and
      // still let the cash move — mirrors the client-side behavior.
      const existing = await client.query<{
        qty: number;
      }>(
        `SELECT qty FROM paper_trade_pro.positions
          WHERE user_id = $1 AND ticker = $2 AND side = $3
          FOR UPDATE`,
        [userId, ticker, posSide],
      );
      const prev = existing.rows[0];
      if (!prev) {
        // No matching position. Undo the cash delta so we don't make money
        // out of thin air. This is a guardrail; the UI shouldn't offer the
        // action in the first place.
        cashDelta = 0;
      } else {
        const closeQty = Math.min(qty, prev.qty);
        // Scale the cash delta to the actual closed quantity.
        if (closeQty !== qty) {
          const scale = closeQty / qty;
          cashDelta = cashDelta * scale;
        }
        const remaining = prev.qty - closeQty;
        if (remaining <= 0) {
          await client.query(
            `DELETE FROM paper_trade_pro.positions
              WHERE user_id = $1 AND ticker = $2 AND side = $3`,
            [userId, ticker, posSide],
          );
        } else {
          await client.query(
            `UPDATE paper_trade_pro.positions
                SET qty = $4
              WHERE user_id = $1 AND ticker = $2 AND side = $3`,
            [userId, ticker, posSide, remaining],
          );
        }
      }
    }

    // --- Cash ---
    if (cashDelta !== 0) {
      await client.query(
        `UPDATE paper_trade_pro.accounts
            SET cash = ROUND((cash + $2)::numeric, 2)
          WHERE user_id = $1`,
        [userId, round2(cashDelta)],
      );
    }

    // --- Close the order ---
    await client.query(
      `UPDATE paper_trade_pro.orders
          SET status = 'filled',
              filled_at = now(),
              fill_price = $3
        WHERE user_id = $1 AND id = $2`,
      [userId, orderId, round4(fillPrice)],
    );
  }

  /**
   * Same as getPortfolio, but runs on the given transaction client so the
   * caller sees their own writes. Used to return the refreshed state from
   * mutating endpoints in a single round-trip.
   */
  private async getPortfolioInTx(
    client: PoolClient,
    userId: string,
  ): Promise<Portfolio> {
    const [acct, positions, workingOrders, historyOrders, alerts, watchlist] =
      await Promise.all([
        client.query<{ cash: number; initial_cash: number }>(
          'SELECT cash, initial_cash FROM paper_trade_pro.accounts WHERE user_id = $1',
          [userId],
        ),
        client.query<PositionRow>(
          `SELECT id, ticker, side, qty, avg_price, opened_at
             FROM paper_trade_pro.positions
            WHERE user_id = $1
            ORDER BY opened_at DESC`,
          [userId],
        ),
        client.query<OrderRow>(
          `SELECT * FROM paper_trade_pro.orders
            WHERE user_id = $1
              AND status IN ('pending', 'pending_fill')
            ORDER BY created_at DESC`,
          [userId],
        ),
        client.query<OrderRow>(
          `SELECT * FROM paper_trade_pro.orders
            WHERE user_id = $1
              AND status IN ('filled', 'cancelled')
            ORDER BY COALESCE(filled_at, cancelled_at, created_at) DESC
            LIMIT $2`,
          [userId, HISTORY_LIMIT],
        ),
        client.query<AlertRow>(
          `SELECT id, ticker, condition, price, active, note,
                  created_at, triggered_at, triggered_price
             FROM paper_trade_pro.alerts
            WHERE user_id = $1
            ORDER BY created_at DESC`,
          [userId],
        ),
        client.query<{ ticker: string }>(
          `SELECT ticker FROM paper_trade_pro.watchlist
            WHERE user_id = $1
            ORDER BY added_at ASC`,
          [userId],
        ),
      ]);

    const acctRow = acct.rows[0];
    if (!acctRow) throw new Error(`accounts row missing for user_id=${userId}`);

    return {
      cash: acctRow.cash,
      initialCash: acctRow.initial_cash,
      positions: positions.rows.map(rowToPosition),
      orders: workingOrders.rows.map(rowToOrder),
      alerts: alerts.rows.map(rowToAlert),
      watchlist: watchlist.rows.map((r) => r.ticker),
      history: historyOrders.rows.map(rowToOrder),
    };
  }
}

