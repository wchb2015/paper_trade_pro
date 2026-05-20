const FEATURES = [
  {
    icon: 'L',
    title: 'Live data, not lookalike',
    body: 'Real Alpaca quotes, real bid/ask, real market clock — paper books, real prices.',
  },
  {
    icon: 'P',
    title: 'Lot-level P/L',
    body: 'Pick which tax lots to sell. Watch unrealized vs realized as you trade.',
  },
  {
    icon: 'A',
    title: 'Alerts & limit orders',
    body: 'Set price alerts, place limit orders. Practice patience, not just clicks.',
  },
];

export function LandingFeatures() {
  return (
    <section className="landing-features">
      {FEATURES.map((f) => (
        <article className="landing-feature" key={f.title}>
          <div className="icon">{f.icon}</div>
          <h3>{f.title}</h3>
          <p>{f.body}</p>
        </article>
      ))}
    </section>
  );
}
