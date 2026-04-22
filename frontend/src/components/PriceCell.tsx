import { useEffect, useRef, useState } from 'react';

interface PriceCellProps {
  value: number;
  digits?: number;
  className?: string;
  prefix?: string;
}

export function PriceCell({
  value,
  digits = 2,
  className = '',
  prefix = '',
}: PriceCellProps) {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const lastRef = useRef<number>(value);
  useEffect(() => {
    if (lastRef.current !== value) {
      const dir: 'up' | 'down' = value > lastRef.current ? 'up' : 'down';
      setFlash(dir);
      lastRef.current = value;
      const id = window.setTimeout(() => setFlash(null), 600);
      return () => window.clearTimeout(id);
    }
  }, [value]);
  return (
    <span
      className={`${className} ${flash ? 'flash-' + flash : ''}`.trim()}
      style={{ padding: '2px 4px', borderRadius: 3, display: 'inline-block' }}
    >
      {prefix}
      {Number(value).toFixed(digits)}
    </span>
  );
}
