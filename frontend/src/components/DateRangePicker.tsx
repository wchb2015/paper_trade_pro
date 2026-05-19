import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_PRESETS,
  formatRangeLabel,
  presetToRange,
  type DateRangePreset,
  type DateRangePresetId,
  type DateRangeValue,
} from '../lib/dateRange';

interface DateRangePickerProps {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
  presets?: DateRangePreset[];
  weekStartsOn?: 0 | 1;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

const WEEKDAY_LABELS_SUN: ReadonlyArray<string> = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const WEEKDAY_LABELS_MON: ReadonlyArray<string> = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const isBefore = (a: Date, b: Date) => a.getTime() < b.getTime();

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

interface MonthGridDay {
  date: Date;
  inMonth: boolean;
}

function buildMonthGrid(year: number, month: number, weekStartsOn: 0 | 1): MonthGridDay[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() - weekStartsOn + 7) % 7;
  const start = new Date(year, month, 1 - offset);
  const days: MonthGridDay[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push({ date: d, inMonth: d.getMonth() === month });
  }
  return days;
}

export function DateRangePicker({
  value,
  onChange,
  presets = DEFAULT_PRESETS,
  weekStartsOn = 0,
  disabled = false,
  className = '',
  ariaLabel = 'Date range',
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);

  // Outside-click + ESC closes the popup. Mounted only while open so the
  // listener auto-detaches when we close.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popupRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`drp ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        className="drp-trigger"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={open}
      >
        <span className="drp-trigger-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        </span>
        <span className="drp-trigger-label">{formatRangeLabel(value, presets)}</span>
        <span className="drp-trigger-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <DateRangePopup
          ref={popupRef}
          initialValue={value}
          presets={presets}
          weekStartsOn={weekStartsOn}
          ariaLabel={ariaLabel}
          onCancel={() => setOpen(false)}
          onSave={(next) => {
            onChange(next);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

interface DateRangePopupProps {
  initialValue: DateRangeValue;
  presets: DateRangePreset[];
  weekStartsOn: 0 | 1;
  ariaLabel: string;
  onCancel: () => void;
  onSave: (next: DateRangeValue) => void;
}

const DateRangePopup = ({
  ref,
  initialValue,
  presets,
  weekStartsOn,
  ariaLabel,
  onCancel,
  onSave,
}: DateRangePopupProps & { ref?: React.Ref<HTMLDivElement | null> }) => {
  // Draft is seeded from initialValue on first mount only — the parent
  // re-mounts this component each time the popup opens, so reopening picks
  // up the latest committed value automatically.
  const [draft, setDraft] = useState<DateRangeValue>(initialValue);
  // Tracks which endpoint the next click sets. After picking start, we
  // wait for end; only then is the range complete.
  const [picking, setPicking] = useState<'start' | 'end'>('start');
  const [hover, setHover] = useState<Date | null>(null);
  // Left calendar's visible month. Right always shows +1.
  const [leftMonth, setLeftMonth] = useState<Date>(() => {
    const anchor = initialValue.from ?? new Date();
    return new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1);
  });

  const rightMonth = useMemo(
    () => new Date(leftMonth.getFullYear(), leftMonth.getMonth() + 1, 1),
    [leftMonth],
  );

  const weekdayLabels = weekStartsOn === 1 ? WEEKDAY_LABELS_MON : WEEKDAY_LABELS_SUN;

  const handlePresetClick = (id: DateRangePresetId) => {
    const r = presetToRange(id, weekStartsOn);
    setDraft({ presetId: id, from: r.from, to: r.to });
    setPicking('start');
    setHover(null);
    if (r.from) {
      setLeftMonth(new Date(r.from.getFullYear(), r.from.getMonth() - 1, 1));
    }
  };

  const handleDayClick = (d: Date) => {
    const day = startOfDay(d);
    if (picking === 'start') {
      setDraft({ presetId: 'custom', from: day, to: endOfDay(day) });
      setPicking('end');
      return;
    }
    const start = draft.from ?? day;
    if (isBefore(day, start)) {
      setDraft({ presetId: 'custom', from: day, to: endOfDay(start) });
    } else {
      setDraft({ presetId: 'custom', from: startOfDay(start), to: endOfDay(day) });
    }
    setPicking('start');
  };

  // Range that's actually painted — uses live hover when picking the end
  // so the user sees the sweep before committing.
  const paintRange = useMemo(() => {
    if (draft.presetId === 'all' || !draft.from) {
      return { from: null as Date | null, to: null as Date | null };
    }
    if (picking === 'end' && hover) {
      const start = draft.from;
      const end = hover;
      return isBefore(end, start)
        ? { from: startOfDay(end), to: endOfDay(start) }
        : { from: startOfDay(start), to: endOfDay(end) };
    }
    return { from: draft.from, to: draft.to };
  }, [draft, picking, hover]);

  const dayState = (d: Date) => {
    if (!paintRange.from || !paintRange.to) {
      return { inRange: false, isStart: false, isEnd: false };
    }
    const inRange = d >= startOfDay(paintRange.from) && d <= endOfDay(paintRange.to);
    return {
      inRange,
      isStart: sameDay(d, paintRange.from),
      isEnd: sameDay(d, paintRange.to),
    };
  };

  const renderMonth = (anchor: Date, side: 'left' | 'right') => {
    const grid = buildMonthGrid(anchor.getFullYear(), anchor.getMonth(), weekStartsOn);
    const today = new Date();
    return (
      <div className="drp-month">
        <div className="drp-month-header">
          {side === 'left' ? (
            <button
              type="button"
              className="drp-nav"
              onClick={() =>
                setLeftMonth(new Date(leftMonth.getFullYear(), leftMonth.getMonth() - 1, 1))
              }
              aria-label="Previous month"
            >
              ‹
            </button>
          ) : (
            <span className="drp-nav-spacer" />
          )}
          <span className="drp-month-title">
            {anchor.toLocaleString(undefined, { month: 'long', year: 'numeric' })}
          </span>
          {side === 'right' ? (
            <button
              type="button"
              className="drp-nav"
              onClick={() =>
                setLeftMonth(new Date(leftMonth.getFullYear(), leftMonth.getMonth() + 1, 1))
              }
              aria-label="Next month"
            >
              ›
            </button>
          ) : (
            <span className="drp-nav-spacer" />
          )}
        </div>
        <div className="drp-weekdays">
          {weekdayLabels.map((w) => (
            <div key={w} className="drp-weekday">
              {w}
            </div>
          ))}
        </div>
        <div className="drp-days">
          {grid.map(({ date, inMonth }, i) => {
            if (!inMonth) return <div key={i} className="drp-day-empty" />;
            const { inRange, isStart, isEnd } = dayState(date);
            const isToday = sameDay(date, today);
            const cls = [
              'drp-day',
              inRange ? 'in-range' : '',
              isStart ? 'is-start' : '',
              isEnd ? 'is-end' : '',
              isToday ? 'is-today' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <button
                key={i}
                type="button"
                className={cls}
                onClick={() => handleDayClick(date)}
                onMouseEnter={() => setHover(date)}
                onMouseLeave={() => setHover((h) => (h && sameDay(h, date) ? null : h))}
              >
                {date.getDate()}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const canSave = draft.presetId === 'all' || (!!draft.from && !!draft.to);

  return (
    <div ref={ref} className="drp-popup" role="dialog" aria-label={ariaLabel}>
      <div className="drp-body">
        <div className="drp-presets" role="listbox" aria-label="Range presets">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`drp-preset ${draft.presetId === p.id ? 'active' : ''}`}
              onClick={() => handlePresetClick(p.id)}
              role="option"
              aria-selected={draft.presetId === p.id}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="drp-calendars">
          {renderMonth(leftMonth, 'left')}
          {renderMonth(rightMonth, 'right')}
        </div>
      </div>
      <div className="drp-footer">
        <span className="drp-tz">{tz}</span>
        <div className="drp-actions">
          <button type="button" className="drp-btn drp-btn-link" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="drp-btn drp-btn-primary"
            disabled={!canSave}
            onClick={() => onSave(draft)}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};
