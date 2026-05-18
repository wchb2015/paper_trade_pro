// Formatters for currency, percentages, numbers, and relative time

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

export const timeAgo = (ts: number): string => {
  const d = Date.now() - ts;
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
};

// Renders a UTC ms timestamp in the user's local timezone. Per the timezone
// golden rule, conversion happens only at the display edge — `ts` is UTC ms,
// the browser handles the local-zone conversion.
export const fmtLocalTime = (ts: number): string => {
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  }
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
};
