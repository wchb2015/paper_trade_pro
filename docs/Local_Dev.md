# Local development

Paper Trade Pro runs as two processes locally:

- **Backend** (`backend/`) — Express + Socket.io on `:5010`.
- **Frontend** (`frontend/`) — Vite dev server on `:5011`.

The browser only ever talks to **`http://localhost:5011`**. Vite's dev
proxy forwards `/api/*` and `/socket.io/*` to the backend, so the cookie
+ same-origin story is identical to production (which uses nginx).

## First-time setup

1. **Clone + install**

   ```bash
   git clone <repo>
   cd paper_trade_pro
   npm install                                  # root devDeps (concurrently)
   npm run install:all                          # frontend + backend
   ```

2. **Create your `.env`**

   ```bash
   cp .env.example .env
   ```

   Required keys:

   - `APCA_KEY_ID`, `APCA_SECRET_KEY` — Alpaca paper account.
     Sign up at https://app.alpaca.markets/paper/dashboard/overview.
   - `DATABASE_URL` — Postgres connection string (Neon dev branch is fine).

3. **Bootstrap the DB**

   ```bash
   npm run --prefix backend db:init
   ```

4. **Bring it up**

   ```bash
   npm run dev
   ```

   Open http://localhost:5011.

## After Phase 1 lands (auth)

You'll need either:

### Option A: A Google OAuth client (full flow)

In Google Cloud Console → "APIs & Services" → "Credentials" → Create OAuth
client ID (Web application). Add **two** authorized redirect URIs:

```
http://localhost:5011/api/auth/google/callback     # local dev
https://papertrade.pro/api/auth/google/callback    # prod (when you have it)
```

Then add to `.env`:

```
GOOGLE_CLIENT_ID=<from console>
GOOGLE_CLIENT_SECRET=<from console>
GOOGLE_REDIRECT_URI=http://localhost:5011/api/auth/google/callback
```

### Option B: `BYPASS_AUTH` (no Google client needed)

If you just want to poke at the app:

```
BYPASS_AUTH=1
```

This short-circuits `requireAuth` to attach the demo user. **Refused** when
`NODE_ENV=production`. Logs a `WARN` at backend startup so you'll always
notice.

## Common gotchas

- **Port already in use:** Both dev servers `strictPort`, so they exit on
  collision. Free `:5010` / `:5011` and re-run. If you have pm2 running this
  app on the same host, `pm2 stop all` before `npm run dev`.
- **Backend logs `FATAL: APCA_KEY_ID is required`:** Populate `.env`.
- **Browser shows no socket frames:** Check `vite.config.ts` proxy entry has
  `ws: true` and the backend is up.
- **Tab hits `localhost:5010`:** That's a stale build of a client module
  still using `${config.backendUrl}` — pull latest, rebuild.

## Production deploy

See `deploy/README.md` (lands in Phase 1). TL;DR: nginx serves
`frontend/dist/`, proxies `/api/` and `/socket.io/` to pm2-managed Node
on `:5010`, certbot manages TLS.
