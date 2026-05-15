# Environment File

This repo uses a **single `.env` at the repo root** that serves both the backend (Node/Express + Socket.io) and the frontend (Vite). There is no `backend/.env` or `frontend/.env.local`.

## TL;DR — first-time setup

```bash
cp .env.example .env
$EDITOR .env   # set APCA_KEY_ID, APCA_SECRET_KEY, DATABASE_URL
```

For Alpaca credentials:

```
APCA_KEY_ID=<your Alpaca key id>
APCA_SECRET_KEY=<your Alpaca secret key>
```

> **Naming note:** Alpaca's docs use hyphenated HTTP header names — `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY`. This codebase reads them as underscore-cased env vars: `APCA_KEY_ID` and `APCA_SECRET_KEY` (see `backend/src/config.ts:100-101`). Same values, different casing.

Use the **paper-trading** keys from <https://app.alpaca.markets/paper/dashboard/overview>. The same keys authenticate market-data REST + WebSocket.

## How loading works

| Side | Loaded by | Mechanism |
|---|---|---|
| Backend | `dotenv` | `backend/src/server.ts` and `backend/scripts/fetchTrades.ts` call `dotenv.config({ path: path.resolve(__dirname, "../../.env") })`. Resolves the same `.env` regardless of cwd. |
| Frontend | Vite | `frontend/vite.config.ts` sets `envDir: '..'`, pointing Vite at the repo root. Vite then exposes only `VITE_*` vars to the client bundle. |

The two sides read disjoint sets of vars — backend reads bare names (`APCA_KEY_ID`, `DATABASE_URL`, …), frontend reads only `VITE_*` — so there are no collisions and Vite will never leak backend secrets to the browser.

> **Footgun:** Never prefix a secret with `VITE_`. Vite inlines every `VITE_*` value into the client bundle at build time, so anything with that prefix is publicly visible.

## File map

| File | Tracked? | Purpose |
|---|---|---|
| `.env.example` (root) | yes | Template documenting every var both sides read. Copy to `.env`. |
| `.env` (root) | **no** (gitignored) | The real values — Alpaca creds, Postgres URL, frontend overrides. |

`.gitignore` excludes `.env`, `.env.local`, `.env.test`, `.env.prod`, and `.env.*.local` everywhere in the tree.

## Backend env vars

Validated at startup in `backend/src/config.ts` — missing required vars throw immediately so we fail fast rather than 500 on the first request.

> **Ports / URLs** (`BACKEND_PORT`, `FRONTEND_DEV_PORT`, `BACKEND_URL`, `FRONTEND_DEV_URL`) are configured in `ports.cjs` at the repo root, **not** in `.env`. `backend/src/config.ts` and `frontend/vite.config.ts` `require()` it directly and throw if any key is missing.

### Required

| Var | Example | Notes |
|---|---|---|
| `APCA_KEY_ID` | `PK…` | Alpaca paper-account key id (`APCA-API-KEY-ID` header). |
| `APCA_SECRET_KEY` | `…` | Alpaca paper-account secret (`APCA-API-SECRET-KEY` header). |
| `DATABASE_URL` | `postgresql://user:pass@host/db?sslmode=require` | Neon Postgres pooled URL. Schema `paper_trade_pro` must exist. |

### Optional (with defaults)

| Var | Default | Purpose |
|---|---|---|
| `PRICE_PROVIDER` | `alpaca` | `alpaca` (live WS) or `replay` (NDJSON playback for off-hours dev). |
| `ALPACA_FEED` | `iex` | `iex` (free) or `sip` (paid SIP feed). |
| `ALPACA_DATA_URL` | `https://data.alpaca.markets` | Override REST data endpoint. |
| `ALPACA_STREAM_URL` | `wss://stream.data.alpaca.markets/v2/<feed>` | Override WS endpoint. |
| `CURRENT_USER_ID` | `3f7c9b2e-8a41-4d6c-b5f3-1e9a72c4d8ab` | Pre-auth single-user scope; replace with session subject when login lands. |
| `INITIAL_CASH` | `100000` | Starting cash for new accounts and `/api/portfolio/reset`. |
| `REPLAY_DATE` | `2026-05-01` | Folder under `backend/.replay-cache/` to replay (only when `PRICE_PROVIDER=replay`). |
| `REPLAY_SPEED` | `1` | `1` real-time, `10` ten-times faster, `0` as-fast-as-possible. |
| `REPLAY_LOOP` | `true` | Restart from the beginning after EOD so the feed never dies. |
| `REPLAY_CACHE_DIR` | `backend/.replay-cache` | Absolute path override for the replay NDJSON root. |

## Frontend env vars

Only `VITE_*` vars reach the browser. `VITE_BACKEND_URL` is injected at build time from `ports.cjs` via `vite.config.ts` `define` — it is **not** read from `.env`. The remaining knobs below are optional with defaults in `frontend/src/config.ts`.

| Var | Default | Purpose |
|---|---|---|
| `VITE_SNAPSHOT_REFRESH_MS` | `30000` | Cadence for re-fetching snapshots over REST. The socket delivers ticks continuously; this covers bid/ask/OHLC drift. |
| `VITE_STALE_AFTER_MS` | `60000` | A symbol with no tick for this long is rendered as "stale". |

## What does NOT belong in env

Rate limits, timeouts, and other typed/derived defaults are checked in:

- `backend/src/config.ts` — typed app config + validation
- `shared/src/constants.ts` — provider list, free-tier limits, shared constants

If a value is non-secret and benefits from type checking + version history, put it in code, not `.env`.
