import { GoogleButton } from './GoogleButton';
import { AppPreview } from './AppPreview';
import { pushPath } from '../lib/router';

export function LandingHero() {
  return (
    <section className="landing-hero">
      <div>
        <div className="landing-hero-eyebrow">Practice trading. No risk.</div>
        <h1>
          Trade real markets,<br />
          with <em>simulated cash.</em>
        </h1>
        <p className="landing-hero-lede">
          Live quotes from Alpaca. $100k starting balance. Lots, alerts,
          and a paper portfolio that behaves like the real thing.
        </p>
        <div className="landing-hero-cta">
          <GoogleButton />
          <button
            className="demo-btn"
            onClick={() => pushPath('/demo')}
            type="button"
          >
            Try the demo →
          </button>
        </div>
        <div className="landing-hero-meta">paper-only · powered by Alpaca</div>
      </div>
      <AppPreview />
    </section>
  );
}
