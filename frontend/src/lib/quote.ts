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
 * Day-change baseline: yesterday's close, full stop. Returns null when the
 * provider hasn't supplied prevClose (e.g. replay mode today — see TODO in
 * ReplayProvider.buildQuoteForSymbol). Callers render "—" when null.
 */
export function dayBase(s: StockSnapshot): number | null {
  return s.prevClose;
}

/** Day change as an absolute dollar amount; null when we have no baseline. */
export function dayChange(s: StockSnapshot): number | null {
  const base = dayBase(s);
  if (base == null) return null;
  return s.price - base;
}

/** Day change as a percent; null when we have no baseline. */
export function dayChangePct(s: StockSnapshot): number | null {
  const base = dayBase(s);
  if (base == null || base === 0) return null;
  return ((s.price - base) / base) * 100;
}

/** Render-friendly dollar cell. Returns "—" when the field is null. */
export function money(x: number | null | undefined, digits = 2): string {
  if (x == null || !Number.isFinite(x)) return '—';
  return `$${x.toFixed(digits)}`;
}
