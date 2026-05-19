// Reusable date-range model + presets for the DateRangePicker component.
// Dates here are LOCAL — they represent calendar days as the user perceives
// them. Conversion to UTC ms (for filtering UTC-stored timestamps) happens
// only at the consumer boundary via `rangeWindow` (see CLAUDE.md timezone
// rule: convert at the edges).

export type DateRangePresetId =
  | 'today'
  | 'yesterday'
  | '7d'
  | 'this_week'
  | 'last_week'
  | '30d'
  | 'this_month'
  | 'last_month'
  | 'ytd'
  | 'all'
  | 'custom';

export interface DateRangeValue {
  presetId: DateRangePresetId;
  from: Date | null; // local start-of-day; null when presetId === 'all'
  to: Date | null;   // local end-of-day;   null when presetId === 'all'
}

export interface DateRangePreset {
  id: DateRangePresetId;
  label: string;
}

export const DEFAULT_PRESETS: DateRangePreset[] = [
  { id: 'today',      label: 'Today' },
  { id: 'yesterday',  label: 'Yesterday' },
  { id: '7d',         label: 'Last 7 days' },
  { id: 'this_week',  label: 'This week' },
  { id: 'last_week',  label: 'Last week' },
  { id: '30d',        label: 'Last 30 days' },
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'ytd',        label: 'Year to date' },
  { id: 'all',        label: 'Lifetime' },
];

const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const endOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const startOfWeek = (d: Date, weekStartsOn: 0 | 1) => {
  const x = startOfDay(d);
  const offset = (x.getDay() - weekStartsOn + 7) % 7;
  return addDays(x, -offset);
};
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d: Date) =>
  endOfDay(new Date(d.getFullYear(), d.getMonth() + 1, 0));
const startOfYear = (d: Date) => new Date(d.getFullYear(), 0, 1);

export function presetToRange(
  id: DateRangePresetId,
  weekStartsOn: 0 | 1 = 0,
  now: Date = new Date(),
): { from: Date | null; to: Date | null } {
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  switch (id) {
    case 'today':
      return { from: todayStart, to: todayEnd };
    case 'yesterday': {
      const y = addDays(todayStart, -1);
      return { from: y, to: endOfDay(y) };
    }
    case '7d':
      return { from: addDays(todayStart, -6), to: todayEnd };
    case 'this_week':
      return { from: startOfWeek(now, weekStartsOn), to: todayEnd };
    case 'last_week': {
      const s = addDays(startOfWeek(now, weekStartsOn), -7);
      return { from: s, to: endOfDay(addDays(s, 6)) };
    }
    case '30d':
      return { from: addDays(todayStart, -29), to: todayEnd };
    case 'this_month':
      return { from: startOfMonth(now), to: todayEnd };
    case 'last_month': {
      const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return { from: lm, to: endOfMonth(lm) };
    }
    case 'ytd':
      return { from: startOfYear(now), to: todayEnd };
    case 'all':
    case 'custom':
      return { from: null, to: null };
  }
}

export function defaultRange(
  id: DateRangePresetId = '30d',
  weekStartsOn: 0 | 1 = 0,
): DateRangeValue {
  const r = presetToRange(id, weekStartsOn);
  return { presetId: id, from: r.from, to: r.to };
}

// Convert a DateRangeValue to a UTC ms [from, to] window suitable for
// filtering timestamp data. 'all'/missing endpoints become an unbounded
// window.
export function rangeWindow(v: DateRangeValue): { from: number; to: number } {
  if (!v.from || !v.to) return { from: 0, to: Number.POSITIVE_INFINITY };
  return { from: v.from.getTime(), to: v.to.getTime() };
}

export function formatRangeLabel(
  v: DateRangeValue,
  presets: DateRangePreset[] = DEFAULT_PRESETS,
): string {
  if (v.presetId !== 'custom') {
    return presets.find((p) => p.id === v.presetId)?.label ?? 'Range';
  }
  if (!v.from || !v.to) return 'Custom';
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  if (
    v.from.getFullYear() === v.to.getFullYear() &&
    v.from.getMonth() === v.to.getMonth() &&
    v.from.getDate() === v.to.getDate()
  ) {
    return fmt(v.from);
  }
  return `${fmt(v.from)} → ${fmt(v.to)}`;
}
