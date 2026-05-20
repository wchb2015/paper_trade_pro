import type { Request, Response, NextFunction } from 'express';
import { getLogger } from '@chongbei/web-basics/server';
import { loadConfig } from '../config';
import { getSessionUser } from './sessions';
import { getUserById } from './users';
import type { AuthUser } from '../../../shared/src';

const log = getLogger('auth.middleware');

// -----------------------------------------------------------------------------
// Augment Express's Request with `user`. Every authenticated handler reads
// `req.user.id` instead of `cfg.currentUserId`. middleware.ts is the only
// place that writes to req.user.
// -----------------------------------------------------------------------------
declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

const DEMO_USER_ID = '3f7c9b2e-8a41-4d6c-b5f3-1e9a72c4d8ab';

let demoUserCache: AuthUser | null = null;
async function loadDemoUser(): Promise<AuthUser> {
  if (demoUserCache) return demoUserCache;
  const u = await getUserById(DEMO_USER_ID);
  if (!u) {
    throw new Error(
      `Demo user ${DEMO_USER_ID} not found in users table. Run ` +
        '`npm run --prefix backend db:init` to seed it.',
    );
  }
  demoUserCache = u;
  return u;
}

/**
 * Real-user gate. Reads ptp_sid, looks up the session+user, attaches to
 * `req.user`. 401 on miss/expiry.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cfg = loadConfig();
    if (cfg.bypassAuth) {
      // Dev-only path — short-circuit to demo user. Logged once at boot.
      req.user = await loadDemoUser();
      return next();
    }
    const sid = req.cookies?.[cfg.sessionCookieName];
    if (typeof sid !== 'string' || sid.length === 0) {
      res.status(401).json({ error: { code: 'unauthenticated' } });
      return;
    }
    const user = await getSessionUser(sid);
    if (!user) {
      res.status(401).json({ error: { code: 'unauthenticated' } });
      return;
    }
    req.user = user;
    next();
  } catch (err) {
    log.error(
      { err, authOp: 'requireAuth', operation: 'requireAuth' },
      'ERROR requireAuth failed',
    );
    res.status(500).json({ error: { code: 'auth_internal' } });
  }
}

/**
 * Unconditionally attach the demo user. Mounted only under /api/demo/*.
 */
export async function attachDemoUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    req.user = await loadDemoUser();
    next();
  } catch (err) {
    log.error(
      { err, authOp: 'demo_attach' },
      'ERROR attachDemoUser failed',
    );
    next(err);
  }
}

/**
 * Read-only demo gate. Mounted *after* attachDemoUser. Anything other than
 * GET (or HEAD/OPTIONS) is 403 with a clear toast-friendly code.
 */
export function readOnlyDemo(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  log.warn(
    {
      authOp: 'readonly_block',
      method: req.method,
      path: req.originalUrl,
    },
    'demo readonly block',
  );
  res.status(403).json({
    error: { code: 'demo_readonly', message: 'Sign in to trade.' },
  });
}
