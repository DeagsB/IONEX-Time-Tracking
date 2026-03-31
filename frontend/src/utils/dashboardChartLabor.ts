/**
 * Payroll cost for the dashboard weekly chart:
 * 1) Billable entries matched to a service ticket → that ticket’s *service date* week (Profitability rules).
 * 2) All other project time (non-billable + unmatched billable) → the time entry’s calendar week (full cost picture).
 */

import {
  buildSharedMapsByProject,
  calculateBurden,
  entriesMatchingServiceTicket,
  type PayRateHistory,
  type ServiceTicketHours,
  type TimeEntry,
} from './employeeReports';

function buildRateHistoryByEmpId(rateHistory: PayRateHistory[]) {
  const map = new Map<string, PayRateHistory[]>();
  for (const r of rateHistory) {
    const list = map.get(r.employee_id) || [];
    list.push(r);
    map.set(r.employee_id, list);
  }
  map.forEach((list) => list.sort((a, b) => (a.effective_date || '').localeCompare(b.effective_date || '')));
  return map;
}

function getRatesForDate(emp: any, date: string, rateHistoryByEmpId: Map<string, PayRateHistory[]>) {
  const history = rateHistoryByEmpId.get(emp?.id);
  if (!history?.length) return emp;
  let match = history[0];
  for (const h of history) {
    if ((h.effective_date || '') <= date) match = h;
    else break;
  }
  return match;
}

/** Loaded payroll $ for one time entry (hours × pay rate × (1 + burden)); mirrors Dashboard / Profitability labor cost. */
function payrollDollarsForEntry(
  entry: TimeEntry,
  emp: any,
  rateHistoryByEmpId: Map<string, PayRateHistory[]>
): number {
  const hours = Number(entry.hours) || 0;
  if (hours <= 0) return 0;
  let payRate = 0;
  const rateType = entry.rate_type || 'Shop Time';
  if (emp) {
    const rates = getRatesForDate(emp, entry.date, rateHistoryByEmpId);
    if (rateType === 'Internal') payRate = Number(rates.internal_rate) || Number(rates.shop_pay_rate) || 0;
    else if (rateType === 'Shop Time') payRate = Number(rates.shop_pay_rate) || 0;
    else if (rateType === 'Field Time') payRate = Number(rates.field_pay_rate) || 0;
    else if (rateType === 'Travel Time') payRate = Number(rates.shop_pay_rate) || 0;
    else if (rateType === 'Shop Overtime') payRate = Number(rates.shop_ot_pay_rate) || 0;
    else if (rateType === 'Field Overtime') payRate = Number(rates.field_ot_pay_rate) || 0;
    payRate = payRate * (1 + calculateBurden(emp));
  }
  return hours * payRate;
}

function entryAttributionKey(entry: TimeEntry): string {
  if (entry.id) return `id:${entry.id}`;
  return `row:${entry.user_id}|${entry.date}|${entry.project_id}|${Number(entry.hours) || 0}|${entry.rate_type ?? ''}|${entry.start_time ?? ''}|${entry.end_time ?? ''}`;
}

/**
 * Sum payroll cost per Monday week key: matched billable labor on ticket weeks, then remaining project labor on entry weeks.
 */
export function laborCostByTicketServiceWeek(
  ticketsRaw: any[],
  allTimeEntries: any[],
  employees: any[],
  rateHistory: PayRateHistory[],
  weekStartKeyFromDate: (isoDateStr: string) => string
): Map<string, number> {
  const weekMap = new Map<string, number>();
  const empByUserId = new Map<string, any>();
  for (const e of employees) {
    if (e.user_id) empByUserId.set(e.user_id, e);
  }
  const rateHistoryByEmpId = buildRateHistoryByEmpId(rateHistory);

  const entries = allTimeEntries as TimeEntry[];
  if (entries.length === 0) return weekMap;

  const attributedKeys = new Set<string>();
  const sharedMaps = buildSharedMapsByProject(entries);

  for (const t of ticketsRaw) {
    if (!t.project_id || !t.user_id || !t.date) continue;

    const ticket: ServiceTicketHours = {
      id: t.id,
      user_id: t.user_id,
      date: String(t.date).slice(0, 10),
      total_hours: Number(t.total_hours) || 0,
      customer_id: t.customer_id,
      project_id: t.project_id,
      location: t.location ?? null,
      header_overrides: t.header_overrides ?? null,
      workflow_status: t.workflow_status,
      rejected_at: t.rejected_at ?? null,
    };

    const matched = entriesMatchingServiceTicket(entries, ticket, sharedMaps);
    const wk = weekStartKeyFromDate(ticket.date);
    for (const entry of matched) {
      attributedKeys.add(entryAttributionKey(entry));
      const emp = empByUserId.get(entry.user_id);
      const dollars = payrollDollarsForEntry(entry, emp, rateHistoryByEmpId);
      weekMap.set(wk, (weekMap.get(wk) || 0) + dollars);
    }
  }

  // Non-billable and billable-but-unmatched project time → cost in the week the hours were logged
  for (const entry of entries) {
    if (!entry.project_id) continue;
    const hours = Number(entry.hours) || 0;
    if (hours <= 0) continue;
    if (attributedKeys.has(entryAttributionKey(entry))) continue;

    const emp = empByUserId.get(entry.user_id);
    const dollars = payrollDollarsForEntry(entry, emp, rateHistoryByEmpId);
    if (dollars <= 0) continue;
    const wk = weekStartKeyFromDate(String(entry.date).slice(0, 10));
    weekMap.set(wk, (weekMap.get(wk) || 0) + dollars);
  }

  return weekMap;
}
