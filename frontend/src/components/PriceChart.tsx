import { useEffect, useRef, useState } from 'react';

interface PriceChartProps {
  data: number[];
  height?: number;
  showArea?: boolean;
}

interface HoverState {
  idx: number;
  px: number;
  py: number;
}

export function PriceChart({
  data,
  height = 280,
  showArea = true,
}: PriceChartProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<HoverState | null>(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      setWidth(entries[0].contentRect.width);
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  if (!data || data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const pad = (max - min) * 0.1 || 1;
  const yMin = min - pad;
  const yMax = max + pad;
  const range = yMax - yMin;
  const leftPad = 48;
  const rightPad = 8;
  const topPad = 12;
  const botPad = 22;
  const plotW = Math.max(10, width - leftPad - rightPad);
  const plotH = Math.max(10, height - topPad - botPad);

  const x = (i: number) => leftPad + (i / (data.length - 1)) * plotW;
  const y = (v: number) => topPad + (1 - (v - yMin) / range) * plotH;

  const linePts = data.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const areaPts = `${leftPad},${y(yMin)} ${linePts} ${leftPad + plotW},${y(yMin)}`;
  const isUp = data[data.length - 1] >= data[0];
  const color = isUp ? 'var(--up)' : 'var(--down)';

  const gridLines = 4;
  const yTicks = Array.from(
    { length: gridLines + 1 },
    (_, i) => yMin + (range * i) / gridLines,
  );

  const xTicks = 5;
  const today = new Date();
  const labels = Array.from({ length: xTicks + 1 }, (_, i) => {
    const d = new Date(today);
    d.setDate(
      d.getDate() - (xTicks - i) * Math.floor(data.length / xTicks / 1),
    );
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < leftPad || px > leftPad + plotW) {
      setHover(null);
      return;
    }
    const idx = Math.round(((px - leftPad) / plotW) * (data.length - 1));
    const clamped = Math.max(0, Math.min(data.length - 1, idx));
    setHover({ idx: clamped, px, py: y(data[clamped]) });
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
              {v.toFixed(2)}
            </text>
          </g>
        ))}

        {labels.map((lbl, i) => {
          const xp = leftPad + (i / xTicks) * plotW;
          return (
            <text
              key={i}
              x={xp}
              y={height - 6}
              fontSize="10"
              textAnchor="middle"
              fill="var(--text-muted)"
              fontFamily="JetBrains Mono, monospace"
            >
              {lbl}
            </text>
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
          <span className="mono" style={{ fontWeight: 600 }}>
            ${data[hover.idx].toFixed(2)}
          </span>
        </div>
      )}
    </div>
  );
}
