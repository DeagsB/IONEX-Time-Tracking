/**
 * Billable / payroll week: Monday–Sunday in local timezone.
 * Matches the main calendar week (WeekView) and dashboard chart grouping.
 */

function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Monday of the calendar week containing `anchor` (week is Mon–Sun). */
export function startOfWeekMonday(anchor: Date): Date {
  const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const dow = d.getDay();
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  d.setDate(d.getDate() - daysFromMonday);
  return d;
}

/** YYYY-MM-DD of the Monday for the week containing this date string (local, noon parse avoids DST edge cases). */
export function localMondayWeekStartKey(isoDateStr: string): string {
  const d = new Date(`${isoDateStr.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return isoDateStr.slice(0, 10);
  return toYmd(startOfWeekMonday(d));
}

/** Current Mon–Sun week plus the prior full week, as YYYY-MM-DD bounds and a display label. */
export function getMondaySundayWeekBounds(anchor: Date): {
  weekStart: string;
  weekEnd: string;
  prevWeekStart: string;
  prevWeekEnd: string;
  label: string;
} {
  const ws = startOfWeekMonday(anchor);
  const we = new Date(ws);
  we.setDate(ws.getDate() + 6);
  const pws = new Date(ws);
  pws.setDate(ws.getDate() - 7);
  const pwe = new Date(ws);
  pwe.setDate(ws.getDate() - 1);
  const weekStart = toYmd(ws);
  const weekEnd = toYmd(we);
  const label = `${ws.toLocaleString('en', { month: 'short', day: 'numeric' })} – ${we.toLocaleString('en', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  return {
    weekStart,
    weekEnd,
    prevWeekStart: toYmd(pws),
    prevWeekEnd: toYmd(pwe),
    label,
  };
}
