import { GOOGLE_LOGIN_PATH } from '../lib/auth';

interface GoogleButtonProps {
  /** Override the button label. Defaults to "Sign in with Google". */
  label?: string;
}

export function GoogleButton({ label = 'Sign in with Google' }: GoogleButtonProps) {
  // <a> not <button> — the click is a top-level navigation. Using a fetch
  // would not follow the 302 to Google, and Google's consent page can't be
  // embedded in an iframe.
  return (
    <a className="google-btn" href={GOOGLE_LOGIN_PATH}>
      <span className="g" aria-hidden="true" />
      {label}
    </a>
  );
}
