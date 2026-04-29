import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Pay-period-aware calendar popup. Shades alternating 14-day pay-period stripes
 * so the user can see period boundaries at a glance, then click any day to select
 * its full pay period (start + end auto-filled). Anchored on the same reference
 * date the rest of the payroll system uses.
 */

const REFERENCE_START = new Date(2026, 0, 19); // Jan 19, 2026 — Mon, anchor for all 14-day stripes
const PERIOD_LENGTH = 14;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

const formatYmd = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const parseYmd = (s: string): Date => new Date(s + 'T12:00:00');

/** 0-based pay period index containing this date (negative for before reference). */
const periodIndexFor = (d: Date): number => {
  const days = Math.floor((d.getTime() - REFERENCE_START.getTime()) / MS_PER_DAY);
  return days >= 0 ? Math.floor(days / PERIOD_LENGTH) : Math.ceil(days / PERIOD_LENGTH) - 1;
};

const periodStartForIndex = (idx: number): Date => {
  return new Date(REFERENCE_START.getTime() + idx * PERIOD_LENGTH * MS_PER_DAY);
};

const periodBoundsForDate = (d: Date): { start: Date; end: Date; index: number } => {
  const idx = periodIndexFor(d);
  const start = periodStartForIndex(idx);
  const end = new Date(start.getTime() + (PERIOD_LENGTH - 1) * MS_PER_DAY);
  return { start, end, index: idx };
};

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

interface Props {
  value: { start: string; end: string };
  onChange: (range: { start: string; end: string }) => void;
  onClose: () => void;
  /** Optional label shown above the calendar grid. */
  title?: string;
}

export default function PayPeriodCalendar({ value, onChange, onClose, title }: Props) {
  // Initialize the visible month from the current selection so the user lands on it.
  const initialMonth = useMemo(() => {
    const d = value.start ? parseYmd(value.start) : new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }, [value.start]);

  const [viewMonth, setViewMonth] = useState<Date>(initialMonth);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) onClose();
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  const today = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }, []);

  const selectedRange = useMemo(() => {
    if (!value.start || !value.end) return null;
    return { start: parseYmd(value.start), end: parseYmd(value.end) };
  }, [value.start, value.end]);

  // Build a 6×7 grid starting from the Monday on/before the 1st of viewMonth.
  const cells = useMemo(() => {
    const firstOfMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
    const dayOfWeek = firstOfMonth.getDay();
    // ISO-ish: week starts Monday. JS getDay() Sun=0..Sat=6 → shift so Mon=0.
    const offset = (dayOfWeek + 6) % 7;
    const gridStart = new Date(firstOfMonth);
    gridStart.setDate(firstOfMonth.getDate() - offset);
    const out: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      out.push(d);
    }
    return out;
  }, [viewMonth]);

  const goPrev = () => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1));
  const goNext = () => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1));

  const handleClickDay = (d: Date) => {
    const { start, end } = periodBoundsForDate(d);
    onChange({ start: formatYmd(start), end: formatYmd(end) });
    onClose();
  };

  const monthLabel = viewMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const weekDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div
      ref={popupRef}
      role="dialog"
      aria-label={title || 'Pick a pay period'}
      style={{
        position: 'absolute',
        top: 'calc(100% + 6px)',
        left: 0,
        zIndex: 50,
        width: '320px',
        backgroundColor: 'var(--bg-primary)',
        border: '1px solid var(--border-color)',
        borderRadius: '10px',
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.18)',
        padding: '12px',
        userSelect: 'none',
      }}
    >
      {/* Header: month nav */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <button
          type="button"
          onClick={goPrev}
          aria-label="Previous month"
          style={{ background: 'none', border: 'none', fontSize: '16px', padding: '4px 10px', cursor: 'pointer', color: 'var(--text-secondary)', borderRadius: '4px' }}
        >
          ◀
        </button>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>{monthLabel}</div>
        <button
          type="button"
          onClick={goNext}
          aria-label="Next month"
          style={{ background: 'none', border: 'none', fontSize: '16px', padding: '4px 10px', cursor: 'pointer', color: 'var(--text-secondary)', borderRadius: '4px' }}
        >
          ▶
        </button>
      </div>

      {/* Weekday header */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', marginBottom: '4px' }}>
        {weekDays.map((d) => (
          <div key={d} style={{ textAlign: 'center', fontSize: '10px', fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '4px 0' }}>
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' }}>
        {cells.map((d, i) => {
          const idx = periodIndexFor(d);
          // Alternate light shading between consecutive pay periods so stripes are visible at a glance.
          const stripeColor = idx % 2 === 0 ? 'rgba(33, 150, 243, 0.06)' : 'rgba(33, 150, 243, 0.13)';
          const isCurrentMonth = d.getMonth() === viewMonth.getMonth();
          const isHoveredPeriod = hoverIndex === idx;
          const inSelected = !!selectedRange && d >= selectedRange.start && d <= selectedRange.end;
          const isToday = sameDay(d, today);

          let bg = stripeColor;
          let textColor = isCurrentMonth ? 'var(--text-primary)' : 'var(--text-tertiary)';
          let border = '1px solid transparent';

          if (isHoveredPeriod) {
            bg = 'rgba(33, 150, 243, 0.28)';
          }
          if (inSelected) {
            bg = 'var(--primary-color)';
            textColor = 'white';
          }
          if (isToday) {
            border = '1px solid var(--primary-color)';
          }

          return (
            <button
              key={i}
              type="button"
              onMouseEnter={() => setHoverIndex(idx)}
              onMouseLeave={() => setHoverIndex(null)}
              onClick={() => handleClickDay(d)}
              style={{
                padding: '8px 0',
                fontSize: '12px',
                fontWeight: isToday ? 700 : 500,
                cursor: 'pointer',
                backgroundColor: bg,
                color: textColor,
                border,
                borderRadius: '4px',
                fontFamily: 'inherit',
                transition: 'background-color 0.1s',
              }}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>

      {/* Footer hint */}
      <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px solid var(--border-color)', fontSize: '11px', color: 'var(--text-tertiary)', textAlign: 'center', lineHeight: 1.4 }}>
        Click any day to select its full 14-day pay period.
        <br />
        Stripes show consecutive periods.
      </div>
    </div>
  );
}
