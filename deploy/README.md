# Deploying Paper Trade Pro (single host, nginx + pm2)

This is the bare-metal recipe. CI/CD is out of scope.

## Prerequisites

- Ubuntu 22.04+ (or any distro with nginx + Node 20+ + pm2)
- A domain pointed at the host (A/AAAA record)
- A Postgres database (Neon prod branch recommended)
- Alpaca paper-account API keys
- A Google OAuth client (see `docs/Local_Dev.md` for setup; register the
  prod redirect URI: `https://<domain>/api/auth/google/callback`)

## Layout

```
/var/www/papertrade/             # owned by the service user (e.g. www-data)
├── frontend/dist/               # SPA static bundle (rsynced from CI or local)
├── backend/                     # backend source + node_modules + dist
└── .env                         # prod env vars (NEVER VITE_-prefixed secrets)
```

## One-time host setup

1. Install nginx, certbot, Node 20+, pm2.
2. Create the service user, clone the repo, install deps:

   ```bash
   sudo adduser --system --group papertrade
   sudo -u papertrade git clone <repo> /var/www/papertrade
   cd /var/www/papertrade
   sudo -u papertrade npm run install:all
   ```

3. Populate `/var/www/papertrade/.env` from `.env.example`. Required:

   - `DATABASE_URL` — prod Postgres
   - `APCA_KEY_ID`, `APCA_SECRET_KEY` — Alpaca paper account
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI=https://<domain>/api/auth/google/callback`
   - `NODE_ENV=production`

   Do NOT set `BYPASS_AUTH=1` — the backend will refuse to start.

4. Initialize the DB schema:

   ```bash
   sudo -u papertrade npm run --prefix backend db:init
   ```

5. Build everything:

   ```bash
   sudo -u papertrade npm run build:all
   ```

6. Start the backend with pm2:

   ```bash
   sudo -u papertrade pm2 startOrReload ecosystem.config.cjs
   sudo pm2 startup systemd -u papertrade --hp /home/papertrade
   sudo -u papertrade pm2 save
   ```

7. Install nginx config:

   ```bash
   sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/papertrade
   # Edit: replace papertrade.pro with your domain.
   sudo ln -s /etc/nginx/sites-available/papertrade /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

8. Provision TLS with certbot — see `certbot.md`.

## Subsequent deploys

```bash
sudo -u papertrade git pull
sudo -u papertrade npm run install:all
sudo -u papertrade npm run build:all
sudo -u papertrade pm2 reload ecosystem.config.cjs
```

(Frontend changes are picked up because nginx serves `frontend/dist/`
directly; no nginx reload needed unless `nginx.conf.example` itself changed.)

## Smoke test

After every deploy:

```bash
curl -i https://<domain>/api/market/clock
curl -i https://<domain>/api/auth/me   # should be 401 in incognito
```

Open `https://<domain>/` in a private window — landing page renders.
Click "Sign in with Google" — full OAuth round-trip — land at /app.
