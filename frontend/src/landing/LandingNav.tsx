import { useState } from 'react';
import { GoogleButton } from './GoogleButton';

function scrollTo(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function LandingNav() {
  const [open, setOpen] = useState(false);

  const links = [
    { id: 'features', label: 'Features' },
    { id: 'how', label: 'How it works' },
    { id: 'faq', label: 'FAQ' },
  ];

  return (
    <nav className="landing-nav">
      <div className="landing-nav-brand">
        <div className="brand-mark">P</div>
        <span>Paper Trade Pro</span>
      </div>
      <div className="landing-nav-links">
        {links.map((l) => (
          <button key={l.id} type="button" onClick={() => scrollTo(l.id)}>
            {l.label}
          </button>
        ))}
      </div>
      <div className="landing-nav-right">
        <GoogleButton />
        <button
          type="button"
          className="landing-nav-burger"
          aria-label="Open menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span />
        </button>
      </div>
      <div className={`landing-nav-sheet${open ? ' open' : ''}`}>
        {links.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => {
              setOpen(false);
              scrollTo(l.id);
            }}
          >
            {l.label}
          </button>
        ))}
        <GoogleButton />
      </div>
    </nav>
  );
}
