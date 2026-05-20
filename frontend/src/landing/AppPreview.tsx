// -----------------------------------------------------------------------------
// AppPreview — the in-app dashboard that sits in the landing hero.
//
// Static, fake data on purpose. We don't reuse PortfolioPage because:
//   - it depends on usePortfolio + useMarket which expect a real backend
//     session and a live socket;
//   - reflowing it down to "landing card" size would require duplicating
//     half of that page anyway;
//   - the mock can keep breathing room around fewer elements.
//
// It DOES use the design tokens (CSS variables in index.css), so it adapts
// to dark/light + Tweaks automatically.
// -----------------------------------------------------------------------------

const STATS = [
  { label: 'Equity', value: '$104,283.50' },
  { label: 'Day P/L', value: '+0.39%', up: true },
  { label: 'Cash', value: '$8,217.40' },
  { label: 'Open', value: '7' },
];

const CHART_PATH =
  'M0 60 L 20 50 L 40 55 L 60 35 L 80 40 L 100 22 L 120 30 L 140 20 L 160 28 L 180 12 L 200 18';
const CHART_FILL_PATH = `${CHART_PATH} L 200 80 L 0 80 Z`;

export function AppPreview() {
  return (
    <div className="app-preview" aria-hidden="true">
      <div className="app-preview-bar">
        <i /><i /><i />
        <span style={{ marginLeft: 8 }}>app.papertrade.pro / portfolio</span>
      </div>
      <div className="app-preview-body">
        <div className="app-preview-side">
          <div className="active" />
          <div style={{ width: '55%' }} />
          <div style={{ width: '40%' }} />
          <div style={{ width: '50%' }} />
          <div style={{ width: '35%' }} />
        </div>
        <div className="app-preview-main">
          <div className="app-preview-stats">
            {STATS.map((s) => (
              <div
                key={s.label}
                className={`app-preview-stat${s.up ? ' up' : ''}`}
              >
                <span className="l">{s.label}</span>
                <span className="v">{s.value}</span>
              </div>
            ))}
          </div>
          <div className="app-preview-chart">
            <svg
              viewBox="0 0 200 80"
              preserveAspectRatio="none"
              width="100%"
              height="100%"
            >
              <path d={CHART_FILL_PATH} fill="var(--accent-soft)" />
              <path
                d={CHART_PATH}
                fill="none"
                stroke="var(--accent)"
                strokeWidth="2"
              />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
