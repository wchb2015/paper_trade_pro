// -----------------------------------------------------------------------------
// lotView — adapter on top of replayFifo for the PositionDetailDrawer.
//
// Builds per-lot row data (term, current value, unrealized $/% G/L, cost-basis
// totals) from the FIFO open-lot queues already produced by lib/pnl.ts. Falls
// back to a synthetic "aggregate lot" derived from the Position row when the
// queues are empty (history pruned past HISTORY_LIMIT, fresh import, etc.).
//
// Pure module — no React, no I/O. Errors are logged with the project's
// "Never fail silently" rule (see CLAUDE.md) and replaced with a safe empty
// result the caller surfaces as a warning.
// -----------------------------------------------------------------------------

import type { Market, Portfolio } from './types';
import { replayFifo, type Lot } from './pnl';

// 365 days. Lots opened ≥1 year ago count as Long-term; younger lots are
// Short-term. Mirrors the U.S. brokerage convention shown on the spec mock.
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface LotRow extends Lot {
  /** 'Short' = held <1y; 'Long' = held ≥1y. Re-evaluated on every getLotRows
   *  call so older lots flip without a backend change. */
  term: 'Short' | 'Long';
  /** Long: qty * markPrice. Short: qty * costPerShare (entry price). */
  currentValue: number;
  /** Long: (mark - cost) * qty. Short: (cost - mark) * qty. */
  unrealizedAbs: number;
  /** unrealizedAbs / costBasisTotal * 100. 0 when basis is 0. */
  unrealizedPct: number;
  /** qty * costPerShare. */
  costBasisTotal: number;
  /** True when this row was synthesized from the Position row, not from a
   *  real opening order in history. */
  aggregateFallback?: true;
}

export interface LotRowsResult {
  long: LotRow[];
  short: LotRow[];
  /** True when at least one section was synthesized from the Position row. */
  aggregate: boolean;
  /** True when the adapter caught an error and returned a safe empty result.
   *  The drawer renders an inline warning when this is set. */
  failed: boolean;
}

/**
 * Build per-lot rows for `ticker`. Reads `portfolio.history` + `portfolio.positions`
 * for lot reconstruction, and `market[ticker]` for the live mark price.
 */
export function getLotRows(
  portfolio: Portfolio,
  ticker: string,
  market: Market,
): LotRowsResult {
  try {
    const fifo = replayFifo(portfolio.history, portfolio.positions);
    const queues = fifo.openLots.get(ticker);
    const mark = market[ticker]?.price ?? 0;

    const longLots: Lot[] = (queues?.long ?? []).filter((l) => l.qty > 0);
    const shortLots: Lot[] = (queues?.short ?? []).filter((l) => l.qty > 0);

    let aggregate = false;

    // Aggregate fallback per side: if the FIFO queue is empty but a Position
    // row exists, synthesize one row so the user can still sell.
    const longPos = portfolio.positions.find(
      (p) => p.ticker === ticker && p.side === 'long',
    );
    if (longLots.length === 0 && longPos && longPos.qty > 0) {
      longLots.push({
        openOrderId: `agg-${longPos.id}`,
        ticker,
        side: 'long',
        costPerShare: longPos.avgPrice,
        qty: longPos.qty,
        openedAt: longPos.openedAt,
      });
      aggregate = true;
    }

    const shortPos = portfolio.positions.find(
      (p) => p.ticker === ticker && p.side === 'short',
    );
    if (shortLots.length === 0 && shortPos && shortPos.qty > 0) {
      shortLots.push({
        openOrderId: `agg-${shortPos.id}`,
        ticker,
        side: 'short',
        costPerShare: shortPos.avgPrice,
        qty: shortPos.qty,
        openedAt: shortPos.openedAt,
      });
      aggregate = true;
    }

    return {
      long: longLots.map((l) => buildRow(l, mark)),
      short: shortLots.map((l) => buildRow(l, mark)),
      aggregate,
      failed: false,
    };
  } catch (err) {
    // CLAUDE.md "Never fail silently" — log with ERROR keyword + context.
    console.error('ERROR getLotRows failed', { ticker, err });
    return { long: [], short: [], aggregate: false, failed: true };
  }
}

function buildRow(lot: Lot, mark: number): LotRow {
  const costBasisTotal = lot.qty * lot.costPerShare;
  const term: 'Short' | 'Long' =
    Date.now() - lot.openedAt >= ONE_YEAR_MS ? 'Long' : 'Short';
  const currentValue =
    lot.side === 'long' ? lot.qty * mark : lot.qty * lot.costPerShare;
  const unrealizedAbs =
    lot.side === 'long'
      ? (mark - lot.costPerShare) * lot.qty
      : (lot.costPerShare - mark) * lot.qty;
  const unrealizedPct =
    costBasisTotal > 0 ? (unrealizedAbs / costBasisTotal) * 100 : 0;
  const row: LotRow = {
    ...lot,
    term,
    currentValue,
    unrealizedAbs,
    unrealizedPct,
    costBasisTotal,
  };
  if (lot.openOrderId.startsWith('agg-')) {
    row.aggregateFallback = true;
  }
  return row;
}

/**
 * "Mar 15, 2025 09:31 AM" in the user's local timezone. Per CLAUDE.md timezone
 * golden rule, we convert to local only at the display edge.
 */
export function formatAcquired(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}
