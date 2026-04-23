import type { Server } from 'socket.io';
import {
  SOCKET_EVENTS,
  type PriceTickPayload,
  type ProviderStatusPayload,
  type ServerToClientEvents,
  type ClientToServerEvents,
  type Quote,
} from '../../../shared/src';
import type { AppConfig } from '../config';
import type { PriceProvider } from '../providers/PriceProvider';
import type { QuoteCache } from './QuoteCache';

// -----------------------------------------------------------------------------
// PriceStreamHub: owns the provider's WS connection and rebroadcasts ticks to
// all connected Socket.io clients. Also enforces the MAX_STREAM_SYMBOLS cap so
// we don't accidentally blow past the free tier.
// -----------------------------------------------------------------------------

export class PriceStreamHub {
  private subscribed = new Set<string>();
  private status: ProviderStatusPayload;

  constructor(
    private readonly io: Server<ClientToServerEvents, ServerToClientEvents>,
    private readonly provider: PriceProvider,
    private readonly cache: QuoteCache,
    private readonly cfg: AppConfig,
  ) {
    this.status = { status: 'unavailable', provider: this.provider.name };
  }

  /**
   * Start the upstream stream. Caller provides the initial symbol set —
   * typically the union of seen watchlists from portfolio storage. For a
   * single-user paper trader we start empty and grow as the UI subscribes.
   */
  async start(initialSymbols: string[] = []): Promise<void> {
    const trimmed = this.capSymbols(initialSymbols);
    trimmed.forEach((s) => this.subscribed.add(s));

    await this.provider.startStream(trimmed, {
      onQuote: (quote) => this.handleTick(quote),
      onStatusChange: (s, detail) => this.handleStatusChange(s, detail),
    });

    // Push current status to anyone who connects before the first upstream
    // message arrives.
    this.io.on('connection', (socket) => {
      socket.emit(SOCKET_EVENTS.PROVIDER_STATUS, this.status);
    });
  }

  /**
   * Ensure `symbols` are part of the subscription set. Additive — we never
   * remove unless `replace: true` is passed. For a small single-user app
   * this is simpler than refcounting per-client.
   */
  async ensureSubscribed(
    symbols: string[],
    opts: { replace?: boolean } = {},
  ): Promise<string[]> {
    const desired = opts.replace
      ? new Set<string>()
      : new Set(this.subscribed);
    for (const s of symbols) desired.add(s.toUpperCase());

    const next = this.capSymbols(Array.from(desired));
    this.subscribed = new Set(next);
    await this.provider.updateSubscriptions(next);
    return next;
  }

  listSubscriptions(): string[] {
    return Array.from(this.subscribed).sort();
  }

  getStatus(): ProviderStatusPayload {
    return this.status;
  }

  // --------------------------------------------------------------------------

  private capSymbols(symbols: string[]): string[] {
    const unique = Array.from(
      new Set(symbols.map((s) => s.toUpperCase())),
    );
    if (unique.length <= this.cfg.limits.MAX_STREAM_SYMBOLS) return unique;
    // Keep the first N deterministically — this branch shouldn't trigger
    // under normal single-user use.
    console.warn(
      `PriceStreamHub: capping ${unique.length} -> ${this.cfg.limits.MAX_STREAM_SYMBOLS} symbols (free-tier guard)`,
    );
    return unique.slice(0, this.cfg.limits.MAX_STREAM_SYMBOLS);
  }

  private handleTick(quote: Quote): void {
    // Keep the cache warm so REST /quotes reflects live data.
    this.cache.applyTick(quote);
    const payload: PriceTickPayload = {
      symbol: quote.symbol,
      price: quote.price,
      timestamp: quote.timestamp,
    };
    this.io.emit(SOCKET_EVENTS.PRICE_TICK, payload);
  }

  private handleStatusChange(
    raw: 'connected' | 'disconnected' | 'error',
    detail?: string,
  ): void {
    const status =
      raw === 'connected'
        ? ('live' as const)
        : raw === 'disconnected'
          ? ('unavailable' as const)
          : ('unavailable' as const);
    const next: ProviderStatusPayload = {
      status,
      provider: this.provider.name,
      ...(detail !== undefined ? { message: detail } : {}),
    };
    this.status = next;
    this.io.emit(SOCKET_EVENTS.PROVIDER_STATUS, next);
  }
}
