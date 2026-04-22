interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  stroke?: string;
}

export function Sparkline({
  data,
  width = 80,
  height = 28,
  stroke,
}: SparklineProps) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const points = data
    .map(
      (v, i) =>
        `${i * step},${height - ((v - min) / range) * (height - 4) - 2}`,
    )
    .join(' ');
  const isUp = data[data.length - 1] >= data[0];
  const color = stroke || (isUp ? 'var(--up)' : 'var(--down)');
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
