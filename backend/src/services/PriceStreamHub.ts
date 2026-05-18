import type { Server } from "socket.io";
import { getLogger } from "@chongbei/web-basics/server";

const log = getLogger("services.PriceStreamHub");
import {
  SOCKET_EVENTS,
  type AlpacaFeed,
  type PriceTickPayload,
  type ProviderStatusPayload,
  type ServerToClientEvents,
  type ClientToServerEvents,
  type Quote,
} from "../../../shared/src";
import type { AppConfig } from "../config";
import type { PriceProvider } from "../providers/PriceProvider";
import type { QuoteCache } from "./QuoteCache";

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
    this.status = { status: "unavailable", provider: this.provider.name };
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
      onQuote: (quote, meta) => this.handleTick(quote, meta),
      onStatusChange: (s, detail) => this.handleStatusChange(s, detail),
    });

    // Push current status to anyone who connects before the first upstream
    // message arrives.
    this.io.on("connection", (socket) => {
      socket.emit(SOCKET_EVENTS.PROVIDER_STATUS, this.status);
    });
  }

  /**
   * Ensure `symbols` are part of the subscription set.
   *   - `replace: false` (default) — additive. Used by GET /quotes, which
   *     only knows the symbols of the current snapshot request.
   *   - `replace: true` — mirror exactly. Used by POST /subscriptions, where
   *     the client sends its full union and expects removed symbols to be
   *     unsubscribed upstream.
   * For a small single-user app this is simpler than refcounting per-client.
   */
  async ensureSubscribed(
    symbols: string[],
    opts: { replace?: boolean } = {},
  ): Promise<string[]> {
    const desired = opts.replace ? new Set<string>() : new Set(this.subscribed);
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

  /**
   * Switch the live WS feed at runtime (Alpaca only). On success, returns
   * `{ feed, fellBack: false }`. On failure (e.g. account not entitled to
   * SIP), the underlying provider has already restored the prior feed, so
   * we report `{ feed: <restored>, fellBack: true, reason }`.
   *
   * Always re-emits ProviderStatusPayload so all connected sockets pick
   * up the new (or restored) feed indicator.
   */
  async setLiveFeed(
    feed: AlpacaFeed,
  ): Promise<{ feed: AlpacaFeed; fellBack: boolean; reason?: string }> {
    if (!this.provider.setLiveFeed || !this.provider.getLiveFeed) {
      throw new Error(
        `provider '${this.provider.name}' does not support live feed switching`,
      );
    }
    try {
      await this.provider.setLiveFeed(feed);
      // Force a status broadcast so the new feed reaches the UI even if
      // Alpaca didn't already emit a 'connected' transition (e.g. it stayed
      // connected on the same TCP).
      this.broadcastStatus();
      return { feed, fellBack: false };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error(
        { err, requested: feed, operation: "PriceStreamHub.setLiveFeed" },
        "ERROR setLiveFeed failed; provider has restored prior feed",
      );
      this.broadcastStatus();
      return {
        feed: this.provider.getLiveFeed(),
        fellBack: true,
        reason,
      };
    }
  }

  // --------------------------------------------------------------------------

  private capSymbols(symbols: string[]): string[] {
    const unique = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
    if (unique.length <= this.cfg.limits.MAX_STREAM_SYMBOLS) return unique;
    // Keep the first N deterministically — this branch shouldn't trigger
    // under normal single-user use.
    log.warn(
      {
        requested: unique.length,
        cap: this.cfg.limits.MAX_STREAM_SYMBOLS,
        operation: "PriceStreamHub.capSymbols",
      },
      "capping subscription to free-tier limit",
    );
    return unique.slice(0, this.cfg.limits.MAX_STREAM_SYMBOLS);
  }

  private handleTick(quote: Quote, meta?: { simTimestamp?: number }): void {
    // Keep the cache warm so REST /quotes reflects live data.
    this.cache.applyTick(quote);
    const payload: PriceTickPayload = {
      symbol: quote.symbol,
      price: quote.price,
      timestamp: quote.timestamp,
      ...(meta?.simTimestamp !== undefined
        ? { simTimestamp: meta.simTimestamp }
        : {}),
    };
    this.io.emit(SOCKET_EVENTS.PRICE_TICK, payload);
  }

  private handleStatusChange(
    raw: "connected" | "disconnected" | "error",
    detail?: string,
  ): void {
    const status =
      raw === "connected"
        ? ("live" as const)
        : raw === "disconnected"
          ? ("unavailable" as const)
          : ("unavailable" as const);
    // Provider-side error/disconnect events are operationally interesting —
    // CLAUDE.md rule 8 (log 5xx-class failures). Info log on 'connected' to
    // mirror transitions symmetrically; error for 'error'; warn for a
    // disconnect we didn't initiate.
    if (raw === "error") {
      log.error(
        { provider: this.provider.name, detail, operation: "provider.stream" },
        "ERROR upstream price provider reported error",
      );
    } else if (raw === "disconnected") {
      log.warn(
        { provider: this.provider.name, detail, operation: "provider.stream" },
        "upstream price provider disconnected",
      );
    } else {
      log.info(
        { provider: this.provider.name, detail, operation: "provider.stream" },
        "upstream price provider connected",
      );
    }
    this.status = this.buildStatusPayload(status, detail);
    this.io.emit(SOCKET_EVENTS.PROVIDER_STATUS, this.status);
  }

  /**
   * Re-emit the current status payload (no upstream transition required).
   * Used after a runtime feed switch so the UI sees the new feed indicator
   * even when the WS stayed nominally connected throughout.
   */
  private broadcastStatus(): void {
    this.status = this.buildStatusPayload(
      this.status.status,
      this.status.message,
    );
    this.io.emit(SOCKET_EVENTS.PROVIDER_STATUS, this.status);
  }

  private buildStatusPayload(
    status: ProviderStatusPayload["status"],
    detail: string | undefined,
  ): ProviderStatusPayload {
    const replaySpeed = this.provider.getReplaySpeed?.();
    const replayDate = this.provider.getReplayDate?.();
    const feed = this.provider.getLiveFeed?.();
    return {
      status,
      provider: this.provider.name,
      ...(detail !== undefined ? { message: detail } : {}),
      ...(replaySpeed !== undefined ? { replaySpeed } : {}),
      ...(replayDate !== undefined ? { replayDate } : {}),
      ...(feed !== undefined ? { feed } : {}),
    };
  }
}
