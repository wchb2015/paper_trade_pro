# Paper Trade Pro — Frontend

React + TypeScript + Vite SPA for a single-user paper trading simulator.
Real market data comes from the backend (see `../backend/`); this app never
talks to a market data provider directly.

## Getting started

```bash
npm install
cp .env.example .env.local   # optional — all vars have defaults
npm run dev
```

The dev server runs on `http://localhost:5173` and expects the backend at
`http://localhost:4000`. Override via `VITE_BACKEND_URL` in `.env.local`.

## Scripts

- `npm run dev` — Vite dev server with HMR
- `npm run build` — type-check (`tsc -b`) + production bundle to `dist/`
- `npm run preview` — serve the built bundle
- `npm run lint` — ESLint

## Environment

All build-time config lives in [src/config.ts](src/config.ts). Override by
setting these in `.env.local` (see [.env.example](.env.example)):

| Var | Default | Purpose |
| --- | --- | --- |
| `VITE_BACKEND_URL` | `http://localhost:4000` | Backend REST + socket origin |
| `VITE_SNAPSHOT_REFRESH_MS` | `30000` | Interval for re-fetching snapshots to refresh bid/ask/OHLC |
| `VITE_STALE_AFTER_MS` | `60000` | A symbol with no tick for this long renders as "stale" |

## Source layout

```
src/
├── App.tsx                     Top-level shell: nav, topbar, modal mounts, theme/tweaks
├── main.tsx                    ReactDOM entry
├── index.css                   Design tokens + global styles (light/dark themes)
├── config.ts                   Build-time config (reads import.meta.env)
├── components/
│   ├── AddStockModal.tsx       Watchlist add-symbol search
│   ├── Empty.tsx               Reusable empty-state block
│   ├── Icon.tsx                Inline SVG icon set
│   ├── Modal.tsx               Generic modal wrapper (Esc to close, body lock)
│   ├── NewAlertModal.tsx       Price alert creation form
│   ├── PriceCell.tsx           Flashes green/red on price change
│   ├── PriceChart.tsx          Interactive line/area chart with crosshair
│   ├── Sparkline.tsx           Minimal inline sparkline
│   └── TradeTicket.tsx         Order ticket (market/limit/stop/stop_limit/trailing/conditional)
├── hooks/
│   ├── useMarket.ts            Snapshots + WS ticks + staleness; the only price source
│   └── usePortfolio.ts         REST-backed portfolio state + per-tick order/alert evaluator
├── lib/
│   ├── format.ts               Money / percent / volume / relative time formatters
│   ├── portfolioClient.ts      Thin fetch wrapper over /api portfolio endpoints
│   ├── priceClient.ts          Socket.io client + /api/quotes + /api/subscriptions
│   ├── quote.ts                bid/ask-with-fallback + day-change helpers
│   ├── seedStocks.ts           Static ticker → {name, sector} metadata
│   └── types.ts                Frontend-local types + re-exports from shared/
└── pages/
    ├── DashboardPage.tsx       Stats, equity chart, top movers, open positions
    ├── WatchlistPage.tsx       Watchlist table + remove/trade actions
    ├── DetailPage.tsx          Single-ticker detail with price chart + order panel
    ├── PositionsPage.tsx       Open positions with add/close actions
    ├── OrdersPage.tsx          Working / filled / cancelled tabs
    ├── AlertsPage.tsx          Active & triggered alerts
    └── AccountPage.tsx         Equity stats + reset-funds flow
```

## Data flow

```
  ┌──────────────┐   REST /api/quotes, /api/subscriptions
  │              │◀──────────────────────────────────────┐
  │  useMarket   │     socket.io: price:tick, provider:status
  │  (priceCli)  │◀──────────────────────────────────────┤
  │              │───── Market ──────────────┐           │
  └──────────────┘                           │           │
                                             ▼           │
  ┌───────────────┐   REST /api/portfolio   ┌──────┐     │
  │ usePortfolio  │────▶ /api/orders etc. ──│ App  │─────┘
  │ (portfolioCli)│                         └──────┘
  └───────────────┘                             │
         │                                      ▼
         └─── per-tick order/alert evaluator ───► REST /fill, /trigger
```

- `useMarket` owns prices. Components read `Market` (a `Record<ticker, StockSnapshot>`).
- `usePortfolio` owns portfolio state. Every mutation is a REST call that returns the full refreshed `Portfolio`; local state is replaced atomically.
- The evaluator inside `usePortfolio` watches working orders and live alerts against `Market` on every tick and fires `/fill` or `/trigger` when a condition crosses, with an in-flight set to prevent double-firing.

## UI state persistence

The app stores only cosmetic/UI state (theme, current page, last detail
ticker) in `localStorage` under `ptp_*` keys. Portfolio, watchlist, orders,
and alerts are all server-authoritative.

## Styling

Global design tokens live at the top of [src/index.css](src/index.css). Dark
mode is swapped via `[data-theme='dark']` on `<html>`. Accent and gain/loss
colors can be customized at runtime via the Tweaks panel (bottom-right cog).
