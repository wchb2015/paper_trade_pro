import type { StockSnapshot } from './types';

// -----------------------------------------------------------------------------
// Small helpers to consume StockSnapshot fields that the provider may not
// supply. Keeps `?? fallback` from leaking into every call site.
// -----------------------------------------------------------------------------

/** Bid, falling back to the last trade price. Use in fill logic. */
export function bidOrPrice(s: StockSnapshot): number {
  return s.bid ?? s.price;
}

/** Ask, falling back to the last trade price. Use in fill logic. */
export function askOrPrice(s: StockSnapshot): number {
  return s.ask ?? s.price;
}

/**
 * Denominator for a day-change %. If we don't have a day-open yet, fall back
 * to prev close, and ultimately the current price (yielding 0% change).
 */
export function dayBase(s: StockSnapshot): number {
  return s.dayOpen ?? s.prevClose ?? s.price;
}

/** Day change as an absolute dollar amount. */
export function dayChange(s: StockSnapshot): number {
  return s.price - dayBase(s);
}

/** Day change as a percent (0 if we have no baseline). */
export function dayChangePct(s: StockSnapshot): number {
  const base = dayBase(s);
  if (base === 0) return 0;
  return ((s.price - base) / base) * 100;
}

/** Render-friendly dollar cell. Returns "—" when the field is null. */
export function money(x: number | null | undefined, digits = 2): string {
  if (x == null || !Number.isFinite(x)) return '—';
  return `$${x.toFixed(digits)}`;
}
