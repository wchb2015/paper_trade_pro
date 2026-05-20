import crypto from 'node:crypto';
import { getPool } from '../db';
import { loadConfig } from '../config';
import type { AuthUser } from '../../../shared/src';

// -----------------------------------------------------------------------------
// sessions table — pure DB layer. id is 32 random bytes encoded as base64url
// (43 chars). The session lifetime is read from cfg.sessionLifetimeMs at
// create time and written into expires_at; we don't bump expires_at on every
// request, only last_seen_at.
// -----------------------------------------------------------------------------

function newSessionId(): string {
  // 256 bits, base64url, no padding. Identical to RFC 4648 §5 "URL and
  // Filename safe" alphabet — all the characters are cookie-safe.
  return crypto.randomBytes(32).toString('base64url');
}

export async function createSession(userId: string): Promise<{
  id: string;
  expiresAt: Date;
}> {
  const cfg = loadConfig();
  const id = newSessionId();
  const expiresAt = new Date(Date.now() + cfg.sessionLifetimeMs);
  await getPool().query(
    `INSERT INTO paper_trade_pro.sessions (id, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [id, userId, expiresAt],
  );
  return { id, expiresAt };
}

interface JoinedRow {
  id: string;
  google_sub: string;
  email: string;
  name: string | null;
  picture_url: string | null;
}

/**
 * Look up a session id, validate it's not expired, and return the joined
 * user. Returns null on miss or expiry. Bumps last_seen_at as a side effect
 * (fire-and-forget — failure does not block the request).
 */
export async function getSessionUser(sid: string): Promise<AuthUser | null> {
  const { rows } = await getPool().query<JoinedRow>(
    `SELECT u.id, u.google_sub, u.email, u.name, u.picture_url
     FROM paper_trade_pro.sessions s
     JOIN paper_trade_pro.users u ON u.id = s.user_id
     WHERE s.id = $1
       AND s.expires_at > now()`,
    [sid],
  );
  const row = rows[0];
  if (!row) return null;
  // Bump last_seen_at — fire and forget. Log on failure instead of bubbling.
  void getPool()
    .query(
      `UPDATE paper_trade_pro.sessions SET last_seen_at = now() WHERE id = $1`,
      [sid],
    )
    .catch((err: unknown) => {
      // Avoid pulling getLogger here to keep this module dependency-light;
      // the route layer logs auth events with `authOp` already.
      console.error('ERROR sessions.bumpLastSeen failed', err);
    });
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    pictureUrl: row.picture_url,
    isDemo: row.google_sub === 'demo',
  };
}

export async function deleteSession(sid: string): Promise<void> {
  await getPool().query(`DELETE FROM paper_trade_pro.sessions WHERE id = $1`, [
    sid,
  ]);
}
