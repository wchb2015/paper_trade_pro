import type { SeedStock } from './types';

// Seed universe — realistic tickers with plausible prices (fictional values, not real market data)
export const SEED_STOCKS: SeedStock[] = [
  { ticker: 'AAPL', name: 'Apple Inc.', sector: 'Technology', price: 192.48, vol: 52_341_200, mcap: '2.98T' },
  { ticker: 'MSFT', name: 'Microsoft Corp.', sector: 'Technology', price: 418.3, vol: 21_438_100, mcap: '3.11T' },
  { ticker: 'NVDA', name: 'NVIDIA Corp.', sector: 'Semiconductors', price: 912.72, vol: 38_221_900, mcap: '2.24T' },
  { ticker: 'TSLA', name: 'Tesla, Inc.', sector: 'Auto', price: 178.94, vol: 92_104_500, mcap: '568B' },
  { ticker: 'AMZN', name: 'Amazon.com, Inc.', sector: 'Retail', price: 184.22, vol: 34_902_800, mcap: '1.91T' },
  { ticker: 'META', name: 'Meta Platforms', sector: 'Technology', price: 502.18, vol: 14_220_100, mcap: '1.28T' },
  { ticker: 'GOOGL', name: 'Alphabet Inc.', sector: 'Technology', price: 167.44, vol: 22_014_300, mcap: '2.07T' },
  { ticker: 'JPM', name: 'JPMorgan Chase', sector: 'Financials', price: 201.67, vol: 8_412_300, mcap: '578B' },
  { ticker: 'V', name: 'Visa Inc.', sector: 'Financials', price: 276.51, vol: 5_102_400, mcap: '550B' },
  { ticker: 'AMD', name: 'Advanced Micro Devices', sector: 'Semiconductors', price: 158.04, vol: 41_891_200, mcap: '255B' },
  { ticker: 'NFLX', name: 'Netflix, Inc.', sector: 'Media', price: 631.22, vol: 3_902_100, mcap: '271B' },
  { ticker: 'DIS', name: 'Walt Disney Co.', sector: 'Media', price: 112.88, vol: 9_891_300, mcap: '205B' },
  { ticker: 'BA', name: 'Boeing Co.', sector: 'Industrials', price: 176.4, vol: 7_104_200, mcap: '108B' },
  { ticker: 'COIN', name: 'Coinbase Global', sector: 'Financials', price: 243.8, vol: 10_402_300, mcap: '62B' },
  { ticker: 'PLTR', name: 'Palantir Technologies', sector: 'Technology', price: 23.14, vol: 38_221_400, mcap: '51B' },
  { ticker: 'SHOP', name: 'Shopify Inc.', sector: 'Technology', price: 72.19, vol: 7_440_200, mcap: '92B' },
];
