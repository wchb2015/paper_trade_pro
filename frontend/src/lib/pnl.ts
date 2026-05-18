import type { Order, Portfolio } from './types';

// -----------------------------------------------------------------------------
// FIFO P&L replay.
//
// The backend stores filled orders but does NOT track which lots a sell
// closed. We reconstruct that on the client by walking filled history
// chronologically, maintaining per-(ticker, side) lot queues, and draining
// them on sell/cover.
//
// Two callers consume the result:
//   1. OrdersPage — needs realized P&L per closing-order id.
//   2. TradeTicket lot picker — needs the *current* open lots for a symbol
//      so the user can pick which to close.
//
// History is server-truncated to HISTORY_LIMIT. If a sell consumes more
// shares than the queue can supply (the buy that opened the lot has been
// pruned), we fall back to the current `position.avgPrice` as the cost
// basis for the missing tail. With HISTORY_LIMIT = 1000 this should
// almost never fire, but it guarantees we never show "—".
// -----------------------------------------------------------------------------

/** A single open lot — the residue of a buy (or short) that hasn't been closed. */
export interface Lot {
  /** Order id of the opening buy/short. Stable identifier for picker selection. */
  openOrderId: string;
  ticker: string;
  /** 'long' = opened by a buy; 'short' = opened by a short. */
  side: 'long' | 'short';
  /** Cost per share. For shorts this is the entry price (sell-short price). */
  costPerShare: number;
  /** Shares remaining in this lot. */
  qty: number;
  /** When the lot was opened (ms epoch). */
  openedAt: number;
}

export interface RealizedPnL {
  abs: number;
  pct: number;
}

export interface FifoResult {
  /** Realized P&L keyed by the closing order's id (sell or cover). */
  pnlByOrderId: Map<string, RealizedPnL>;
  /** Currently-open lots, keyed by ticker. Each ticker has long + short queues. */
  openLots: Map<string, { long: Lot[]; short: Lot[] }>;
}

function getQueues(
  state: Map<string, { long: Lot[]; short: Lot[] }>,
  ticker: string,
): { long: Lot[]; short: Lot[] } {
  let q = state.get(ticker);
  if (!q) {
    q = { long: [], short: [] };
    state.set(ticker, q);
  }
  return q;
}

function orderTimestamp(o: Order): number {
  // Use filledAt for filled orders so chronological replay matches market reality.
  return o.filledAt ?? o.createdAt;
}

/**
 * Replay all filled orders in chronological order, building FIFO lot queues
 * and realized P&L for each closing order.
 *
 * Time complexity O(N + Σ lot pops), space O(open lots).
 */
export function replayFifo(
  history: Order[],
  currentPositions: Portfolio['positions'],
): FifoResult {
  // Sort oldest-first; history is newest-first by default.
  const sorted = [...history.filter((o) => o.status === 'filled')].sort(
    (a, b) => orderTimestamp(a) - orderTimestamp(b),
  );

  const state = new Map<string, { long: Lot[]; short: Lot[] }>();
  const pnl = new Map<string, RealizedPnL>();

  for (const o of sorted) {
    if (o.fillPrice == null) continue;
    const q = getQueues(state, o.ticker);

    if (o.side === 'buy') {
      q.long.push({
        openOrderId: o.id,
        ticker: o.ticker,
        side: 'long',
        costPerShare: o.fillPrice,
        qty: o.qty,
        openedAt: orderTimestamp(o),
      });
    } else if (o.side === 'short') {
      q.short.push({
        openOrderId: o.id,
        ticker: o.ticker,
        side: 'short',
        costPerShare: o.fillPrice,
        qty: o.qty,
        openedAt: orderTimestamp(o),
      });
    } else if (o.side === 'sell' || o.side === 'cover') {
      // Drain the matching queue FIFO.
      const queue = o.side === 'sell' ? q.long : q.short;
      let remaining = o.qty;
      let absPnl = 0;
      let costSum = 0;

      while (remaining > 0 && queue.length > 0) {
        const lot = queue[0];
        const take = Math.min(remaining, lot.qty);
        const lotCost = take * lot.costPerShare;
        const lotProceeds =
          o.side === 'sell'
            ? take * o.fillPrice
            : take * lot.costPerShare; // see absPnl line for short math
        // P&L per share:
        //   long sell: (sellPrice - cost)
        //   short cover: (costShortEntry - coverPrice)
        const perShare =
          o.side === 'sell'
            ? o.fillPrice - lot.costPerShare
            : lot.costPerShare - o.fillPrice;
        absPnl += perShare * take;
        costSum += lotCost;
        lot.qty -= take;
        remaining -= take;
        if (lot.qty === 0) queue.shift();
        // touch lotProceeds so the linter doesn't complain about the dead
        // assignment we keep for clarity; it's the basis for revenue logging
        // if we add it later.
        void lotProceeds;
      }

      // Pruned-history fallback: a sell consumed more shares than we have
      // recorded buys for. Use the current matching position's avgPrice as
      // the cost basis for the orphaned tail.
      if (remaining > 0) {
        const wantSide = o.side === 'sell' ? 'long' : 'short';
        const pos = currentPositions.find(
          (p) => p.ticker === o.ticker && p.side === wantSide,
        );
        const fallbackCost = pos?.avgPrice ?? o.fillPrice;
        const perShare =
          o.side === 'sell'
            ? o.fillPrice - fallbackCost
            : fallbackCost - o.fillPrice;
        absPnl += perShare * remaining;
        costSum += fallbackCost * remaining;
        remaining = 0;
      }

      const pct = costSum > 0 ? (absPnl / costSum) * 100 : 0;
      pnl.set(o.id, { abs: absPnl, pct });
    }
  }

  return { pnlByOrderId: pnl, openLots: state };
}

/**
 * Convenience: pull the open long lots for a ticker (sorted FIFO).
 * Returns [] when there are none.
 */
export function getOpenLongLots(result: FifoResult, ticker: string): Lot[] {
  const q = result.openLots.get(ticker);
  return q ? q.long.filter((l) => l.qty > 0) : [];
}

/** Open short lots for a ticker. */
export function getOpenShortLots(result: FifoResult, ticker: string): Lot[] {
  const q = result.openLots.get(ticker);
  return q ? q.short.filter((l) => l.qty > 0) : [];
}
