/**
 * Whole seconds of a time entry that fall on a given calendar date (splits overnight at midnight).
 * Uses integer millisecond overlap then rounds to nearest second so totals don't show :59 from float drift.
 */
export function getEntryOverlapSecondsOnDate(entry: any, dateStr: string): number {
  if (!entry.start_time || !entry.end_time) {
    return entry.date === dateStr ? Math.round((Number(entry.hours) || 0) * 3600) : 0;
  }
  const dayStart = new Date(dateStr + 'T00:00:00').getTime();
  const dayEnd = new Date(dateStr + 'T23:59:59.999').getTime();
  const startMs = new Date(entry.start_time).getTime();
  const endMs = new Date(entry.end_time).getTime();
  const overlapStart = Math.max(startMs, dayStart);
  const overlapEnd = Math.min(endMs, dayEnd);
  if (overlapStart >= overlapEnd) return 0;
  return Math.round((overlapEnd - overlapStart) / 1000);
}

/**
 * Hours of a time entry that fall on a given date (splits overnight entries by midnight).
 * Derived from integer overlap seconds to avoid floating-point display glitches.
 */
export function getEntryHoursOnDate(entry: any, dateStr: string): number {
  return getEntryOverlapSecondsOnDate(entry, dateStr) / 3600;
}
