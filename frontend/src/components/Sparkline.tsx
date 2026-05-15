import { useState } from "react";

// -----------------------------------------------------------------------------
// Sparkline: a tiny SVG line chart. Two call shapes:
//   - data: number[]  — legacy, no hover info, used by the dashboard tile.
//   - points: { t: number, p: number }[] — drives the watchlist intraday
//     column with a hover tooltip showing time + price.
// -----------------------------------------------------------------------------

export interface SparklinePoint {
  /** Epoch ms. */
  t: number;
  /** Price. */
  p: number;
}

interface SparklineProps {
  /** Legacy: bare price series. Use `points` instead when timestamps exist. */
  data?: number[];
  /** Time-aware series; enables the hover tooltip. */
  points?: SparklinePoint[];
  width?: number;
  height?: number;
  stroke?: string;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

export function Sparkline({
  data,
  points,
  width = 80,
  height = 28,
  stroke,
}: SparklineProps) {
  // Normalize to a single shape with optional timestamps.
  const series: SparklinePoint[] = points
    ? points
    : (data ?? []).map((p, i) => ({ t: i, p }));

  const [hover, setHover] = useState<number | null>(null);

  if (series.length < 2) return null;

  const prices = series.map((s) => s.p);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const step = width / (series.length - 1);

  const xy = series.map((s, i) => ({
    x: i * step,
    y: height - ((s.p - min) / range) * (height - 4) - 2,
    t: s.t,
    p: s.p,
  }));
  const polyline = xy.map((q) => `${q.x},${q.y}`).join(" ");

  const last = xy[xy.length - 1]!;
  const first = xy[0]!;
  const isUp = last.p >= first.p;
  const color = stroke || (isUp ? "var(--up)" : "var(--down)");

  // Hover handler — find nearest x. Only enabled when timestamps look real
  // (epoch ms, i.e. > some threshold). Avoids tooltip on the legacy
  // synthetic-index path where `t` is just 0,1,2,…
  const hoverable = points !== undefined;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!hoverable) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.max(
      0,
      Math.min(series.length - 1, Math.round(x / step)),
    );
    setHover(idx);
  };

  const onLeave = () => setHover(null);

  const hoverPt = hover !== null ? xy[hover] : null;

  return (
    <div
      style={{
        position: "relative",
        width,
        height,
        display: "inline-block",
      }}
    >
      <svg
        width={width}
        height={height}
        style={{ display: "block", overflow: "visible" }}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
      >
        <polyline
          points={polyline}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {hoverPt && (
          <>
            <line
              x1={hoverPt.x}
              x2={hoverPt.x}
              y1={0}
              y2={height}
              stroke="var(--text-muted)"
              strokeWidth="0.75"
              strokeDasharray="2 2"
            />
            <circle
              cx={hoverPt.x}
              cy={hoverPt.y}
              r={2.5}
              fill={color}
              stroke="var(--bg)"
              strokeWidth="1"
            />
          </>
        )}
      </svg>
      {hoverPt && (
        <div
          style={{
            position: "absolute",
            // Anchor tooltip to whichever side of the cursor has more room.
            left: hoverPt.x > width / 2 ? "auto" : hoverPt.x + 6,
            right: hoverPt.x > width / 2 ? width - hoverPt.x + 6 : "auto",
            top: -4,
            transform: "translateY(-100%)",
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "3px 6px",
            fontSize: 11,
            lineHeight: 1.3,
            color: "var(--text)",
            whiteSpace: "nowrap",
            pointerEvents: "none",
            boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
            zIndex: 10,
          }}
        >
          <div style={{ fontVariantNumeric: "tabular-nums" }}>
            ${hoverPt.p.toFixed(2)}
          </div>
          <div
            style={{
              color: "var(--text-muted)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {fmtTime(hoverPt.t)}
          </div>
        </div>
      )}
    </div>
  );
}
