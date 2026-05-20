import { useEffect, useState } from 'react';
import App from '../App';
import { LandingPage } from '../landing/LandingPage';
import { fetchMe } from '../lib/auth';
import { replacePath, useLocation } from '../lib/router';
import type { AuthUser } from '../lib/types';

// -----------------------------------------------------------------------------
// AuthBoot — owns the boot decision per spec §6.4:
//
//   loading: brand mark + spinner. NEVER landing-page flash.
//   resolved with user:   <App user readOnly={pathname === '/demo'} />
//   resolved without user:
//     pathname === '/demo' → <App demoUser readOnly />
//     otherwise            → <LandingPage />
//
// We import the demo user contract from shared (AuthUser) but we don't have
// the actual id/email/name without /api/demo/auth/me. So when an unsigned
// user opens /demo we still call /api/auth/me — the backend returns 401 —
// and then mount App with a synthetic demoUser shape. App only reads
// user.id/email/name/pictureUrl/isDemo; the synthetic shape is enough.
// -----------------------------------------------------------------------------

const DEMO_USER: AuthUser = {
  id: '3f7c9b2e-8a41-4d6c-b5f3-1e9a72c4d8ab',
  email: 'demo@papertrade.local',
  name: 'Demo Account',
  pictureUrl: null,
  isDemo: true,
};

type Phase =
  | { kind: 'loading' }
  | { kind: 'resolved'; user: AuthUser | null };

export function AuthBoot() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const { pathname } = useLocation();

  useEffect(() => {
    let cancelled = false;
    fetchMe().then((user) => {
      if (cancelled) return;
      setPhase({ kind: 'resolved', user });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Once resolved, redirect signed-in users away from / and /login.
  useEffect(() => {
    if (phase.kind !== 'resolved') return;
    if (!phase.user) return;
    if (pathname === '/' || pathname === '/login') {
      replacePath('/app');
    }
  }, [phase, pathname]);

  if (phase.kind === 'loading') {
    return (
      <div className="auth-boot">
        <div className="auth-boot-mark">P</div>
      </div>
    );
  }

  // Resolved.
  if (phase.user) {
    // Signed in. /demo is still allowed (read-only); other paths run as the
    // signed-in user.
    return <App user={phase.user} readOnly={pathname === '/demo'} />;
  }

  // Not signed in.
  if (pathname === '/demo') {
    return <App user={DEMO_USER} readOnly />;
  }

  return <LandingPage />;
}
