import { useCallback, useMemo, useRef, useState } from 'react';

export interface PriceChartPoint {
  /** Epoch ms. */
  t: number;
  /** Price. */
  p: number;
}

interface PriceChartProps {
  /** Legacy: bare price series. Use `points` when timestamps exist. */
  data?: number[];
  /** Time-aware series; drives real x-axis date/time labels and hover. */
  points?: PriceChartPoint[];
  height?: number;
  showArea?: boolean;
  /**
   * How to format x-axis tick labels when `points` is provided. Defaults to
   * a date label; pass 'time' for intraday charts (e.g. 1D).
   */
  xLabelMode?: 'date' | 'time';
}

interface HoverState {
  idx: number;
  px: number;
  py: number;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function PriceChart({
  data,
  points,
  height = 280,
  showArea = true,
  xLabelMode = 'date',
}: PriceChartProps) {
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<HoverState | null>(null);

  // Callback ref instead of useRef + useEffect([], …): when the chart first
  // mounts with <2 points it returns null (no wrap div ever rendered), so a
  // one-shot effect would attach the ResizeObserver to null and never re-fire
  // when the data later arrives — leaving `width` stuck at the initial 600
  // and the SVG painted into the left ~600px of a wider canvas. A callback
  // ref fires every time React attaches/detaches the wrap div, so the
  // observer connects as soon as the SVG is actually rendered.
  const roRef = useRef<ResizeObserver | null>(null);
  const wrapRef = useCallback((node: HTMLDivElement | null) => {
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    if (!node) return;
    setWidth(node.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      setWidth(entries[0].contentRect.width);
    });
    ro.observe(node);
    roRef.current = ro;
  }, []);

  // Normalize either input shape into a single array of {t, p}. When the
  // caller used the legacy `data` prop, `t` is a synthetic index — labels
  // fall back to "—" because we have no real time anchor for them.
  const series: PriceChartPoint[] = useMemo(() => {
    if (points && points.length > 0) return points;
    if (data && data.length > 0) return data.map((p, i) => ({ t: i, p }));
    return [];
  }, [points, data]);
  const hasTime = points !== undefined && points.length > 0;

