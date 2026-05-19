/**
 * Pay-period boundaries shared across Payroll, the calendar popup, and any other page
 * that needs to align with the same 14-day cycle. Anchored on Mon Jan 19 2026.
 */

const REFERENCE_START = new Date(2026, 0, 19); // Jan 19, 2026 — Monday
const PERIOD_LENGTH = 14;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

export const PAY_PERIOD_LENGTH_DAYS = PERIOD_LENGTH;

/** 0-based pay-period index containing this date (negative for periods before the anchor). */
export function payPeriodIndexFor(d: Date): number {
  const days = Math.floor((d.getTime() - REFERENCE_START.getTime()) / MS_PER_DAY);
  return days >= 0 ? Math.floor(days / PERIOD_LENGTH) : Math.ceil(days / PERIOD_LENGTH) - 1;
}

export function payPeriodStartForIndex(idx: number): Date {
  return new Date(REFERENCE_START.getTime() + idx * PERIOD_LENGTH * MS_PER_DAY);
}

/** Inclusive bounds (start + end Date objects) and the period index for a given day. */
export function payPeriodBoundsForDate(d: Date): { start: Date; end: Date; index: number } {
  const idx = payPeriodIndexFor(d);
  const start = payPeriodStartForIndex(idx);
  const end = new Date(start.getTime() + (PERIOD_LENGTH - 1) * MS_PER_DAY);
  return { start, end, index: idx };
}

/** YYYY-MM-DD formatter for storage / map keys. */
export function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse a YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss string at noon local time (avoids TZ off-by-one). */
export function parseYmdAtNoon(ymd: string): Date {
  const cleaned = String(ymd || '').split('T')[0].split(' ')[0];
  return new Date(`${cleaned}T12:00:00`);
}

/** Bounds for the pay period containing the given YYYY-MM-DD string. */
export function payPeriodBoundsForYmd(ymd: string): { start: Date; end: Date; index: number; startYmd: string; endYmd: string } {
  const bounds = payPeriodBoundsForDate(parseYmdAtNoon(ymd));
  return {
    ...bounds,
    startYmd: formatYmd(bounds.start),
    endYmd: formatYmd(bounds.end),
  };
}

/** Friendly date-range label, e.g. "Apr 6 – Apr 19, 2026" (or with year prefix when the range spans Jan-1). */
export function formatPayPeriodRangeLabel(start: Date, end: Date): string {
  const sameYear = start.getFullYear() === end.getFullYear();
  const startStr = start.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  const endStr = end.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `${startStr} – ${endStr}`;
}
