import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { getLogger } from '@chongbei/web-basics/server';
import { loadConfig } from '../config';
import { buildAuthorizeUrl, verifyCallback } from './google';
import { upsertGoogleUser, getUserById } from './users';
import { createSession, deleteSession, getSessionUser } from './sessions';
import type { AuthMeResponse } from '../../../shared/src';

const log = getLogger('auth.routes');

// -----------------------------------------------------------------------------
// /api/auth/* routes. The four entry points:
//
//   GET  /api/auth/google/start    302 to Google
//   GET  /api/auth/google/callback consume code, set cookie, 302 to /app
//   GET  /api/auth/me              { user } | 401
//   POST /api/auth/logout          delete session row, clear cookie, 200
//
// Errors redirect to `/?error=<code>&ref=<reqRef>` so the landing page can
// surface a banner. The state cookie is a separate short-lived cookie
// (`ptp_oauth_state`, 10 min) so rotating it doesn't touch the session
// cookie's expiry.
// -----------------------------------------------------------------------------

const STATE_COOKIE = 'ptp_oauth_state';
const STATE_LIFETIME_MS = 10 * 60 * 1000;
const DEMO_USER_ID = '3f7c9b2e-8a41-4d6c-b5f3-1e9a72c4d8ab';

function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

function setStateCookie(res: Response, value: string): void {
  res.cookie(STATE_COOKIE, value, {
    httpOnly: true,
    secure: isProd(),
    sameSite: 'lax',
    path: '/',
    maxAge: STATE_LIFETIME_MS,
  });
}

function clearStateCookie(res: Response): void {
  res.clearCookie(STATE_COOKIE, { path: '/' });
}

function setSessionCookie(res: Response, sid: string, expiresAt: Date): void {
  const cfg = loadConfig();
  res.cookie(cfg.sessionCookieName, sid, {
    httpOnly: true,
    secure: isProd(),
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

function clearSessionCookie(res: Response): void {
  const cfg = loadConfig();
  res.clearCookie(cfg.sessionCookieName, { path: '/' });
}

/** Read the request `ref` set by attachRef so we can echo it on errors. */
function reqRef(req: Request): string {
  const v = (req as unknown as { ref?: string }).ref;
  return typeof v === 'string' && v.length > 0 ? v : '';
}

function redirectError(
  res: Response,
  req: Request,
  code:
    | 'auth_state'
    | 'auth_verify'
    | 'auth_db'
    | 'auth_misconfig'
    | 'auth_cancelled',
): void {
  const ref = reqRef(req);
  const qs = new URLSearchParams({ error: code });
  if (ref) qs.set('ref', ref);
  res.redirect(`/?${qs.toString()}`);
}

export function createAuthRouter(): Router {
  const router = Router();

  // ---- /api/auth/google/start ---------------------------------------------
  router.get('/auth/google/start', (req: Request, res: Response) => {
    try {
      const cfg = loadConfig();
      if (!cfg.googleClientId) {
        log.error(
          { authOp: 'start' },
          'ERROR /auth/google/start with no GOOGLE_CLIENT_ID configured',
        );
        return redirectError(res, req, 'auth_misconfig');
      }
      const state = crypto.randomBytes(16).toString('base64url');
      setStateCookie(res, state);
      const url = buildAuthorizeUrl(state);
      log.info({ authOp: 'start' }, 'redirecting to Google');
      return res.redirect(url);
    } catch (err) {
      log.error({ err, authOp: 'start' }, 'ERROR /auth/google/start failed');
      return redirectError(res, req, 'auth_misconfig');
    }
  });

  // ---- /api/auth/google/callback ------------------------------------------
  router.get('/auth/google/callback', async (req: Request, res: Response) => {
    // Google can return ?error=access_denied if the user clicks Cancel.
    if (typeof req.query.error === 'string') {
      log.info({ authOp: 'callback', err: req.query.error }, 'user cancelled');
      clearStateCookie(res);
      return redirectError(res, req, 'auth_cancelled');
    }

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const stateCookie =
      typeof req.cookies?.[STATE_COOKIE] === 'string'
        ? (req.cookies[STATE_COOKIE] as string)
        : '';
    clearStateCookie(res);

    if (!code || !state || !stateCookie || state !== stateCookie) {
      log.warn(
        { authOp: 'callback', hasCode: !!code, stateMatch: state === stateCookie },
        'WARN auth callback state mismatch',
      );
      return redirectError(res, req, 'auth_state');
    }

    let profile;
    try {
      profile = await verifyCallback(code);
    } catch (err) {
      log.error(
        { err, authOp: 'callback' },
        'ERROR /auth/google/callback verify failed',
      );
      return redirectError(res, req, 'auth_verify');
    }

    let user;
    let session;
    try {
      user = await upsertGoogleUser(profile);
      session = await createSession(user.id);
    } catch (err) {
      log.error(
        { err, authOp: 'callback' },
        'ERROR /auth/google/callback DB write failed',
      );
      return redirectError(res, req, 'auth_db');
    }

    setSessionCookie(res, session.id, session.expiresAt);
    log.info({ authOp: 'callback', userId: user.id }, 'sign-in success');
    return res.redirect('/app');
  });

  // ---- /api/auth/me --------------------------------------------------------
  router.get('/auth/me', async (req: Request, res: Response) => {
    try {
      const cfg = loadConfig();
      // Mirror requireAuth's contract but never 500 — this endpoint is
      // polled at boot, including by the landing page; transient flakes
      // should look like "not signed in", not "fatal error".
      if (cfg.bypassAuth) {
        const u = await getUserById(DEMO_USER_ID);
        if (!u) return res.status(401).json({ error: { code: 'unauthenticated' } });
        const body: AuthMeResponse = { user: u };
        return res.json(body);
      }
      const sid = req.cookies?.[cfg.sessionCookieName];
      if (typeof sid !== 'string' || sid.length === 0) {
        return res.status(401).json({ error: { code: 'unauthenticated' } });
      }
      const user = await getSessionUser(sid);
      if (!user) {
        return res.status(401).json({ error: { code: 'unauthenticated' } });
      }
      const body: AuthMeResponse = { user };
      return res.json(body);
    } catch (err) {
      log.error({ err, authOp: 'me' }, 'ERROR /auth/me failed');
      return res.status(401).json({ error: { code: 'unauthenticated' } });
    }
  });

  // ---- /api/auth/logout ---------------------------------------------------
  router.post('/auth/logout', async (req: Request, res: Response) => {
    try {
      const cfg = loadConfig();
      const sid = req.cookies?.[cfg.sessionCookieName];
      if (typeof sid === 'string' && sid.length > 0) {
        await deleteSession(sid);
      }
      clearSessionCookie(res);
      log.info({ authOp: 'logout' }, 'logout');
      return res.json({ ok: true });
    } catch (err) {
      log.error({ err, authOp: 'logout' }, 'ERROR /auth/logout failed');
      // Even on error, clear the cookie — the user should not be stuck.
      clearSessionCookie(res);
      return res.status(500).json({ error: { code: 'logout_failed' } });
    }
  });

  return router;
}
