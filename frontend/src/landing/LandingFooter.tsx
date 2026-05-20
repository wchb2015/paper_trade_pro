import { Icon } from '../components/Icon';
import { usePersistedState } from '../hooks/usePersistedState';
import { useThemeStyles } from '../hooks/useThemeStyles';
import type { Theme } from '../lib/types';

const TWEAK_DEFAULTS = {
  accent: '#4f46e5',
  gainColor: '#059669',
  lossColor: '#e11d48',
};

export function LandingFooter() {
  const [theme, setTheme] = usePersistedState<Theme>('ptp_theme', 'light');
  // Apply theme + default tweaks to the document root so the landing
  // page's CSS variables react. The app remounts useThemeStyles when it
  // takes over; calling it here too is intentional duplication so the
  // landing page also respects the toggle.
  useThemeStyles(theme, TWEAK_DEFAULTS);

  return (
    <footer className="landing-footer">
      <span>© 2026 Paper Trade Pro</span>
      <span>·</span>
      <span>Paper-only — simulated funds, real market data</span>
      <div className="right">
        <a href="https://github.com" target="_blank" rel="noreferrer">
          GitHub
        </a>
        <button
          type="button"
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          className="demo-btn"
          style={{ padding: '6px 10px', fontSize: 12 }}
          aria-label="Toggle theme"
          title="Toggle theme"
        >
          <Icon name={theme === 'light' ? 'moon' : 'sun'} size={14} />
        </button>
      </div>
    </footer>
  );
}
