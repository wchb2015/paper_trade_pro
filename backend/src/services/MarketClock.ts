import { getLogger } from '@chongbei/web-basics/server';
import type { AppConfig } from '../config';
import type { MarketClockResponse } from '../../../shared/src';

const log = getLogger('services.MarketClock');

// -----------------------------------------------------------------------------
// MarketClock — single source of truth for "is the U.S. equities market open
// right now?". Wraps Alpaca's /v2/clock endpoint, which is authoritative for
// NYSE holidays and early-close days.
//
// Why not roll our own RTH calculator? Because the holiday calendar drifts
// (Juneteenth was added in 2022; Good Friday moves with Easter) and early-
// close days (e.g. day after Thanksgiving) flip `isOpen` to false at 13:00 ET
// instead of 16:00. Hardcoding any of that is rot waiting to happen, and we
// already use Alpaca for everything else.
//
// Caching:
//  - Successful fetches are cached for 30 seconds. /clock is cheap and Alpaca
//    rate-limits at 200 req/min on the trading API, but we still go through
//    placeOrder a lot — no reason to round-trip every request.
//  - Failed fetches (network error, 5xx) DO NOT poison the cache. Subsequent
//    calls retry. Until the first success, the helpers fail closed (treat as
//    closed) so we never silently let an order through during a connectivity
//    blip.
//
// Replay mode:
//  - The provider is `replay`, the user is intentionally trading against a
//    recorded historical session. The wall clock is meaningless in that mode
//    (a user replaying 2024-12-13 at 11pm ET still expects orders to fill).
//    We short-circuit to `isOpen: true` and never touch Alpaca.
//
// Logging: every fetch logs success or failure with `error` severity on
// failure (CLAUDE.md rule 1/6). No silent errors.
// -----------------------------------------------------------------------------

const CACHE_TTL_MS = 30_000;

/** Alpaca /v2/clock raw shape. https://docs.alpaca.markets/reference/getclock */
interface AlpacaClock {
  timestamp: string;
  is_open: boolean;
  next_open: string;
  next_close: string;
}

interface CacheEntry {
  value: MarketClockResponse;
  cachedAt: number;
}

export class MarketClock {
  private readonly cfg: AppConfig;
  private cache: CacheEntry | null = null;
  private inFlight: Promise<MarketClockResponse> | null = null;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
  }

  /**
   * Get current market status. May serve from cache. In replay mode returns
   * a synthetic always-open response.
   *
   * Throws on the very first call if Alpaca is unreachable. Callers that
   * need to fail closed (i.e. order placement) should use `tryGetStatus`
   * which never throws.
   */
  async getStatus(): Promise<MarketClockResponse> {
    if (this.cfg.provider === 'replay') {
      return this.replayStatus();
    }

    const now = Date.now();
    if (this.cache && now - this.cache.cachedAt < CACHE_TTL_MS) {
      return this.cache.value;
    }

    // Coalesce concurrent refreshes so a burst of placeOrder calls doesn't
    // hammer /clock (200 req/min trading-API limit).
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchClock()
      .then((value) => {
        this.cache = { value, cachedAt: Date.now() };
        return value;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /**
   * Fail-closed convenience for the place-order path: if /clock is currently
   * unreachable AND we have no cached value, return `null` so the caller
   * can reject the order with a clear "market status unavailable" message
   * rather than letting it through.
   *
   * If we have a cached value (even past TTL) we return it — better to let
   * a stale RTH determination through during a 30-second Alpaca blip than
   * to refuse every order.
   */
  async tryGetStatus(): Promise<MarketClockResponse | null> {
    if (this.cfg.provider === 'replay') {
      return this.replayStatus();
    }
    try {
      return await this.getStatus();
    } catch (err) {
      if (this.cache) {
        log.error(
          {
            err,
            operation: 'MarketClock.tryGetStatus',
            usingStaleCacheAgeMs: Date.now() - this.cache.cachedAt,
          },
          'ERROR /clock fetch failed; serving stale cached status as fallback',
        );
        return this.cache.value;
      }
      log.error(
        { err, operation: 'MarketClock.tryGetStatus' },
        'ERROR /clock fetch failed and no cached value; failing closed',
      );
      return null;
    }
  }

  private async fetchClock(): Promise<MarketClockResponse> {
    const url = new URL('/v2/clock', this.cfg.alpaca.tradingBaseUrl);
    const res = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID': this.cfg.alpaca.keyId,
        'APCA-API-SECRET-KEY': this.cfg.alpaca.secretKey,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch((readErr: unknown) => {
        log.error(
          {
            err: readErr,
            operation: 'MarketClock.fetchClock.readErrorBody',
            status: res.status,
          },
          'ERROR could not read Alpaca /clock error body',
        );
        return '';
      });
      throw new Error(
        `Alpaca /clock failed: ${res.status} ${res.statusText} ${body}`,
      );
    }
    const raw = (await res.json()) as AlpacaClock;
    if (
      typeof raw.is_open !== 'boolean' ||
      typeof raw.next_open !== 'string' ||
      typeof raw.next_close !== 'string'
    ) {
      throw new Error(
        `Alpaca /clock returned unexpected shape: ${JSON.stringify(raw)}`,
      );
    }
    const nextOpen = Date.parse(raw.next_open);
    const nextClose = Date.parse(raw.next_close);
    if (!Number.isFinite(nextOpen) || !Number.isFinite(nextClose)) {
      throw new Error(
        `Alpaca /clock returned unparseable timestamps: ${raw.next_open} / ${raw.next_close}`,
      );
    }
    return {
      isOpen: raw.is_open,
      nextOpen,
      nextClose,
      fetchedAt: Date.now(),
    };
  }

  private replayStatus(): MarketClockResponse {
    // In replay mode the wall clock is irrelevant — surface the next/prev
    // session as the same instant so the UI just shows "open".
    const t = Date.now();
    return {
      isOpen: true,
      nextOpen: t,
      nextClose: t + 6.5 * 60 * 60_000,
      fetchedAt: t,
    };
  }
}
