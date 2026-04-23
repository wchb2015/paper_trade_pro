import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Quote } from '../../../shared/src';
import { config } from '../config';
import { priceClient } from '../lib/priceClient';
import { getStockMeta } from '../lib/seedStocks';
import type { Market, StockSnapshot } from '../lib/types';

// -----------------------------------------------------------------------------
// useMarket: the only place the UI touches price data. Given a set of tickers
// (typically watchlist ∪ current detail ticker ∪ any trade-ticket ticker) it:
//   1. Requests an initial snapshot via REST.
//   2. Subscribes the backend's WS to those tickers.
//   3. Updates the Market map on every tick.
//   4. Periodically re-fetches snapshots to refresh bid/ask/dayHigh/volume
//      (the tick stream only carries price).
//   5. Marks symbols as 'stale' if no tick arrives within STALE_AFTER_MS.
// -----------------------------------------------------------------------------

export interface UseMarketResult {
  market: Market;
  liveConnected: boolean;
  providerStatus: 'live' | 'stale' | 'unavailable';
  provider: string;
  /** Non-null when the latest snapshot fetch failed. */
  error: string | null;
}

function quoteToSnapshot(
  q: Quote,
  prior: StockSnapshot | undefined,
): StockSnapshot {
  const meta = getStockMeta(q.symbol);
  const prev = prior?.price ?? q.price;
  const history = prior
    ? prior.price === q.price
      ? prior.history
      : [...prior.history, q.price].slice(-config.sparklinePoints)
    : [q.price];
  return {
    ticker: q.symbol,
    name: meta.name,
    sector: meta.sector,
    price: q.price,
    prev,
    history,
    bid: q.bid,
    ask: q.ask,
    dayOpen: q.dayOpen,
    dayHigh: q.dayHigh,
    dayLow: q.dayLow,
    prevClose: q.prevClose,
    volume: q.volume,
    lastUpdated: q.timestamp,
    freshness: 'live',
  };
}

function applyTick(prior: StockSnapshot, price: number, ts: number): StockSnapshot {
  if (prior.price === price) {
    return { ...prior, lastUpdated: ts, freshness: 'live' };
  }
  return {
    ...prior,
    prev: prior.price,
    price,
    history: [...prior.history, price].slice(-config.sparklinePoints),
    lastUpdated: ts,
    freshness: 'live',
  };
}

export function useMarket(symbols: string[]): UseMarketResult {
  const [market, setMarket] = useState<Market>({});
  const [liveConnected, setLiveConnected] = useState(false);
  const [providerStatus, setProviderStatus] =
    useState<'live' | 'stale' | 'unavailable'>('unavailable');
  const [provider, setProvider] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // Stable sorted list so useEffect dependencies fire only on real changes.
  const symbolKey = useMemo(
    () =>
      Array.from(new Set(symbols.map((s) => s.toUpperCase())))
        .sort()
        .join(','),
    [symbols],
  );
  const symbolList = useMemo(
    () => (symbolKey ? symbolKey.split(',') : []),
    [symbolKey],
  );

  // Keep a ref to symbolList for the socket handlers so we don't re-subscribe
  // on every render.
  const symbolListRef = useRef<string[]>(symbolList);
  symbolListRef.current = symbolList;

  // ---- single global socket connection ---------------------------------------
  useEffect(() => {
    priceClient.connect({
      onTick: (tick) => {
        setMarket((prev) => {
          const current = prev[tick.symbol];
          if (!current) return prev;
          return {
            ...prev,
            [tick.symbol]: applyTick(current, tick.price, tick.timestamp),
          };
        });
      },
      onStatus: (status) => {
        setProviderStatus(status.status);
        setProvider(status.provider);
      },
      onConnectionChange: (connected) => setLiveConnected(connected),
    });
    return () => {
      // Keep the client alive across hot-reloads / StrictMode double-mounts.
      // We intentionally don't disconnect here.
    };
  }, []);

  // ---- initial snapshot + subscription -----------------------------------
  const loadSnapshots = useCallback(async (): Promise<void> => {
    if (symbolList.length === 0) {
      setMarket({});
      return;
    }
    try {
      setError(null);
      const response = await priceClient.fetchQuotes(symbolList);
      setProvider(response.provider);
      setProviderStatus(response.providerStatus);

      setMarket((prev) => {
        const next: Market = {};
        for (const sym of symbolList) {
          const q = response.quotes[sym];
          if (q) {
            next[sym] = quoteToSnapshot(q, prev[sym]);
          } else if (prev[sym]) {
            // Keep what we had — provider didn't return this symbol (e.g. an
            // invalid ticker the user typed). Mark stale so the UI can show
            // a hint.
            next[sym] = { ...prev[sym], freshness: 'stale' };
          }
        }
        return next;
      });
    } catch (err) {
      console.error('loadSnapshots failed:', err);
      setError((err as Error).message);
      setMarket((prev) => {
        const next: Market = { ...prev };
        for (const sym of symbolList) {
          if (next[sym]) next[sym] = { ...next[sym], freshness: 'error' };
        }
        return next;
      });
    }
  }, [symbolList]);

  useEffect(() => {
    void loadSnapshots();
    if (symbolList.length > 0) {
      priceClient
        .ensureSubscribed(symbolList)
        .catch((err: unknown) =>
          console.warn('ensureSubscribed failed:', (err as Error).message),
        );
    }
  }, [loadSnapshots, symbolList]);

  // ---- periodic refresh to catch bid/ask/OHLC drift -----------------------
  useEffect(() => {
    if (symbolList.length === 0) return;
    const id = window.setInterval(() => {
      void loadSnapshots();
    }, config.snapshotRefreshMs);
    return () => window.clearInterval(id);
  }, [loadSnapshots, symbolList]);

  // ---- staleness scan every few seconds -----------------------------------
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      setMarket((prev) => {
        let changed = false;
        const next: Market = { ...prev };
        for (const [sym, snap] of Object.entries(prev)) {
          if (
            snap.freshness === 'live' &&
            now - snap.lastUpdated > config.staleAfterMs
          ) {
            next[sym] = { ...snap, freshness: 'stale' };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 5_000);
    return () => window.clearInterval(id);
  }, []);

  // Consolidated provider status: unavailable if socket is down.
  const derivedProviderStatus: 'live' | 'stale' | 'unavailable' = useMemo(() => {
    if (!liveConnected) return 'unavailable';
    return providerStatus;
  }, [liveConnected, providerStatus]);

  return {
    market,
    liveConnected,
    providerStatus: derivedProviderStatus,
    provider,
    error,
  };
}
