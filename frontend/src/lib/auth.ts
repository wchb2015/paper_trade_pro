import type { AuthUser, AuthMeResponse } from '../../../shared/src';

// -----------------------------------------------------------------------------
// Auth client. Bypasses the @chongbei/web-basics `api()` helper because:
//   - 401 from /api/auth/me is the *normal* not-signed-in case; we don't
//     want a toast on it.
//   - We control the redirect after sign-out (page reload, not navigate).
// -----------------------------------------------------------------------------

export const GOOGLE_LOGIN_PATH = '/api/auth/google/start';

/**
 * Read the current user from the session cookie. Returns null when not
 * signed in (401), and also when the request fails for any other reason —
 * AuthBoot treats every miss as "show the landing page", which is the
 * least-surprising behavior on a transient network blip.
 */
export async function fetchMe(): Promise<AuthUser | null> {
  try {
    const res = await fetch('/api/auth/me', {
      credentials: 'same-origin',
    });
    if (res.status === 401) return null;
    if (!res.ok) {
      console.error(
        `[auth] ERROR /api/auth/me returned ${res.status} ${res.statusText}`,
      );
      return null;
    }
    const body: AuthMeResponse = await res.json();
    return body.user;
  } catch (err) {
    console.error('[auth] EXCEPTION /api/auth/me', err);
    return null;
  }
}

/**
 * Server clears the session row + cookie; we then hard-reload to '/' so the
 * SPA boot path takes us through AuthBoot fresh.
 */
export async function signOut(): Promise<void> {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
  } catch (err) {
    console.error('[auth] ERROR /api/auth/logout', err);
    // Reload anyway — the browser will drop the cookie if it was cleared.
  } finally {
    window.location.assign('/');
  }
}
