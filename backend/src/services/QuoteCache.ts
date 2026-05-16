import type { Quote } from '../../../shared/src';
import type { PriceProvider } from '../providers/PriceProvider';

// -----------------------------------------------------------------------------
// QuoteCache: a thin TTL cache over the provider's fetchQuotes with in-flight
// request coalescing. Its job is to keep us safely within free-tier limits
// even if 10 clients all hit /api/quotes at once.
// -----------------------------------------------------------------------------

interface CacheEntry {
  quote: Quote;
  cachedAt: number;
}

export class QuoteCache {
  private entries = new Map<string, CacheEntry>();
  /** Coalesce concurrent fetches for the same symbol set into one upstream call. */
  private inflight = new Map<string, Promise<Record<string, Quote>>>();

  constructor(
    private readonly provider: PriceProvider,
    private readonly ttlMs: number,
  ) {}

  /**
   * Return quotes for `symbols`. For each symbol:
   *   - If we have a cached copy younger than TTL, use it.
   *   - Otherwise, batch the misses into a single upstream fetch.
   *
   * This keeps rapid page loads or multi-component subscriptions from
   * multiplying into upstream traffic.
   */
  async getMany(symbols: string[]): Promise<Record<string, Quote>> {
    const now = Date.now();
    const normalised = Array.from(
      new Set(symbols.map((s) => s.toUpperCase())),
    );
    const result: Record<string, Quote> = {};
    const misses: string[] = [];

    for (const s of normalised) {
      const e = this.entries.get(s);
      if (e && now - e.cachedAt < this.ttlMs) {
        result[s] = e.quote;
      } else {
        misses.push(s);
      }
    }

    if (misses.length === 0) return result;

    const key = misses.sort().join(',');
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.provider
        .fetchQuotes(misses)
        .then((fresh) => {
          const fetchedAt = Date.now();
          for (const [sym, q] of Object.entries(fresh)) {
            this.entries.set(sym, { quote: q, cachedAt: fetchedAt });
          }
          return fresh;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const fresh = await pending;
    for (const s of misses) {
      if (fresh[s]) result[s] = fresh[s];
    }
    return result;
  }

  /**
   * Merge a streaming tick into the cache so subsequent GET /quotes returns
   * the fresh price without re-hitting the REST endpoint.
   *
   * Per-field merge rule: take whatever the tick gives us when non-null;
   * otherwise keep the cached value. AlpacaProvider's stream only carries
   * price+timestamp (other fields are null) — those fall through to the
   * cached snapshot. ReplayProvider's stream also carries running
   * dayOpen/dayHigh/dayLow, which need to overwrite the cached values so
   * /quotes reflects the simulation's progress.
   */
  applyTick(quote: Quote): void {
    const existing = this.entries.get(quote.symbol);
    if (!existing) {
      this.entries.set(quote.symbol, { quote, cachedAt: Date.now() });
      return;
    }
    const merged: Quote = {
      ...existing.quote,
      price: quote.price,
      timestamp: quote.timestamp,
      status: 'live',
      bid: quote.bid ?? existing.quote.bid,
      ask: quote.ask ?? existing.quote.ask,
      dayOpen: quote.dayOpen ?? existing.quote.dayOpen,
      dayHigh: quote.dayHigh ?? existing.quote.dayHigh,
      dayLow: quote.dayLow ?? existing.quote.dayLow,
      prevClose: quote.prevClose ?? existing.quote.prevClose,
    };
    this.entries.set(quote.symbol, { quote: merged, cachedAt: Date.now() });
  }

  /** Snapshot peek; returns undefined if not cached or stale. */
  peek(symbol: string): Quote | undefined {
    const e = this.entries.get(symbol.toUpperCase());
    if (!e) return undefined;
    return e.quote;
  }
}
