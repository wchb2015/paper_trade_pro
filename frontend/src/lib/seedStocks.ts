// Static metadata only — no prices. All price data comes from the backend
// provider (see lib/priceClient + hooks/useMarket). If a ticker isn't in
// this list it'll still work; the UI just won't have a friendly company
// name or sector tag.

export interface StockMeta {
  ticker: string;
  name: string;
  sector: string;
}

export const STOCK_META: StockMeta[] = [
  { ticker: 'AAPL', name: 'Apple Inc.', sector: 'Technology' },
  { ticker: 'MSFT', name: 'Microsoft Corp.', sector: 'Technology' },
  { ticker: 'NVDA', name: 'NVIDIA Corp.', sector: 'Semiconductors' },
  { ticker: 'TSLA', name: 'Tesla, Inc.', sector: 'Auto' },
  { ticker: 'AMZN', name: 'Amazon.com, Inc.', sector: 'Retail' },
  { ticker: 'META', name: 'Meta Platforms', sector: 'Technology' },
  { ticker: 'GOOGL', name: 'Alphabet Inc.', sector: 'Technology' },
  { ticker: 'JPM', name: 'JPMorgan Chase', sector: 'Financials' },
  { ticker: 'V', name: 'Visa Inc.', sector: 'Financials' },
  { ticker: 'AMD', name: 'Advanced Micro Devices', sector: 'Semiconductors' },
  { ticker: 'NFLX', name: 'Netflix, Inc.', sector: 'Media' },
  { ticker: 'DIS', name: 'Walt Disney Co.', sector: 'Media' },
  { ticker: 'BA', name: 'Boeing Co.', sector: 'Industrials' },
  { ticker: 'COIN', name: 'Coinbase Global', sector: 'Financials' },
  { ticker: 'PLTR', name: 'Palantir Technologies', sector: 'Technology' },
  { ticker: 'SHOP', name: 'Shopify Inc.', sector: 'Technology' },
];

const byTicker = new Map(STOCK_META.map((m) => [m.ticker, m] as const));

export function getStockMeta(ticker: string): StockMeta {
  return (
    byTicker.get(ticker.toUpperCase()) ?? {
      ticker: ticker.toUpperCase(),
      name: ticker.toUpperCase(),
      sector: '—',
    }
  );
}
