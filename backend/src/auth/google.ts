import { OAuth2Client } from 'google-auth-library';
import { getLogger } from '@chongbei/web-basics/server';
import { loadConfig } from '../config';

const log = getLogger('auth.google');

// -----------------------------------------------------------------------------
// google-auth-library wrapper. The route layer (routes.ts) handles HTTP — this
// module only knows how to talk to Google.
//
// Throws (logged) when called without GOOGLE_CLIENT_ID / SECRET / REDIRECT_URI.
// Routes that depend on this module check `cfg.googleClientId` upfront and
// return a clear 5xx (or redirect to ?error=auth_misconfig) before calling in.
// -----------------------------------------------------------------------------

const SCOPES = ['openid', 'email', 'profile'];

function makeClient(): OAuth2Client {
  const cfg = loadConfig();
  if (!cfg.googleClientId || !cfg.googleClientSecret || !cfg.googleRedirectUri) {
    throw new Error(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI must all be set',
    );
  }
  return new OAuth2Client({
    clientId: cfg.googleClientId,
    clientSecret: cfg.googleClientSecret,
    redirectUri: cfg.googleRedirectUri,
  });
}

export interface GoogleProfile {
  /** Google's stable subject id (`sub` in the id_token). */
  googleSub: string;
  email: string;
  name: string | null;
  pictureUrl: string | null;
}

/** Build the URL we 302 the user to so they can consent at Google. */
export function buildAuthorizeUrl(state: string): string {
  const client = makeClient();
  return client.generateAuthUrl({
    scope: SCOPES,
    access_type: 'online',
    prompt: 'select_account',
    state,
    include_granted_scopes: true,
  });
}

/**
 * Exchange the `code` query param from the callback for tokens, then verify
 * the id_token's signature/audience/issuer/expiry against Google's JWKs.
 * Returns the verified profile. Throws on any failure (network, bad code,
 * verify failure) — the caller logs and redirects to ?error=auth_*.
 */
export async function verifyCallback(code: string): Promise<GoogleProfile> {
  const client = makeClient();
  const cfg = loadConfig();

  // Exchange the authorization code for tokens.
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) {
    log.error(
      { authOp: 'callback', reason: 'no_id_token' },
      'ERROR Google token response did not include id_token',
    );
    throw new Error('Google token response missing id_token');
  }

  // Verify the id_token. verifyIdToken does aud + iss + exp + signature.
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: cfg.googleClientId!,
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.sub || !payload.email) {
    log.error(
      { authOp: 'callback', reason: 'invalid_payload' },
      'ERROR id_token payload missing sub/email',
    );
    throw new Error('id_token payload missing sub or email');
  }

  return {
    googleSub: payload.sub,
    email: payload.email,
    name: payload.name ?? null,
    pictureUrl: payload.picture ?? null,
  };
}
