import { useEffect, useState } from 'react';
import { LandingNav } from './LandingNav';
import { LandingHero } from './LandingHero';
import { LandingFeatures } from './LandingFeatures';
import { LandingFooter } from './LandingFooter';
import '../landing.css';

const ERROR_MESSAGES: Record<string, string> = {
  auth_state: 'Sign-in link expired — please try again.',
  auth_verify: "We couldn't verify your Google account. Try again.",
  auth_db: 'Sign-in is temporarily unavailable. Try again in a minute.',
  auth_misconfig:
    'Google sign-in is not configured on this server. Contact the operator.',
  // auth_cancelled is intentionally absent — silent return per spec §6.1.
};

function readError(): { code: string; ref: string | null } | null {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('error');
  if (!code || !(code in ERROR_MESSAGES)) return null;
  return { code, ref: params.get('ref') };
}

function clearErrorFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('error');
  url.searchParams.delete('ref');
  window.history.replaceState({}, '', url.toString());
}

export function LandingPage() {
  const [errorState, setErrorState] = useState(() => readError());
  // Clear the error param on mount so a refresh doesn't re-render the banner.
  // We keep the local state so the UI still shows it until dismissed.
  useEffect(() => {
    if (errorState) clearErrorFromUrl();
  }, [errorState]);

  return (
    <div className="landing">
      <LandingNav />
      {errorState && (
        <div className="landing-error" role="alert">
          <b>Error</b>
          <span>{ERROR_MESSAGES[errorState.code]}</span>
          {errorState.ref && (
            <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.7 }}>
              ref: {errorState.ref}
            </span>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setErrorState(null)}
          >
            ×
          </button>
        </div>
      )}
      <LandingHero />
      <div id="features" />
      <LandingFeatures />
      <LandingFooter />
    </div>
  );
}
