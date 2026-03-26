/**
 * Hours of a time entry that fall on a given date (splits overnight entries by midnight).
 * Use for day totals and for including overnight rollover on the next day.
 */
export function getEntryHoursOnDate(entry: any, dateStr: string): number {
  if (!entry.start_time || !entry.end_time) {
    return entry.date === dateStr ? Number(entry.hours) || 0 : 0;
  }
  const dayStart = new Date(dateStr + 'T00:00:00').getTime();
  const dayEnd = new Date(dateStr + 'T23:59:59.999').getTime();
  const startMs = new Date(entry.start_time).getTime();
  const endMs = new Date(entry.end_time).getTime();
  const overlapStart = Math.max(startMs, dayStart);
  const overlapEnd = Math.min(endMs, dayEnd);
  if (overlapStart >= overlapEnd) return 0;
  return (overlapEnd - overlapStart) / (1000 * 60 * 60);
}
