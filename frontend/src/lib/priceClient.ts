import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  PriceTickPayload,
  ProviderStatusPayload,
  Quote,
  QuotesResponse,
  ServerToClientEvents,
  SubscriptionsResponse,
} from '../../../shared/src';
import { SOCKET_EVENTS } from '../../../shared/src';
import { config } from '../config';

// -----------------------------------------------------------------------------
// Single source of truth for talking to the backend. REST calls are cached
// by the server; the socket delivers live trade ticks. All UI code that
// needs a price goes through here — no component fetches prices directly.
// -----------------------------------------------------------------------------

export interface PriceClientSubscribers {
  onTick: (tick: PriceTickPayload) => void;
  onStatus: (status: ProviderStatusPayload) => void;
  onConnectionChange: (connected: boolean) => void;
}

export class PriceClient {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null =
    null;
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /** Batched snapshot fetch. */
  async fetchQuotes(symbols: string[]): Promise<QuotesResponse> {
    const q = new URLSearchParams({
      symbols: symbols.map((s) => s.toUpperCase()).join(','),
    });
    const res = await fetch(`${this.baseUrl}/api/quotes?${q}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`/api/quotes ${res.status}: ${body}`);
    }
    return (await res.json()) as QuotesResponse;
  }

  /**
   * Tell the backend to ensure its WS stream includes `symbols`. Additive by
   * default — safe to call from any component on mount.
   */
  async ensureSubscribed(
    symbols: string[],
    opts: { replace?: boolean } = {},
  ): Promise<SubscriptionsResponse> {
    const res = await fetch(`${this.baseUrl}/api/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbols: symbols.map((s) => s.toUpperCase()),
        replace: !!opts.replace,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`/api/subscriptions ${res.status}: ${body}`);
    }
    return (await res.json()) as SubscriptionsResponse;
  }

  /** Open the socket and start pushing ticks to the subscriber. */
  connect(subs: PriceClientSubscribers): void {
    if (this.socket) return;
    const socket = io(this.baseUrl, {
      reconnection: true,
      reconnectionDelay: 2_000,
      timeout: 4_000,
    });
    socket.on('connect', () => subs.onConnectionChange(true));
    socket.on('disconnect', () => subs.onConnectionChange(false));
    socket.on('connect_error', () => subs.onConnectionChange(false));
    socket.on(SOCKET_EVENTS.PRICE_TICK, subs.onTick);
    socket.on(SOCKET_EVENTS.PROVIDER_STATUS, subs.onStatus);
    this.socket = socket;
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }
}

/** Module-level singleton — exactly one socket per tab. */
export const priceClient = new PriceClient(config.backendUrl);

// Re-export for callers that want the Quote type without a long path.
export type { Quote, QuotesResponse };
