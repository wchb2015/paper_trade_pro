// Formatters for currency, percentages, numbers, volume, and relative time

interface MoneyOpts {
  signed?: boolean;
  digits?: number;
}

interface PctOpts {
  signed?: boolean;
  digits?: number;
}

export const fmtMoney = (n: number | null | undefined, opts: MoneyOpts = {}): string => {
  const { signed = false, digits = 2 } = opts;
  if (n == null || Number.isNaN(n)) return '—';
  const sign = signed && n > 0 ? '+' : '';
  return (
    sign +
    n.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
  );
};

export const fmtPct = (n: number | null | undefined, opts: PctOpts = {}): string => {
  const { signed = true, digits = 2 } = opts;
  if (n == null || Number.isNaN(n)) return '—';
  const sign = signed && n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
};

export const fmtVol = (n: number | null | undefined): string => {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
};

export const timeAgo = (ts: number): string => {
  const d = Date.now() - ts;
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
};
