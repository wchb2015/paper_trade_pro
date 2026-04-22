import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { SEED_STOCKS } from '../lib/seedStocks';
import type { Market, StockSnapshot } from '../lib/types';

// Generate a stable price history (mean-reverting random walk, deterministic per ticker)
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function genHistory(ticker: string, currentPrice: number, points = 90): number[] {
  const seed = [...ticker].reduce((a, c) => a + c.charCodeAt(0), 0);
  const rnd = seededRandom(seed);
  const arr: number[] = [];
  let p = currentPrice * (0.85 + rnd() * 0.25); // start somewhere in 85-110% range
  for (let i = 0; i < points; i++) {
    const drift = (currentPrice - p) * 0.02;
    const noise = (rnd() - 0.5) * currentPrice * 0.018;
    p = Math.max(0.5, p + drift + noise);
    arr.push(p);
  }
  arr[arr.length - 1] = currentPrice;
  return arr;
}

function buildInitialMarket(): Market {
  const m: Market = {};
  SEED_STOCKS.forEach((s) => {
    m[s.ticker] = {
      ...s,
      prev: s.price,
      history: genHistory(s.ticker, s.price),
      bid: +(s.price - s.price * 0.0008).toFixed(2),
      ask: +(s.price + s.price * 0.0008).toFixed(2),
      dayHigh: s.price * (1 + 0.01),
      dayLow: s.price * (1 - 0.012),
      dayOpen: s.price * (1 - 0.003),
    };
  });
  return m;
}

function applyTick(s: StockSnapshot, newPrice: number): StockSnapshot {
  const rounded = +newPrice.toFixed(2);
  return {
    ...s,
    prev: s.price,
    price: rounded,
    bid: +(rounded - rounded * 0.0008).toFixed(2),
    ask: +(rounded + rounded * 0.0008).toFixed(2),
    dayHigh: Math.max(s.dayHigh, rounded),
    dayLow: Math.min(s.dayLow, rounded),
    history: [...s.history.slice(1), rounded],
  };
}

interface LivePriceUpdate {
  symbol: string;
  price: number;
  ts: string;
}

export interface UseMarketResult {
  market: Market;
  paused: boolean;
  setPaused: (p: boolean) => void;
  speed: number;
  setSpeed: (s: number) => void;
  liveConnected: boolean;
}

const BACKEND_URL =
  typeof window !== 'undefined'
    ? (window as unknown as { __PTP_BACKEND?: string }).__PTP_BACKEND ||
      'http://localhost:4000'
    : 'http://localhost:4000';

export function useMarket(): UseMarketResult {
  const [market, setMarket] = useState<Market>(() => buildInitialMarket());
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [liveConnected, setLiveConnected] = useState(false);

  // Simulated ticker — ticks 3-5 random stocks every interval
  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => {
      setMarket((prev) => {
        const next: Market = { ...prev };
        const keys = Object.keys(prev);
        const count = 3 + Math.floor(Math.random() * 3);
        for (let i = 0; i < count; i++) {
          const k = keys[Math.floor(Math.random() * keys.length)];
          const s = prev[k];
          const move = (Math.random() - 0.5) * s.price * 0.0015;
          const newPrice = Math.max(0.5, s.price + move);
          next[k] = applyTick(s, newPrice);
        }
        return next;
      });
    }, 1200 / speed);
    return () => window.clearInterval(id);
  }, [paused, speed]);

  // Optional: overlay live prices from the backend's Alpaca stream (e.g. TSLA).
  // Falls back gracefully if the backend isn't running.
  useEffect(() => {
    let socket: Socket | null = null;
    try {
      socket = io(BACKEND_URL, {
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 2000,
        timeout: 4000,
      });
    } catch {
      return;
    }

    const onConnect = () => setLiveConnected(true);
    const onDisconnect = () => setLiveConnected(false);
    const onPrice = (data: LivePriceUpdate) => {
      if (!data || typeof data.price !== 'number') return;
      const symbol = data.symbol?.toUpperCase();
      if (!symbol) return;
      setMarket((prev) => {
        const s = prev[symbol];
        if (!s) return prev;
        if (paused) return prev;
        return { ...prev, [symbol]: applyTick(s, data.price) };
      });
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onDisconnect);
    socket.on('price', onPrice);

    return () => {
      if (socket) {
        socket.off('connect', onConnect);
        socket.off('disconnect', onDisconnect);
        socket.off('connect_error', onDisconnect);
        socket.off('price', onPrice);
        socket.disconnect();
      }
    };
  }, [paused]);

  return { market, paused, setPaused, speed, setSpeed, liveConnected };
}
