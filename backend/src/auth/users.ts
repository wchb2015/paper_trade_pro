import { getPool } from '../db';
import type { GoogleProfile } from './google';
import type { AuthUser } from '../../../shared/src';

// -----------------------------------------------------------------------------
// users table — pure DB layer. No Google, no HTTP. The auth route exchanges a
// Google profile for a row here (upsert by google_sub) and returns the row's
// id to the session layer.
// -----------------------------------------------------------------------------

interface UsersRow {
  id: string;
  google_sub: string;
  email: string;
  name: string | null;
  picture_url: string | null;
}

function rowToAuthUser(row: UsersRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    pictureUrl: row.picture_url,
    isDemo: row.google_sub === 'demo',
  };
}

/**
 * Upsert by google_sub. Updates email/name/picture on every login (Google
 * profile fields drift) and bumps last_login_at. Returns the AuthUser shape
 * we hand to the rest of the app.
 */
export async function upsertGoogleUser(
  profile: GoogleProfile,
): Promise<AuthUser> {
  const sql = `
    INSERT INTO paper_trade_pro.users (google_sub, email, email_lower, name, picture_url)
    VALUES ($1, $2, lower($2), $3, $4)
    ON CONFLICT (google_sub) DO UPDATE
    SET email         = EXCLUDED.email,
        email_lower   = EXCLUDED.email_lower,
        name          = EXCLUDED.name,
        picture_url   = EXCLUDED.picture_url,
        last_login_at = now()
    RETURNING id, google_sub, email, name, picture_url
  `;
  const { rows } = await getPool().query<UsersRow>(sql, [
    profile.googleSub,
    profile.email,
    profile.name,
    profile.pictureUrl,
  ]);
  const row = rows[0];
  if (!row) {
    throw new Error('upsertGoogleUser: expected exactly one row');
  }
  return rowToAuthUser(row);
}

/** Lookup by primary key. Returns null if no row. */
export async function getUserById(id: string): Promise<AuthUser | null> {
  const { rows } = await getPool().query<UsersRow>(
    `SELECT id, google_sub, email, name, picture_url
     FROM paper_trade_pro.users
     WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return rowToAuthUser(row);
}