  // Index boundaries where the ET calendar day rolls over between two
  // adjacent bars. Used on intraday charts to draw a separator so a 1D
  // view that spans yesterday's after-hours + today's session doesn't
  // visually fuse two days into one continuous run.
  const dayBoundaries = useMemo(() => {
    if (!hasTime || xLabelMode !== 'time') return [];
    const keyFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const labelFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
    });
    const out: { idx: number; label: string }[] = [];
    let prevKey: string | null = null;
    for (let i = 0; i < series.length; i++) {
      const d = new Date(series[i].t);
      const key = keyFmt.format(d);
      if (prevKey !== null && key !== prevKey) {
        out.push({ idx: i, label: labelFmt.format(d) });
      }
      prevKey = key;
    }
    return out;
  }, [series, hasTime, xLabelMode]);

  if (series.length < 2) return null;

  const prices = series.map((s) => s.p);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const pad = (max - min) * 0.1 || 1;
  const yMin = min - pad;
  const yMax = max + pad;
  const range = yMax - yMin;

  const gridLines = 4;
  const yTicks = Array.from(
    { length: gridLines + 1 },
    (_, i) => yMin + (range * i) / gridLines,
  );

  // Format y-axis values with locale grouping so 99996.06 renders as
  // "99,996.06" — readable AND lets us measure the widest label below to
  // compute leftPad. Without grouping, 5- and 6-digit values overflow the
  // 48px gutter and the leading digit gets clipped.
  const yLabels = yTicks.map((v) =>
    v.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
  );
  // ~6.2px per char in the 10px JetBrains-Mono used for ticks, plus an 8px
  // gutter between label and axis and a 4px breathing room on the far left.
  const maxLabelLen = yLabels.reduce((m, s) => Math.max(m, s.length), 0);
  const leftPad = Math.max(48, Math.ceil(maxLabelLen * 6.2) + 12);
  const rightPad = 8;
  const topPad = 12;
  const botPad = 22;
  const plotW = Math.max(10, width - leftPad - rightPad);
  const plotH = Math.max(10, height - topPad - botPad);

  const x = (i: number) => leftPad + (i / (series.length - 1)) * plotW;
  const y = (v: number) => topPad + (1 - (v - yMin) / range) * plotH;

  const linePts = series.map((s, i) => `${x(i)},${y(s.p)}`).join(' ');
  const areaPts = `${leftPad},${y(yMin)} ${linePts} ${leftPad + plotW},${y(yMin)}`;
  const isUp = series[series.length - 1].p >= series[0].p;
  const color = isUp ? 'var(--up)' : 'var(--down)';

  const xTicks = 5;
  const labels = Array.from({ length: xTicks + 1 }, (_, i) => {
    if (!hasTime) return '';
    const idx = Math.round((i / xTicks) * (series.length - 1));
    const t = series[idx]?.t;
    if (t == null) return '';
    return xLabelMode === 'time' ? fmtTime(t) : fmtDate(t);
  });

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < leftPad || px > leftPad + plotW) {
      setHover(null);
      return;
    }
    const idx = Math.round(((px - leftPad) / plotW) * (series.length - 1));
    const clamped = Math.max(0, Math.min(series.length - 1, idx));
    setHover({ idx: clamped, px, py: y(series[clamped].p) });
  };

  return (
    <div
      ref={wrapRef}
      style={{ position: 'relative', width: '100%' }}
      className="chart-wrap"
    >
      <svg
        width={width}
        height={height}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="area-grad-up" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--up)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--up)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="area-grad-down" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--down)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--down)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {yTicks.map((v, i) => (
          <g key={i}>
            <line
              x1={leftPad}
              x2={leftPad + plotW}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--border)"
              strokeDasharray={i === 0 || i === yTicks.length - 1 ? '0' : '2 4'}
              strokeWidth="1"
            />
            <text
              x={leftPad - 8}
              y={y(v) + 3}
              fontSize="10"
              textAnchor="end"
              fill="var(--text-muted)"
              fontFamily="JetBrains Mono, monospace"
            >
              {yLabels[i]}
            </text>
          </g>
        ))}

        {labels.map((lbl, i) => {
          const xp = leftPad + (i / xTicks) * plotW;
          // Anchor first/last labels to their plot edges so text doesn't
          // overflow the SVG viewport (which clips by default) and get cut
          // off — e.g. "13:30" centered at the right edge would lose its "0".
          const anchor =
            i === 0 ? 'start' : i === xTicks ? 'end' : 'middle';
          return (
            <text
              key={i}
              x={xp}
              y={height - 6}
              fontSize="10"
              textAnchor={anchor}
              fill="var(--text-muted)"
              fontFamily="JetBrains Mono, monospace"
            >
              {lbl}
            </text>
          );
        })}

        {dayBoundaries.map((b) => {
          // Draw the divider midway between the last bar of the previous
          // day and the first bar of the new day so it reads as a gap, not
          // as belonging to either side. Anchor the date label to the
          // right of the line (start of the new day) and keep it inside
          // the plot rect so it doesn't overflow past the right edge.
          const xLine = (x(b.idx - 1) + x(b.idx)) / 2;
          const labelMaxX = leftPad + plotW - 4;
          const xLabel = Math.min(xLine + 4, labelMaxX);
          const labelAnchor = xLabel >= labelMaxX ? 'end' : 'start';
          return (
            <g key={`day-${b.idx}`}>
              <line
                x1={xLine}
                x2={xLine}
                y1={topPad}
                y2={topPad + plotH}
                stroke="var(--border-strong)"
                strokeDasharray="3 3"
                strokeWidth="1"
                opacity="0.7"
              />
              <text
                x={xLabel}
                y={topPad + 10}
                fontSize="10"
                textAnchor={labelAnchor}
                fill="var(--text-muted)"
                fontFamily="JetBrains Mono, monospace"
              >
                {b.label}
              </text>
            </g>
          );
        })}

        {showArea && (
          <polygon
            points={areaPts}
            fill={`url(#area-grad-${isUp ? 'up' : 'down'})`}
          />
        )}
        <polyline
          points={linePts}
          fill="none"
          stroke={color}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {hover && (
          <g>
            <line
              x1={hover.px}
              x2={hover.px}
              y1={topPad}
              y2={topPad + plotH}
              stroke="var(--border-strong)"
              strokeDasharray="2 3"
            />
            <circle
              cx={x(hover.idx)}
              cy={hover.py}
              r="4"
              fill="var(--bg-elev)"
              stroke={color}
              strokeWidth="2"
            />
          </g>
        )}
      </svg>

      {hover && (
        <div
          className="chart-hover"
          style={{ left: Math.min(width - 100, hover.px + 10), top: 8 }}
        >
          <div className="mono" style={{ fontWeight: 600 }}>
            ${series[hover.idx].p.toFixed(2)}
          </div>
          {hasTime && (
            <div
              className="mono"
              style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}
            >
              {xLabelMode === 'time'
                ? fmtTime(series[hover.idx].t)
                : fmtDate(series[hover.idx].t)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
