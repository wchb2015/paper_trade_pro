// Socket.io event names. String constants so both ends stay in lockstep
// and so typos fail at compile time.

import type { PriceTickPayload, ProviderStatusPayload } from './quote.js';

export const SOCKET_EVENTS = {
  /** Per-trade tick from the provider. */
  PRICE_TICK: 'price:tick',
  /** Provider-level status (connected / disconnected / creds missing). */
  PROVIDER_STATUS: 'provider:status',
} as const;

/** Strict typing for Socket.io's generics. */
export interface ServerToClientEvents {
  [SOCKET_EVENTS.PRICE_TICK]: (payload: PriceTickPayload) => void;
  [SOCKET_EVENTS.PROVIDER_STATUS]: (payload: ProviderStatusPayload) => void;
}

export interface ClientToServerEvents {
  // Reserved for future bi-directional events. Today, subscriptions are
  // managed via REST so reconnects don't lose the subscription set.
}
