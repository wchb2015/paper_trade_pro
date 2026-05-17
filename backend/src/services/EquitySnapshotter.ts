import { getLogger } from '@chongbei/web-basics/server';
import type { Pool } from 'pg';
import { getPool } from '../db';
import type { QuoteCache } from './QuoteCache';

const log = getLogger('services.EquitySnapshotter');

// Equity is stored as NUMERIC(16,2), so any change smaller than half a cent
// rounds to zero in the table anyway. Use a slightly larger window to also
// absorb sub-cent floating-point drift from the in-process pricing math.
const DEDUPE_EPSILON = 0.005;

// -----------------------------------------------------------------------------
// EquitySnapshotter — writes rows into paper_trade_pro.equity_snapshots.
//
// Two callers:
//   • start()/tick(): periodic in-process job, fires every intervalMs (env
//     EQUITY_SNAPSHOT_INTERVAL_MS, default 60s). Writes one snapshot per
//     account row. The route layer doesn't depend on this; it's just the
//     "idle drift" curve.
//   • snapshotUser(userId): on-demand, called by the portfolio routes
//     immediately after a fill/reset so the chart has a point at the exact
//     moment of every cash/position change.
//
// Both paths use identical pricing logic (valueUser): cash from the
// accounts row + market value priced via QuoteCache.peek() with avg_price
// fallback when a quote isn't cached yet. Equity formula matches the
// frontend's usePortfolio.ts (cash + Σ_long(qty*livePrice) +
// Σ_short(qty*(avgPrice - livePrice))).
// -----------------------------------------------------------------------------

interface AccountRow {
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
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
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
   * Write a snapshot for a single user — used by routes after fill/reset.
   * Catches and logs internally so a snapshot failure never breaks the
   * route's success path. Returns true if a row was written.
   */
  async snapshotUser(userId: string): Promise<boolean> {
    try {
      const acct = await this.pool.query<AccountRow>(
        `SELECT user_id, cash FROM paper_trade_pro.accounts WHERE user_id = $1`,
        [userId],
      );
      const a = acct.rows[0];
      if (!a) return false;
      const positions = await this.pool.query<PositionRow>(
        `SELECT user_id, ticker, side, qty, avg_price
           FROM paper_trade_pro.positions
          WHERE user_id = $1`,
        [userId],
      );
      const v = this.valueUser(a.cash, positions.rows);
      await this.pool.query(
        `INSERT INTO paper_trade_pro.equity_snapshots
           (user_id, equity, cash, market_value)
         VALUES ($1, $2, $3, $4)`,
        [userId, v.equity, v.cash, v.marketValue],
      );
      return true;
    } catch (err) {
      log.error(
        { err, userId, operation: 'snapshotter.snapshotUser' },
        'ERROR EquitySnapshotter.snapshotUser failed',
      );
      return false;
    }
  }

  /**
   * Periodic batch tick: fan-out across all accounts. One user's failure
   * is logged but doesn't block the others.
   *
   * Dedupe: if a user's previous snapshot equity matches the freshly-computed
   * equity (within DEDUPE_EPSILON), skip the INSERT. This compresses idle
   * periods (weekends, off-hours, no positions, replay finished) without
   * suppressing meaningful changes. Fill/reset go through `snapshotUser`,
   * which never dedupes — those events should always land in the curve.
   */
  async tick(): Promise<void> {
    let users: AccountRow[] = [];
    try {
      const r = await this.pool.query<AccountRow>(
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

    // One round-trip to fetch the most-recent equity per user, used for
    // dedupe below. Users with no prior snapshot are absent from the map
    // and will therefore always insert.
    const lastEquity = new Map<string, number>();
    try {
      const r = await this.pool.query<{ user_id: string; equity: number }>(
        `SELECT DISTINCT ON (user_id) user_id, equity
           FROM paper_trade_pro.equity_snapshots
          ORDER BY user_id, taken_at DESC`,
      );
      for (const row of r.rows) {
        lastEquity.set(row.user_id, row.equity);
      }
    } catch (err) {
      // Non-fatal: on a read failure we fall back to "no prior known", which
      // means every user inserts this tick. Curve fidelity is preserved at
      // the cost of one redundant row in the worst case.
      log.error(
        { err, operation: 'snapshotter.readLastEquity' },
        'ERROR EquitySnapshotter failed reading last equity (will insert all)',
      );
    }

    const byUser = new Map<string, PositionRow[]>();
    for (const p of positions) {
      const arr = byUser.get(p.user_id);
      if (arr) arr.push(p);
      else byUser.set(p.user_id, [p]);
    }

    let inserted = 0;
    let skipped = 0;
    for (const u of users) {
      try {
        const v = this.valueUser(u.cash, byUser.get(u.user_id) ?? []);
        const prev = lastEquity.get(u.user_id);
        if (prev != null && Math.abs(prev - v.equity) < DEDUPE_EPSILON) {
          skipped++;
          continue;
        }
        await this.pool.query(
          `INSERT INTO paper_trade_pro.equity_snapshots
             (user_id, equity, cash, market_value)
           VALUES ($1, $2, $3, $4)`,
          [u.user_id, v.equity, v.cash, v.marketValue],
        );
        inserted++;
      } catch (err) {
        log.error(
          { err, userId: u.user_id, operation: 'snapshotter.writeSnapshot' },
          'ERROR EquitySnapshotter failed writing user snapshot',
        );
      }
    }
    if (skipped > 0) {
      log.debug(
        { inserted, skipped, total: users.length },
        'EquitySnapshotter tick complete (dedupe applied)',
      );
    }
  }

  /**
   * Pure pricing math. Looks up live quotes via cache.peek(), falls back to
   * avg_price when the symbol hasn't been priced yet. Mirrors usePortfolio.ts
   * so server-side and client-side equity numbers agree.
   */
  private valueUser(
    cash: number,
    positions: PositionRow[],
  ): { cash: number; marketValue: number; equity: number } {
    let marketValue = 0;
    let equity = cash;
    for (const pos of positions) {
      const q = this.cache.peek(pos.ticker);
      const livePrice =
        q && Number.isFinite(q.price) && q.price > 0 ? q.price : pos.avg_price;
      if (pos.side === 'long') {
        marketValue += pos.qty * livePrice;
        equity += pos.qty * livePrice;
      } else {
        marketValue += pos.qty * livePrice;
        equity += pos.qty * (pos.avg_price - livePrice);
      }
    }
    return {
      cash: round2(cash),
      marketValue: round2(marketValue),
      equity: round2(equity),
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
