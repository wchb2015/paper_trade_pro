# TLS via certbot (one-time)

Assumes you've already installed nginx and pointed your domain's
A/AAAA records at the host.

## Install certbot

```bash
sudo apt install certbot python3-certbot-nginx
```

## Provision the certificate

```bash
sudo certbot --nginx -d papertrade.pro
```

This:

- Talks to Let's Encrypt to issue the certificate.
- Edits `/etc/nginx/sites-available/papertrade` to add `ssl_certificate`
  and `ssl_certificate_key` directives pointing at
  `/etc/letsencrypt/live/papertrade.pro/`.
- Reloads nginx.

## Auto-renewal

Certbot installs a systemd timer that renews automatically. Verify:

```bash
sudo systemctl list-timers | grep certbot
```

Expected: a `certbot.timer` line with the next run time.

## What if cert provisioning fails

- DNS not propagated yet → wait + re-run.
- Port 80 not reachable from the public internet → fix firewall / cloud
  rules first.
- Rate-limited (5 certs per registered domain per week) → wait.
