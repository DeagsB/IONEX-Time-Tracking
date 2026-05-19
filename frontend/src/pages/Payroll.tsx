import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { supabase } from '../lib/supabaseClient';
import { employeesService, serviceTicketExpensesService, userExpensesService } from '../services/supabaseServices';
import { saveAs } from 'file-saver';
import { ticketExpenseReimbursementBase } from '../utils/ticketExpenseReimbursement';
import { linkedUserExpenseRedundantWithTicketExpenseLine } from '../utils/ticketExpenseReceiptMatch';
import PayPeriodCalendar from '../components/PayPeriodCalendar';
import {
  ticketExpenseRequiresLinkedReceiptForPayroll,
  ticketExpenseHasPayrollEligibleLinkedReceipt,
} from '../utils/ticketExpensePayrollEligibility';
import { startOfWeekMonday } from '../utils/localMondayWeek';

interface TimeEntry {
  id: string;
  user_id: string;
  date: string;
  hours: number;
  rate: number;
  rate_type?: string;
  billable: boolean;
  approved: boolean;
  project_id?: string;
  user?: {
    id: string;
    first_name: string;
    last_name: string;
    email: string;
  };
  project?: {
    id: string;
    name?: string;
    project_number?: string;
    customer?: {
      id: string;
      name?: string;
    };
  };
}

interface EmployeeHours {
  userId: string;
  name: string;
  email: string;
  internalShopTime: number;
  internalShopOvertime: number;
  internalTravelTime: number;
  internalFieldTime: number;
  internalFieldOvertime: number;
  shopTime: number;
  shopOvertime: number;
  travelTime: number;
  fieldTime: number;
  fieldOvertime: number;
  totalHours: number;
  internalHours: number;
  entries: TimeEntry[];
}

// Round UP to nearest 0.25 hour (quarter hour, never round down)
const roundToQuarterHour = (hours: number): number => {
  return Math.ceil(hours * 4) / 4;
};

// Fallback period: 19 Jan 2026 to 1 Feb 2026 (payday Friday 6 Feb 2026)
const FALLBACK_PERIOD = { start: '2026-01-19', end: '2026-02-01' };

const formatPeriodDate = (d: Date): string => {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// "Current" pay period for payroll purposes = the period whose payday is the
// soonest upcoming Friday (or today, if today IS payday). This is the one the
// admin is about to run payroll for. After the payday passes, "current" rolls
// forward to the next period.
//
// Reference: period 0 = 19 Jan–1 Feb 2026 → payday Friday 6 Feb 2026.
const getCurrentPayPeriod = (): { start: string; end: string } => {
  try {
    const referenceStart = new Date(2026, 0, 19); // Jan 19, 2026 = period 0 start
    const periodLengthDays = 14;
    const daysUntilPayday = 5;
    const msPerDay = 1000 * 60 * 60 * 24;

    // Period 0's payday = referenceStart + (14-1) + 5 = + 18 days.
    const referencePayday = new Date(referenceStart.getTime() + (periodLengthDays - 1 + daysUntilPayday) * msPerDay);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Smallest N such that payday(N) ≥ today, where payday(N) = referencePayday + N*14.
    const daysSincePayday0 = (today.getTime() - referencePayday.getTime()) / msPerDay;
    const periodNumber = daysSincePayday0 <= 0 ? 0 : Math.ceil(daysSincePayday0 / periodLengthDays);

    const periodStart = new Date(referenceStart.getTime() + periodNumber * periodLengthDays * msPerDay);
    const periodEnd = new Date(periodStart.getTime() + (periodLengthDays - 1) * msPerDay);

    const start = formatPeriodDate(periodStart);
    const end = formatPeriodDate(periodEnd);
    if (!start || !end || start.length !== 10 || end.length !== 10) return FALLBACK_PERIOD;
    return { start, end };
  } catch {
    return FALLBACK_PERIOD;
  }
};

/** Return the end date (YYYY-MM-DD) of the 14-day pay period that contains the given date. */
const getPeriodEndForDate = (dateStr: string): string => {
  const referenceStart = new Date(2026, 0, 19);
  const periodLengthDays = 14;
  const msPerDay = 1000 * 60 * 60 * 24;
  const d = new Date(dateStr + 'T12:00:00');
  const daysSinceRef = Math.floor((d.getTime() - referenceStart.getTime()) / msPerDay);
  const periodIndex = daysSinceRef >= 0 ? Math.floor(daysSinceRef / periodLengthDays) : Math.ceil(daysSinceRef / periodLengthDays) - 1;
  const periodEnd = new Date(referenceStart.getTime() + (periodIndex + 1) * periodLengthDays * msPerDay);
  periodEnd.setDate(periodEnd.getDate() - 1);
  const y = periodEnd.getFullYear();
  const m = String(periodEnd.getMonth() + 1).padStart(2, '0');
  const day = String(periodEnd.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// Payday is Friday, 5 days after period end. For selected range, show its payday when it's a 14-day period.
const getPaydayForRange = (start: string, end: string): string | null => {
  const startD = new Date(start + 'T12:00:00');
  const endD = new Date(end + 'T12:00:00');
  const days = Math.round((endD.getTime() - startD.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  if (days !== 14) return null;
  const payday = new Date(endD);
  payday.setDate(payday.getDate() + 5);
  return payday.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
};

/** Get start/end date strings for a preset (for comparing to current range) */
const getPresetRange = (preset: string): { start: string; end: string } | null => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const formatDate = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  let start: Date;
  let end: Date;
  switch (preset) {
    case 'currentPayPeriod': {
      const period = getCurrentPayPeriod();
      return period;
    }
    case 'previousPayPeriod': {
      const period = getCurrentPayPeriod();
      start = new Date(period.start + 'T12:00:00');
      end = new Date(period.end + 'T12:00:00');
      start.setDate(start.getDate() - 14);
      end.setDate(end.getDate() - 14);
      return { start: formatDate(start), end: formatDate(end) };
    }
    case 'thisWeek':
      start = startOfWeekMonday(today);
      return { start: formatDate(start), end: formatDate(today) };
    case 'lastWeek': {
      const thisMonday = startOfWeekMonday(today);
      start = new Date(thisMonday);
      start.setDate(thisMonday.getDate() - 7);
      end = new Date(start);
      end.setDate(start.getDate() + 6);
      return { start: formatDate(start), end: formatDate(end) };
    }
    case 'last2Weeks':
      start = new Date(today);
      start.setDate(today.getDate() - 14);
      return { start: formatDate(start), end: formatDate(today) };
    case 'thisMonth':
      start = new Date(today.getFullYear(), today.getMonth(), 1);
      end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { start: formatDate(start), end: formatDate(end) };
    case 'lastMonth':
      start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      end = new Date(today.getFullYear(), today.getMonth(), 0);
      return { start: formatDate(start), end: formatDate(end) };
    default:
      return null;
  }
};

const PRESET_KEYS = ['currentPayPeriod', 'previousPayPeriod', 'thisWeek', 'lastWeek', 'last2Weeks', 'thisMonth', 'lastMonth'] as const;

/** Daily-hours threshold above which a day is flagged as potential overtime (BC standard: 8h/day). */
const OVERTIME_DAILY_THRESHOLD = 8;
/** Weekly-hours threshold above which the week is flagged (BC standard: 40h/week). */
const OVERTIME_WEEKLY_THRESHOLD = 40;

function EmployeeProjectsAndDailyBreakdown({
  employeeName,
  userId,
  entries,
  isContractor,
  onConvertOt,
}: {
  employeeName: string;
  userId: string;
  entries: TimeEntry[];
  isContractor: boolean;
  onConvertOt?: (args: { userId: string; userName: string; date: string; dayEntries: TimeEntry[]; owedHours: number }) => void;
}) {
  // Click-to-copy support local to this breakdown card
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copy = (text: string, key: string) => {
    try {
      navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((curr) => (curr === key ? null : curr));
      }, 900);
    } catch {
      // ignore — user can still read value
    }
  };
  // Group by project
  const byProject = new Map<string, { name: string; customer: string; hours: number; byRateType: Map<string, number> }>();
  // Group by date for daily overtime check
  const byDate = new Map<string, { total: number; byRateType: Map<string, number>; entries: TimeEntry[] }>();
  // Group by ISO week for weekly overtime check
  const byWeek = new Map<string, { total: number; days: Set<string> }>();

  const isoWeekKey = (dateStr: string): string => {
    const d = new Date(dateStr + 'T12:00:00');
    const day = d.getDay() || 7; // Mon=1..Sun=7
    d.setDate(d.getDate() - day + 1); // Monday of that week
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };

  for (const e of entries) {
    const hrs = Number(e.hours) || 0;
    const projKey = e.project_id || '__none__';
    const projName = e.project?.name || (e.project_id ? 'Unknown Project' : 'Unassigned');
    const custName = e.project?.customer?.name || '';
    if (!byProject.has(projKey)) {
      byProject.set(projKey, { name: projName, customer: custName, hours: 0, byRateType: new Map() });
    }
    const p = byProject.get(projKey)!;
    p.hours += hrs;
    const rt = e.rate_type || 'Shop Time';
    p.byRateType.set(rt, (p.byRateType.get(rt) || 0) + hrs);

    if (!byDate.has(e.date)) byDate.set(e.date, { total: 0, byRateType: new Map(), entries: [] });
    const d = byDate.get(e.date)!;
    d.total += hrs;
    d.byRateType.set(rt, (d.byRateType.get(rt) || 0) + hrs);
    d.entries.push(e);

    const wk = isoWeekKey(e.date);
    if (!byWeek.has(wk)) byWeek.set(wk, { total: 0, days: new Set() });
    const w = byWeek.get(wk)!;
    w.total += hrs;
    w.days.add(e.date);
  }

  const sortedProjects = Array.from(byProject.entries()).sort((a, b) => b[1].hours - a[1].hours);
  const sortedDates = Array.from(byDate.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const fmtDate = (s: string) => {
    try {
      return new Date(s + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    } catch { return s; }
  };

  // Per-rate-type totals for daily row "OT?" check — Shop OT and Field OT counted as paid OT already.
  const isPaidOvertimeRateType = (rt: string) => rt === 'Shop Overtime' || rt === 'Field Overtime';

  return (
    <div className="payroll-breakdown">
      <div className="payroll-breakdown-title">
        Project allocation &amp; daily hours — {employeeName}
        {isContractor && <span className="payroll-tag is-contractor">Contractor</span>}
      </div>

      {/* Projects */}
      <div className="payroll-breakdown-section">
        <div className="payroll-breakdown-eyebrow">Projects ({sortedProjects.length})</div>
        {sortedProjects.length === 0 ? (
          <div className="payroll-muted" style={{ fontSize: '12px', fontStyle: 'italic' }}>No project allocations.</div>
        ) : (
          <table className="payroll-mini-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Customer</th>
                <th>Hours by rate type</th>
                <th className="is-numeric">Total</th>
              </tr>
            </thead>
            <tbody>
              {sortedProjects.map(([key, p]) => {
                const totalVal = p.hours.toFixed(2);
                const cellKey = `proj-${key}`;
                const isCopied = copiedKey === cellKey;
                return (
                  <tr key={key}>
                    <td>{p.name}</td>
                    <td className="payroll-muted">{p.customer || '—'}</td>
                    <td className="payroll-muted" style={{ fontSize: '11px' }}>
                      {Array.from(p.byRateType.entries()).map(([rt, h]) => `${rt}: ${h.toFixed(2)}h`).join(' · ')}
                    </td>
                    <td
                      className={`is-numeric payroll-copyable${isCopied ? ' is-copied' : ''}`}
                      style={{ fontWeight: 600 }}
                      onClick={() => copy(totalVal, cellKey)}
                      title={`Click to copy ${totalVal}`}
                    >
                      {totalVal}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Daily hours */}
      <div className="payroll-breakdown-section">
        <div className="payroll-breakdown-eyebrow">
          Daily hours — flagged when day &gt; {OVERTIME_DAILY_THRESHOLD}h or week &gt; {OVERTIME_WEEKLY_THRESHOLD}h
        </div>
        {sortedDates.length === 0 ? (
          <div className="payroll-muted" style={{ fontSize: '12px', fontStyle: 'italic' }}>No daily entries.</div>
        ) : (
          <table className="payroll-mini-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>By rate type</th>
                <th className="is-numeric">Total</th>
                <th style={{ textAlign: 'center' }}>OT?</th>
              </tr>
            </thead>
            <tbody>
              {sortedDates.map(([date, d]) => {
                const wk = isoWeekKey(date);
                const weekTotal = byWeek.get(wk)?.total || 0;
                const paidOt = Array.from(d.byRateType.entries())
                  .filter(([rt]) => isPaidOvertimeRateType(rt))
                  .reduce((s, [, h]) => s + h, 0);
                // Daily OT entitlement: anything over 8h in the day.
                const dailyOtEntitled = Math.max(0, d.total - OVERTIME_DAILY_THRESHOLD);
                // Outstanding = entitled minus what's already booked at an OT rate today.
                const owedHours = Math.max(0, dailyOtEntitled - paidOt);
                const dayOver = dailyOtEntitled > 0;
                const weekOver = weekTotal > OVERTIME_WEEKLY_THRESHOLD;
                return (
                  <tr key={date} className={owedHours > 0 ? 'is-flagged' : ''}>
                    <td>{fmtDate(date)}</td>
                    <td className="payroll-muted" style={{ fontSize: '11px' }}>
                      {Array.from(d.byRateType.entries()).map(([rt, h]) => `${rt}: ${h.toFixed(2)}h`).join(' · ')}
                    </td>
                    {(() => {
                      const dayVal = d.total.toFixed(2);
                      const cellKey = `day-${date}`;
                      const isCopied = copiedKey === cellKey;
                      return (
                        <td
                          className={`is-numeric payroll-copyable${isCopied ? ' is-copied' : ''}`}
                          style={{ fontWeight: dayOver ? 700 : 500, color: dayOver ? 'var(--warning-color)' : 'var(--text-primary)' }}
                          onClick={() => copy(dayVal, cellKey)}
                          title={`Click to copy ${dayVal}`}
                        >
                          {dayVal}
                        </td>
                      );
                    })()}
                    <td style={{ textAlign: 'center' }}>
                      {owedHours > 0 ? (
                        <button
                          type="button"
                          className="payroll-pill is-owed"
                          onClick={() => onConvertOt?.({ userId, userName: employeeName, date, dayEntries: d.entries, owedHours })}
                          disabled={!onConvertOt}
                          title={`Day ${d.total.toFixed(2)}h, entitled ${dailyOtEntitled.toFixed(2)}h OT, ${paidOt.toFixed(2)}h already booked at OT rate${weekOver ? ` · Week total ${weekTotal.toFixed(2)}h` : ''} — click to allocate`}
                        >
                          Owed {owedHours.toFixed(2)}h ⇢
                        </button>
                      ) : paidOt > 0 ? (
                        <span className="payroll-pill is-paid" title={`${paidOt.toFixed(2)}h booked at OT rate`}>
                          Paid {paidOt.toFixed(2)}h
                        </span>
                      ) : (
                        <span className="payroll-pill is-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function Payroll() {
  const { user, isAdmin } = useAuth();
  const { isDemoMode } = useDemoMode();
  const navigate = useNavigate();
  
  // Default to current pay period (19 Jan–1 Feb 2026 until payday 6 Feb, then next period)
  const [startDate, setStartDate] = useState(() => {
    const period = getCurrentPayPeriod();
    return period?.start || FALLBACK_PERIOD.start;
  });
  const [endDate, setEndDate] = useState(() => {
    const period = getCurrentPayPeriod();
    return period?.end || FALLBACK_PERIOD.end;
  });

  // Fetch all employees (admin only) so payroll shows everyone, including those with zero hours
  const { data: allEmployees, isLoading: isLoadingEmployees } = useQuery({
    queryKey: ['employees', 'payroll', isAdmin],
    queryFn: () => employeesService.getAll(false),
    enabled: !!isAdmin,
  });

  // Fetch time entries for the date range (filtered by demo mode, and by user for non-admins)
  const { data: timeEntries, isLoading: isLoadingTimeEntries, error } = useQuery({
    queryKey: ['payrollReport', startDate, endDate, isDemoMode, isAdmin, user?.id],
    queryFn: async () => {
      let query = supabase
        .from('time_entries')
        .select(`
          *,
          user:users!time_entries_user_id_fkey(id, first_name, last_name, email),
          project:projects!time_entries_project_id_fkey(
            id,
            name,
            project_number,
            customer:customers!projects_customer_id_fkey(id, name)
          )
        `)
        .gte('date', startDate)
        .lte('date', endDate)
        .eq('is_demo', isDemoMode); // Only show demo entries in demo mode
      
      // Non-admins can only see their own payroll data
      if (!isAdmin && user?.id) {
        query = query.eq('user_id', user.id);
      }

      const { data, error } = await query.order('date', { ascending: true });
      if (error) throw error;
      return data as TimeEntry[];
    },
  });

  // YTD time entries (Jan 1 to day before current period) for CPP/EI annual cap calculations
  const ytdStartDate = startDate.slice(0, 4) + '-01-01';
  const ytdEndDate = useMemo(() => {
    const d = new Date(startDate + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  }, [startDate]);

  const { data: ytdTimeEntries } = useQuery({
    queryKey: ['payrollYtdEntries', ytdStartDate, ytdEndDate, isDemoMode, isAdmin, user?.id],
    queryFn: async () => {
      if (ytdEndDate < ytdStartDate) return [];
      let query = supabase
        .from('time_entries')
        .select('user_id, hours, rate_type, billable')
        .gte('date', ytdStartDate)
        .lte('date', ytdEndDate)
        .eq('is_demo', isDemoMode);
      if (!isAdmin && user?.id) {
        query = query.eq('user_id', user.id);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
  });

  // Group entries by employee and calculate totals by rate type
  // Payroll is based ONLY on time entries (calendar hours) - not service tickets
  // For admins: include all employees (from employees list) so new hires with no time show with 0 hours
  const employeeHours = useMemo(() => {
    const employeeMap = new Map<string, EmployeeHours>();

    const emptyHours = (): Omit<EmployeeHours, 'userId' | 'name' | 'email'> => ({
      internalShopTime: 0,
      internalShopOvertime: 0,
      internalTravelTime: 0,
      internalFieldTime: 0,
      internalFieldOvertime: 0,
      shopTime: 0,
      shopOvertime: 0,
      travelTime: 0,
      fieldTime: 0,
      fieldOvertime: 0,
      totalHours: 0,
      internalHours: 0,
      entries: [],
    });

    // Admin: seed with all employees so everyone appears (including 0 hours)
    if (isAdmin && allEmployees && allEmployees.length > 0) {
      for (const emp of allEmployees as any[]) {
        const uid = emp.user_id;
        const u = emp.user;
        const name = u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email : 'Unknown';
        if (!uid) continue;
        employeeMap.set(uid, {
          userId: uid,
          name,
          email: u?.email || '',
          ...emptyHours(),
        });
      }
    }

    if (!timeEntries) {
      const zeroRounded = Array.from(employeeMap.values()).map(emp => ({
        ...emp,
        internalShopTime: roundToQuarterHour(emp.internalShopTime),
        internalShopOvertime: roundToQuarterHour(emp.internalShopOvertime),
        internalTravelTime: roundToQuarterHour(emp.internalTravelTime),
        internalFieldTime: roundToQuarterHour(emp.internalFieldTime),
        internalFieldOvertime: roundToQuarterHour(emp.internalFieldOvertime),
        shopTime: roundToQuarterHour(emp.shopTime),
        shopOvertime: roundToQuarterHour(emp.shopOvertime),
        travelTime: roundToQuarterHour(emp.travelTime),
        fieldTime: roundToQuarterHour(emp.fieldTime),
        fieldOvertime: roundToQuarterHour(emp.fieldOvertime),
        totalHours: roundToQuarterHour(emp.totalHours),
        internalHours: roundToQuarterHour(emp.internalHours),
      }));
      return zeroRounded.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Apply time entries (add hours to existing rows or create row for non-admin)
    for (const entry of timeEntries) {
      const userId = entry.user_id;
      const userName = entry.user
        ? `${entry.user.first_name || ''} ${entry.user.last_name || ''}`.trim() || entry.user.email
        : 'Unknown';

      if (!employeeMap.has(userId)) {
        employeeMap.set(userId, {
          userId,
          name: userName,
          email: entry.user?.email || '',
          ...emptyHours(),
        });
      }

      const emp = employeeMap.get(userId)!;
      emp.entries.push(entry);
      // Sum actual hours first (don't round individual entries)
      const hours = Number(entry.hours) || 0;
      emp.totalHours += hours;
      if (!entry.billable) {
        emp.internalHours += hours;
      }

      const rateType = entry.rate_type || 'Shop Time';
      const isInternal = !entry.billable;
      
      switch (rateType) {
        case 'Shop Time':
          if (isInternal) {
            emp.internalShopTime += hours;
          } else {
            emp.shopTime += hours;
          }
          break;
        case 'Shop Overtime':
          if (isInternal) {
            emp.internalShopOvertime += hours;
          } else {
            emp.shopOvertime += hours;
          }
          break;
        case 'Travel Time':
          if (isInternal) {
            emp.internalTravelTime += hours;
          } else {
            emp.travelTime += hours;
          }
          break;
        case 'Field Time':
          if (isInternal) {
            emp.internalFieldTime += hours;
          } else {
            emp.fieldTime += hours;
          }
          break;
        case 'Field Overtime':
          if (isInternal) {
            emp.internalFieldOvertime += hours;
          } else {
            emp.fieldOvertime += hours;
          }
          break;
        default:
          if (isInternal) {
            emp.internalShopTime += hours;
          } else {
            emp.shopTime += hours;
          }
      }
    }

    // Round totals after summing all actual hours
    const roundedEmployeeHours = Array.from(employeeMap.values()).map(emp => {
      return {
        ...emp,
        internalShopTime: roundToQuarterHour(emp.internalShopTime),
        internalShopOvertime: roundToQuarterHour(emp.internalShopOvertime),
        internalTravelTime: roundToQuarterHour(emp.internalTravelTime),
        internalFieldTime: roundToQuarterHour(emp.internalFieldTime),
        internalFieldOvertime: roundToQuarterHour(emp.internalFieldOvertime),
        shopTime: roundToQuarterHour(emp.shopTime),
        shopOvertime: roundToQuarterHour(emp.shopOvertime),
        travelTime: roundToQuarterHour(emp.travelTime),
        fieldTime: roundToQuarterHour(emp.fieldTime),
        fieldOvertime: roundToQuarterHour(emp.fieldOvertime),
        totalHours: roundToQuarterHour(emp.totalHours),
        internalHours: roundToQuarterHour(emp.internalHours),
      };
    });

    return roundedEmployeeHours.sort((a, b) => a.name.localeCompare(b.name));
  }, [timeEntries, isAdmin, allEmployees]);

  const isLoading = isLoadingTimeEntries || (isAdmin && isLoadingEmployees);

  /** When true, hide contractors from the employee list (and grand totals). Default on — admins
   * usually run payroll for W2 employees only, contractors are paid separately. */
  const [excludeContractors, setExcludeContractors] = useState<boolean>(true);
  /** 'hours' shows quarter-hour decimals; 'dollars' multiplies each cell by its rate. */
  const [displayMode, setDisplayMode] = useState<'hours' | 'dollars'>('hours');
  const [calendarOpen, setCalendarOpen] = useState<boolean>(false);

  // Calculate grand totals (already rounded from employeeHours)
  /** Map user_id → contractor flag, for the contractor-exclude toggle. */
  const contractorByUserId = useMemo(() => {
    const map = new Map<string, boolean>();
    if (!allEmployees) return map;
    for (const e of allEmployees as any[]) {
      if (!e.user_id) continue;
      map.set(e.user_id, (e.employment_type || 'Employee') === 'Contractor');
    }
    return map;
  }, [allEmployees]);

  /** Per-rate-type pay rates per user, used to render the table in dollars instead of hours. */
  const empRatesByUserId = useMemo(() => {
    const map = new Map<string, { shopRate: number; shopOtRate: number; ftRate: number; foRate: number }>();
    if (!allEmployees) return map;
    for (const e of allEmployees as any[]) {
      if (!e.user_id) continue;
      const shopRate = Number(e.shop_pay_rate) || 0;
      const shopOtRate = Number(e.shop_ot_pay_rate) || shopRate * 1.5;
      const fieldRate = Number(e.field_pay_rate) || shopRate;
      const fieldOtRate = Number(e.field_ot_pay_rate) || fieldRate * 1.5;
      const isPanelShop = e.department === 'Panel Shop';
      map.set(e.user_id, {
        shopRate,
        shopOtRate,
        ftRate: isPanelShop ? (fieldRate || shopRate) : fieldRate,
        foRate: isPanelShop ? (fieldOtRate || shopOtRate) : fieldOtRate,
      });
    }
    return map;
  }, [allEmployees]);

  /** Employees actually rendered in the table, after the exclude-contractors toggle. */
  const displayedEmployeeHours = useMemo(() => {
    if (!excludeContractors) return employeeHours;
    return employeeHours.filter((emp) => !contractorByUserId.get(emp.userId));
  }, [employeeHours, excludeContractors, contractorByUserId]);

  const grandTotals = useMemo(() => {
    return displayedEmployeeHours.reduce(
      (totals, emp) => ({
        internalShopTime: totals.internalShopTime + emp.internalShopTime,
        internalShopOvertime: totals.internalShopOvertime + emp.internalShopOvertime,
        internalTravelTime: totals.internalTravelTime + emp.internalTravelTime,
        internalFieldTime: totals.internalFieldTime + emp.internalFieldTime,
        internalFieldOvertime: totals.internalFieldOvertime + emp.internalFieldOvertime,
        shopTime: totals.shopTime + emp.shopTime,
        shopOvertime: totals.shopOvertime + emp.shopOvertime,
        travelTime: totals.travelTime + emp.travelTime,
        fieldTime: totals.fieldTime + emp.fieldTime,
        fieldOvertime: totals.fieldOvertime + emp.fieldOvertime,
        totalHours: totals.totalHours + emp.totalHours,
        internalHours: totals.internalHours + emp.internalHours,
      }),
      { internalShopTime: 0, internalShopOvertime: 0, internalTravelTime: 0, internalFieldTime: 0, internalFieldOvertime: 0, shopTime: 0, shopOvertime: 0, travelTime: 0, fieldTime: 0, fieldOvertime: 0, totalHours: 0, internalHours: 0 }
    );
  }, [displayedEmployeeHours]);

  /** Per-cell rate lookup. Maps an employee + kind to the pay rate ($/hr) used to convert hours → dollars. */
  const cellRate = (userId: string, kind: 'internal' | 'shop' | 'shopOt' | 'travel' | 'field' | 'fieldOt'): number => {
    const r = empRatesByUserId.get(userId);
    if (!r) return 0;
    switch (kind) {
      case 'internal': return r.shopRate;
      case 'shop': return r.shopRate;
      case 'shopOt': return r.shopOtRate;
      case 'travel': return r.shopRate;
      case 'field': return r.ftRate;
      case 'fieldOt': return r.foRate;
    }
  };

  /** Render a value cell as either hours (decimal) or dollars (hours × rate). */
  const formatCell = (hours: number, rate: number): string => {
    if (displayMode === 'dollars') return `$${(hours * rate).toFixed(2)}`;
    return hours.toFixed(2);
  };

  // Placeholder for totalCost — computed after payrollBreakdownByUser
  const grandTotalsCosts = { totalCost: 0 };

  // --- Paid-vs-Billed Reconciliation Data ---
  // Service tickets dated in the pay period — used to compare hours billed/customer-revenue
  // against hours paid to the employee for the same (user × project). Surfaces cases where
  // OT was paid but billed flat, or where billed hours diverge from worked hours.
  const reconciliationTicketsTable = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
  const { data: reconciliationTickets = [] } = useQuery({
    queryKey: ['payrollReconTickets', startDate, endDate, isDemoMode, isAdmin, user?.id],
    queryFn: async () => {
      let q = supabase
        .from(reconciliationTicketsTable)
        .select('id, ticket_number, user_id, date, total_hours, edited_hours, is_edited, total_amount, project_id, customer_id, workflow_status')
        .gte('date', startDate)
        .lte('date', endDate)
        .or('is_discarded.is.null,is_discarded.eq.false');
      if (!isAdmin && user?.id) q = q.eq('user_id', user.id);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    },
    enabled: !!isAdmin,
  });

  // --- Reimbursement Data ---
  const { data: ticketExpenses = [] } = useQuery({
    queryKey: ['payrollTicketExpenses', startDate, endDate, isAdmin, user?.id],
    queryFn: () =>
      serviceTicketExpensesService.getReimbursableByDateRange(
        startDate,
        endDate,
        !isAdmin && user?.id ? user.id : undefined
      ),
  });

  const payrollTicketIdsForReceiptCheck = useMemo(
    () => [...new Set((ticketExpenses as any[]).map((e: any) => e.service_ticket_id).filter(Boolean))],
    [ticketExpenses]
  );

  const { data: payrollLinkedApprovedReceipts = [] } = useQuery({
    queryKey: ['payrollLinkedApprovedReceipts', payrollTicketIdsForReceiptCheck.slice().sort().join(',')],
    queryFn: async () => {
      if (payrollTicketIdsForReceiptCheck.length === 0) return [];
      // Include the file/amount fields so the reimbursement breakdown can preview the receipt
      // that backs an "Expense Billed to Customer" / "Hotel" ticket-expense line (these are
      // ticket rows, but the underlying receipt lives in user_expenses).
      const { data, error } = await supabase
        .from('user_expenses')
        .select('id, service_ticket_id, description, status, amount, gst, expense_date, notes, receipt_url')
        .in('service_ticket_id', payrollTicketIdsForReceiptCheck);
      if (error) throw error;
      return data || [];
    },
    enabled: payrollTicketIdsForReceiptCheck.length > 0,
  });

  const { data: receiptExpenses = [] } = useQuery({
    queryKey: ['payrollReceiptExpenses', startDate, endDate, isAdmin, user?.id],
    queryFn: async () => {
      let query = supabase
        .from('user_expenses')
        .select('*, service_ticket:service_tickets(project_id, project:projects(id, name, project_number))')
        .gte('expense_date', startDate)
        .lte('expense_date', endDate);
      if (!isAdmin && user?.id) {
        query = query.eq('user_id', user.id);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
  });

  const todayStr = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t.toISOString().split('T')[0];
  }, []);

  const isCurrentPeriod = endDate >= todayStr;

  const { data: catchUpReceiptsRaw = [] } = useQuery({
    queryKey: ['payrollCatchUpReceipts', startDate, isAdmin, user?.id],
    queryFn: () =>
      userExpensesService.getCatchUpReceipts(
        startDate,
        !isAdmin && user?.id ? user.id : undefined
      ),
    enabled: isCurrentPeriod,
  });

  const catchUpReceipts = useMemo(() => {
    if (!isCurrentPeriod) return [];
    return (catchUpReceiptsRaw as any[]);
  }, [isCurrentPeriod, catchUpReceiptsRaw]);

  const receiptExpensesForReimbursements = useMemo(
    () => (receiptExpenses as any[]).concat(catchUpReceipts),
    [receiptExpenses, catchUpReceipts]
  );

  /** All receipt ids in this payroll set — used to find any service_ticket_expenses
   * rows that reference them via user_expense_id, regardless of ticket date. A receipt
   * linked to even one ticket line (in any period) is paid through that line, never
   * via the receipt itself, so payroll must skip it to avoid double-reimbursement. */
  const payrollReceiptIds = useMemo(
    () => [...new Set((receiptExpensesForReimbursements as any[]).map((r) => String(r.id)).filter(Boolean))],
    [receiptExpensesForReimbursements]
  );

  /** Ticket ids the in-scope receipts attach to (when set). Used to find ticket-expense
   *  rows that represent the same charge as the receipt but live on a ticket dated outside
   *  the current payroll window. Without this, a receipt dated Apr 14 + its ticket-expense
   *  dated Apr 12 reimburse on two separate periods (Chase Gibbon's O-Ring / Oil Pump bug). */
  const payrollReceiptTicketIds = useMemo(
    () => [...new Set(
      (receiptExpensesForReimbursements as any[])
        .map((r) => r.service_ticket_id)
        .filter((tid): tid is string => !!tid)
        .map((tid) => String(tid))
    )],
    [receiptExpensesForReimbursements]
  );

  const { data: linkedTicketExpensesForReceipts = [] } = useQuery({
    queryKey: [
      'payrollLinkedTicketExpensesForReceipts',
      payrollReceiptIds.slice().sort().join(','),
      payrollReceiptTicketIds.slice().sort().join(','),
    ],
    queryFn: async () => {
      if (payrollReceiptIds.length === 0 && payrollReceiptTicketIds.length === 0) return [];
      // Two link paths to the same underlying charge:
      //   (a) ste.user_expense_id IN payrollReceiptIds  — explicit link (Apply-to-Ticket flow)
      //   (b) ste.service_ticket_id IN payrollReceiptTicketIds — same ticket as a receipt,
      //       falls back to description matching in linkedUserExpenseRedundantWithTicketExpenseLine.
      // Fetch both in one .or() so the dedup sees every candidate regardless of which path applies.
      const filters: string[] = [];
      if (payrollReceiptIds.length > 0) filters.push(`user_expense_id.in.(${payrollReceiptIds.join(',')})`);
      if (payrollReceiptTicketIds.length > 0) filters.push(`service_ticket_id.in.(${payrollReceiptTicketIds.join(',')})`);
      const { data, error } = await supabase
        .from('service_ticket_expenses')
        .select('id, service_ticket_id, user_expense_id, description, needs_reimbursement')
        .or(filters.join(','))
        .eq('needs_reimbursement', true);
      if (error) throw error;
      return data || [];
    },
    enabled: payrollReceiptIds.length > 0 || payrollReceiptTicketIds.length > 0,
  });

  const receiptIdsCoveredByTicketLink = useMemo(() => {
    const s = new Set<string>();
    for (const r of linkedTicketExpensesForReceipts as any[]) {
      if (r.user_expense_id) s.add(String(r.user_expense_id));
    }
    return s;
  }, [linkedTicketExpensesForReceipts]);

  const queryClient = useQueryClient();
  // Per-employee mark-as-paid for the current breakdown modal. Pays only the lines for the
  // selected employee inside this pay period — admin has to click for each employee they
  // actually paid out. Replaces the old behavior where navigating to a past period silently
  // marked every employee's expenses as paid for that window.
  const markEmployeePaidMutation = useMutation({
    mutationFn: async ({ receiptIds, ticketExpenseIds }: { receiptIds: string[]; ticketExpenseIds: string[] }) => {
      if (receiptIds.length > 0) await userExpensesService.markPaidByIds(receiptIds);
      if (ticketExpenseIds.length > 0) await serviceTicketExpensesService.markReimbursementPaidByIds(ticketExpenseIds);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payrollReceiptExpenses', startDate, endDate] });
      queryClient.invalidateQueries({ queryKey: ['payrollTicketExpenses', startDate, endDate] });
      queryClient.invalidateQueries({ queryKey: ['payrollLinkedApprovedReceipts'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      alert('Failed to mark as paid: ' + msg);
    },
  });

  // State for the reimbursement breakdown modal
  const [reimbursementModalUserId, setReimbursementModalUserId] = useState<string | null>(null);
  // Set of `${category}|${projectKey}` rows the user has expanded in the breakdown modal.
  // Wiped whenever the modal closes so opening a different employee starts collapsed.
  const [expandedProjectRows, setExpandedProjectRows] = useState<Set<string>>(new Set());
  const toggleProjectRowExpanded = useCallback((key: string) => {
    setExpandedProjectRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);
  useEffect(() => {
    if (!reimbursementModalUserId) {
      setExpandedProjectRows(new Set());
      return;
    }
    // When the modal opens for an employee, auto-expand the Receipt-category project rows so
    // the individual receipts are visible immediately. Other categories stay collapsed for a
    // compact view; the user can still toggle any row manually after open.
    const reimb = reimbursementsByUser.get(reimbursementModalUserId);
    if (!reimb) return;
    const next = new Set<string>();
    for (const line of reimb.lines) {
      if (line.category !== 'Receipt') continue;
      const projKey = line.projectKey || '__unassigned__';
      next.add(`${line.category}|${projKey}`);
    }
    setExpandedProjectRows(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reimbursementModalUserId]);

  // State for the receipt preview modal launched from the reimbursement breakdown.
  // Holds the full `ReimbursementLine.receipt` payload plus a signed URL once fetched.
  type ReceiptPreviewState = {
    receipt: NonNullable<ReimbursementLine['receipt']>;
    description: string;
    projectLabel: string;
    signedUrl: string | null;
    isPdf: boolean;
    loading: boolean;
  };
  const [receiptPreview, setReceiptPreview] = useState<ReceiptPreviewState | null>(null);

  const openReceiptPreview = useCallback(async (line: ReimbursementLine) => {
    if (!line.receipt) return;
    const isPdf = (line.receipt.url ?? '').toLowerCase().endsWith('.pdf');
    setReceiptPreview({
      receipt: line.receipt,
      description: line.description,
      projectLabel: line.projectLabel,
      signedUrl: null,
      isPdf,
      loading: !!line.receipt.url,
    });
    if (!line.receipt.url) return;
    try {
      const url = await userExpensesService.getReceiptSignedUrl(line.receipt.url);
      setReceiptPreview((prev) => prev && prev.receipt.id === line.receipt!.id ? { ...prev, signedUrl: url, loading: false } : prev);
    } catch {
      // Fall back to the raw stored path so at least the download button still works.
      setReceiptPreview((prev) => prev && prev.receipt.id === line.receipt!.id ? { ...prev, signedUrl: line.receipt!.url, loading: false } : prev);
    }
  }, []);

  // State for expandable payroll breakdown rows
  const [expandedUsers, setExpandedUsers] = useState<Set<string>>(new Set());

  // Click-to-copy feedback: which cell key was most recently copied
  const [copiedCellKey, setCopiedCellKey] = useState<string | null>(null);
  const copyCell = (text: string, key: string) => {
    try {
      navigator.clipboard.writeText(text);
      setCopiedCellKey(key);
      window.setTimeout(() => {
        setCopiedCellKey((curr) => (curr === key ? null : curr));
      }, 900);
    } catch {
      // Clipboard access denied — silently no-op; user can still read the number.
    }
  };

  // OT conversion modal: admin picks which entries on a flagged day flip rate_type → OT.
  const [otModalState, setOtModalState] = useState<{
    userId: string;
    userName: string;
    date: string;
    dayEntries: TimeEntry[];
    owedHours: number;
  } | null>(null);

  // Per-entry allocation chosen by admin in the modal (entryId → hours to convert to OT)
  const [otAllocations, setOtAllocations] = useState<Record<string, number>>({});
  // Reset allocations whenever a different modal is opened
  useEffect(() => { setOtAllocations({}); }, [otModalState?.userId, otModalState?.date]);

  const otConvertMutation = useMutation({
    mutationFn: async (args: {
      userId: string;
      date: string;
      allocations: { entry: TimeEntry; hoursToConvert: number }[];
    }) => {
      const emp = empRatesByUserId.get(args.userId);
      const otRateFor = (regularRateType: string): { otRateType: string; otRate: number } => {
        switch (regularRateType) {
          case 'Field Time':
            return { otRateType: 'Field Overtime', otRate: emp?.foRate || 0 };
          case 'Shop Time':
          case 'Travel Time':
          default:
            return { otRateType: 'Shop Overtime', otRate: emp?.shopOtRate || 0 };
        }
      };

      for (const { entry, hoursToConvert } of args.allocations) {
        if (hoursToConvert <= 0) continue;
        const origHours = Number(entry.hours) || 0;
        if (hoursToConvert > origHours + 0.0001) {
          throw new Error(`Cannot convert ${hoursToConvert}h from a ${origHours}h entry`);
        }
        const remaining = +(origHours - hoursToConvert).toFixed(2);
        const { otRateType, otRate } = otRateFor(entry.rate_type || 'Shop Time');

        if (remaining <= 0.0001) {
          // Entire entry flips to OT — update in place.
          await supabase
            .from('time_entries')
            .update({ rate_type: otRateType, rate: otRate })
            .eq('id', entry.id);
        } else {
          // Split: shrink original, insert new OT row.
          await supabase
            .from('time_entries')
            .update({ hours: remaining })
            .eq('id', entry.id);

          const { data: src, error: fetchErr } = await supabase
            .from('time_entries')
            .select('*')
            .eq('id', entry.id)
            .single();
          if (fetchErr) throw fetchErr;

          const insertPayload: any = { ...src };
          delete insertPayload.id;
          delete insertPayload.created_at;
          delete insertPayload.updated_at;
          insertPayload.hours = +hoursToConvert.toFixed(2);
          insertPayload.rate_type = otRateType;
          insertPayload.rate = otRate;
          const { error: insErr } = await supabase.from('time_entries').insert(insertPayload);
          if (insErr) throw insErr;
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payrollReport'] });
      queryClient.invalidateQueries({ queryKey: ['payrollYtdEntries'] });
      queryClient.invalidateQueries({ queryKey: ['allTimeEntries'] });
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
      setOtModalState(null);
    },
  });

  /** Render a project row for the reimbursement breakdown modal. Prefers the project number
   *  prefix so QuickBooks entries match the customer's coding ("12345 — Site Acme") and falls
   *  back to the bare name (or a placeholder) when one or both fields are missing. */
  const formatProjectLabel = (p?: { name?: string | null; project_number?: string | null } | null): string => {
    if (!p) return '(no project)';
    const number = (p.project_number ?? '').trim();
    const name = (p.name ?? '').trim();
    if (number && name) return `${number} — ${name}`;
    return number || name || '(no project)';
  };

  interface ReimbursementLine {
    category: string;
    description: string;
    quantity: number;
    rate: number;
    reimbRate: number;
    amount: number;
    ticketNumber?: string;
    /** Stable id used to group lines by project in the breakdown modal. Empty string when
     *  the underlying receipt/ticket has no project assigned. */
    projectKey: string;
    /** Display label for the project — falls back to "(no project)" when unassigned. */
    projectLabel: string;
    /** service_ticket_expenses.id when this line was sourced from a ticket-expense row.
     *  The Mark-as-Paid button flips `reimbursement_status` to 'paid' on these ids. */
    ticketExpenseId?: string;
    /** Whether the underlying row is already marked paid. Lines that are already paid are
     *  excluded from the Mark-as-Paid action and shown with a quiet pill in the breakdown. */
    isPaid: boolean;
    /** When this line is backed by a `user_expenses` receipt, the receipt metadata is carried
     *  through so the breakdown modal can preview/download the file without re-fetching. */
    receipt?: {
      id: string;
      url: string | null;
      date: string | null;
      subtotal: number;
      gst: number;
      status: string | null;
      notes: string | null;
    };
  }

  interface EmployeeReimbursement {
    userId: string;
    total: number;
    lines: ReimbursementLine[];
  }

  const reimbursementsByUser = useMemo(() => {
    const empByUserId = new Map<string, any>();
    if (allEmployees) {
      for (const e of allEmployees as any[]) {
        if (e.user_id) empByUserId.set(e.user_id, e);
      }
    }

    // Build lookups so an "Expense Billed to Customer" / "Hotel" ticket-expense line can find
    // the user_expense receipt that backs it. Two ways the link is recorded:
    //   1. ticket_expense.user_expense_id → user_expense.id (explicit link)
    //   2. user_expense.service_ticket_id + matching description (legacy direct-apply flow)
    const receiptById = new Map<string, any>();
    const receiptsByTicketDesc = new Map<string, any>();
    for (const r of payrollLinkedApprovedReceipts as any[]) {
      if (r?.id) receiptById.set(String(r.id), r);
      const tid = r?.service_ticket_id ? String(r.service_ticket_id) : '';
      const desc = (r?.description ?? '').trim().toLowerCase();
      if (tid && desc) receiptsByTicketDesc.set(`${tid}|${desc}`, r);
    }
    const findLinkedReceipt = (exp: any) => {
      const linkedId = exp?.user_expense_id ? String(exp.user_expense_id) : '';
      if (linkedId && receiptById.has(linkedId)) return receiptById.get(linkedId);
      const tid = exp?.service_ticket_id ? String(exp.service_ticket_id) : '';
      const desc = (exp?.description ?? '').trim().toLowerCase();
      if (tid && desc) return receiptsByTicketDesc.get(`${tid}|${desc}`) ?? null;
      return null;
    };
    const toLinePayload = (r: any): ReimbursementLine['receipt'] | undefined => {
      if (!r) return undefined;
      return {
        id: String(r.id),
        url: r.receipt_url ?? null,
        date: r.expense_date ?? null,
        subtotal: Number(r.amount) || 0,
        gst: Number(r.gst) || 0,
        status: r.status ?? null,
        notes: r.notes ?? null,
      };
    };

    const map = new Map<string, EmployeeReimbursement>();
    const getOrCreate = (userId: string): EmployeeReimbursement => {
      if (!map.has(userId)) {
        map.set(userId, { userId, total: 0, lines: [] });
      }
      return map.get(userId)!;
    };

    // Process service ticket expenses
    for (const exp of ticketExpenses as any[]) {
      const userId = exp.service_tickets?.user_id;
      if (!userId) continue;

      if (
        exp.needs_reimbursement &&
        ticketExpenseRequiresLinkedReceiptForPayroll(exp) &&
        !ticketExpenseHasPayrollEligibleLinkedReceipt(exp, payrollLinkedApprovedReceipts as any[])
      ) {
        continue;
      }

      const employee = empByUserId.get(userId);
      const qty = Number(exp.quantity) || 0;
      const rate = Number(exp.rate) || 0;
      const ticketNumber = exp.service_tickets?.ticket_number;

      const expType = (exp.expense_type || '').toLowerCase();
      const desc = (exp.description || '').toLowerCase();

      let reimbRate = 0;
      let category = '';

      if (expType === 'travel') {
        if (exp.needs_reimbursement === false) continue;
        if (desc.includes('truck')) {
          reimbRate = Number(employee?.truck_reimb_rate) || 1.00;
          category = 'Truck Hours';
        } else {
          reimbRate = Number(employee?.mileage_reimb_rate) || 0.90;
          category = 'Mileage';
        }
      } else if (expType === 'hotel' || desc.includes('hotel')) {
        if (exp.needs_reimbursement === false) continue;
        // Hotel requires a receipt before payroll reimbursement.
        // Eligible if actual_cost is set (single-line attach) OR a linked user_expense receipt exists.
        const hasReceipt =
          (Number(exp.actual_cost) || 0) > 0 ||
          ticketExpenseHasPayrollEligibleLinkedReceipt(exp, payrollLinkedApprovedReceipts as any[]);
        if (!hasReceipt) continue;
        reimbRate = Number(employee?.hotel_reimb_rate) || 1.0;
        category = 'Hotel';
      } else if (expType === 'equipment' && desc.includes('truck')) {
        reimbRate = Number(employee?.truck_reimb_rate) || 1.00;
        category = 'Truck';
      } else if (expType === 'equipment' && exp.needs_reimbursement) {
        reimbRate = 1.0;
        category = 'Laptop/Equipment';
      } else if (expType === 'subsistence' && desc.includes('per diem')) {
        reimbRate = Number(employee?.per_diem_reimb_rate) || 1.00;
        category = 'Per Diem';
      } else if (
        exp.needs_reimbursement &&
        (!!exp.reimbursement_status ||
          ticketExpenseHasPayrollEligibleLinkedReceipt(exp, payrollLinkedApprovedReceipts as any[]))
      ) {
        reimbRate = 1.00;
        category = 'Expense Billed to Customer';
      } else {
        continue;
      }

      const reimbBase = ticketExpenseReimbursementBase(exp);
      const amount = reimbBase * reimbRate;
      const displayQty = qty || 1;
      const displayRate = reimbBase / displayQty;
      const ticketProject = exp.service_tickets?.project;
      const projectKey = String(ticketProject?.id ?? exp.service_tickets?.project_id ?? '');
      const projectLabel = formatProjectLabel(ticketProject);
      // For categories where the line is backed by a customer receipt (Hotel / Expense Billed
      // to Customer), carry the receipt payload so the breakdown modal can preview/download it.
      // Lines without a matching receipt (e.g. Mileage, Per Diem) intentionally stay non-clickable.
      const receiptPayload = toLinePayload(findLinkedReceipt(exp));
      const entry = getOrCreate(userId);
      entry.total += amount;
      entry.lines.push({
        category,
        description: exp.description || '',
        quantity: displayQty,
        rate: displayRate,
        reimbRate,
        amount,
        ticketNumber,
        projectKey,
        projectLabel,
        ticketExpenseId: String(exp.id),
        isPaid: exp.reimbursement_status === 'paid',
        receipt: receiptPayload,
      });
    }

    // Process receipt expenses (subtotal + GST = employee out-of-pocket); includes catch-up for current period.
    // Skip receipts that are paid through a ticket-expense line — either via the
    // legacy direct-apply (matched by description on this period's ticket lines),
    // or via the new user_expense_id link (matched against ANY period's ticket
    // lines so a receipt linked to past-period tickets isn't paid again here).
    // Cross-period dedup: combine the current period's ticket-expenses with the wider
    // set fetched by user_expense_id / service_ticket_id link so a receipt dated in
    // one period and its matching ticket-expense dated in another still dedupe.
    const widenedTicketExpensesForDedup = [
      ...(ticketExpenses as any[]),
      ...(linkedTicketExpensesForReceipts as any[]),
    ];
    for (const exp of receiptExpensesForReimbursements as any[]) {
      if (receiptIdsCoveredByTicketLink.has(String(exp.id))) continue;
      if (linkedUserExpenseRedundantWithTicketExpenseLine(exp, widenedTicketExpensesForDedup)) continue;
      // Admin explicitly marked this receipt as not reimbursable (e.g. company paid).
      // It stays in user_expenses so it can be Applied-to-Ticket, but payroll skips it.
      if (exp.not_reimbursable === true) continue;
      const userId = exp.user_id;
      if (!userId) continue;

      const subtotalAmount = Number(exp.amount) || 0;
      const gstAmount = Number(exp.gst) || 0;
      const amount = subtotalAmount + gstAmount;
      const receiptProject = exp.service_ticket?.project;
      const projectKey = String(receiptProject?.id ?? exp.service_ticket?.project_id ?? '');
      const projectLabel = formatProjectLabel(receiptProject);
      const entry = getOrCreate(userId);
      entry.total += amount;
      entry.lines.push({
        category: 'Receipt',
        description: exp.description || '',
        quantity: 1,
        rate: amount,
        reimbRate: 1.00,
        amount,
        projectKey,
        projectLabel,
        isPaid: exp.status === 'paid',
        receipt: {
          id: String(exp.id),
          url: exp.receipt_url ?? null,
          date: exp.expense_date ?? null,
          subtotal: subtotalAmount,
          gst: gstAmount,
          status: exp.status ?? null,
          notes: exp.notes ?? null,
        },
      });
    }

    return map;
  }, [ticketExpenses, receiptExpensesForReimbursements, allEmployees, payrollLinkedApprovedReceipts, receiptIdsCoveredByTicketLink, linkedTicketExpensesForReceipts]);

  const grandTotalReimbursements = useMemo(() => {
    const employeeIds = new Set(displayedEmployeeHours.map((e) => e.userId));
    let total = 0;
    reimbursementsByUser.forEach((v, userId) => {
      if (employeeIds.has(userId)) total += v.total;
    });
    return total;
  }, [reimbursementsByUser, displayedEmployeeHours]);

  // --- Payroll Breakdown (base pay, benefits, GST, allowances, total payout) ---
  interface PayrollBreakdown {
    basePay: number;
    sickPay: number;
    statHolidayPay: number;
    vacationPay: number;
    cellPhoneAllowance: number;
    healthAllowance: number;
    benefitsTotal: number;
    gst: number;
    ei: number;
    eiMaxed: boolean;
    cpp: number;
    cppMaxed: boolean;
    incomeTax: number;
    netPay: number;
    reimbursements: number;
    grossPay: number;
    totalPayout: number;
    isContractor: boolean;
    sickPct: number;
    statPct: number;
    vacationPct: number;
  }

  // 2026 annual maximums (employee portion)
  const CPP_ANNUAL_MAX = 4034;
  const EI_ANNUAL_MAX = 1077;
  const CPP_RATE = 0.0595;
  const EI_RATE = 0.0166;

  const ytdGrossPayByUser = useMemo(() => {
    const map = new Map<string, number>();
    if (!ytdTimeEntries || !allEmployees) return map;

    const empByUserId = new Map<string, any>();
    for (const e of allEmployees as any[]) {
      if (e.user_id) empByUserId.set(e.user_id, e);
    }

    const hoursByUser = new Map<string, { shop: number; shopOt: number; travel: number; field: number; fieldOt: number; internal: number }>();
    for (const entry of ytdTimeEntries as any[]) {
      const uid = entry.user_id;
      if (!hoursByUser.has(uid)) hoursByUser.set(uid, { shop: 0, shopOt: 0, travel: 0, field: 0, fieldOt: 0, internal: 0 });
      const h = hoursByUser.get(uid)!;
      const hours = Number(entry.hours) || 0;
      const rt = entry.rate_type || 'Shop Time';
      const isInternal = !entry.billable;
      if (isInternal) { h.internal += hours; }
      else if (rt === 'Shop Time') { h.shop += hours; }
      else if (rt === 'Shop Overtime') { h.shopOt += hours; }
      else if (rt === 'Travel Time') { h.travel += hours; }
      else if (rt === 'Field Time') { h.field += hours; }
      else if (rt === 'Field Overtime') { h.fieldOt += hours; }
      else { h.shop += hours; }
    }

    for (const [uid, h] of hoursByUser) {
      const employee = empByUserId.get(uid);
      if (!employee || (employee.employment_type || 'Employee') === 'Contractor') continue;
      const shopRate = Number(employee.shop_pay_rate) || 0;
      const shopOtRate = Number(employee.shop_ot_pay_rate) || shopRate * 1.5;
      const fieldRate = Number(employee.field_pay_rate) || shopRate;
      const fieldOtRate = Number(employee.field_ot_pay_rate) || fieldRate * 1.5;
      const isPanelShop = employee.department === 'Panel Shop';
      const ftRate = isPanelShop ? (fieldRate || shopRate) : fieldRate;
      const foRate = isPanelShop ? (fieldOtRate || shopOtRate) : fieldOtRate;

      const basePay = h.internal * shopRate + h.shop * shopRate + h.shopOt * shopOtRate + h.travel * shopRate + h.field * ftRate + h.fieldOt * foRate;
      const sickPct = Number(employee.sick_pay_pct) || 0;
      const statPct = Number(employee.stat_holiday_pay_pct) || 0;
      const vacPct = Number(employee.vacation_pay_pct) || 0;
      const benefits = basePay * (sickPct + statPct + vacPct) / 100
        + (Number(employee.cell_phone_allowance) || 0)
        + (Number(employee.health_allowance) || 0);
      map.set(uid, basePay + benefits);
    }
    return map;
  }, [ytdTimeEntries, allEmployees]);

  const payrollBreakdownByUser = useMemo(() => {
    const map = new Map<string, PayrollBreakdown>();
    if (!allEmployees) return map;

    const empByUserId = new Map<string, any>();
    for (const e of allEmployees as any[]) {
      if (e.user_id) empByUserId.set(e.user_id, e);
    }

    for (const emp of employeeHours) {
      const employee = empByUserId.get(emp.userId);
      const shopRate = Number(employee?.shop_pay_rate) || 0;
      const shopOtRate = Number(employee?.shop_ot_pay_rate) || shopRate * 1.5;
      const fieldRate = Number(employee?.field_pay_rate) || shopRate;
      const fieldOtRate = Number(employee?.field_ot_pay_rate) || fieldRate * 1.5;
      const isPanelShop = employee?.department === 'Panel Shop';
      const ftRate = isPanelShop ? (fieldRate || shopRate) : fieldRate;
      const foRate = isPanelShop ? (fieldOtRate || shopOtRate) : fieldOtRate;

      const basePay =
        emp.internalHours * shopRate +
        emp.shopTime * shopRate +
        emp.shopOvertime * shopOtRate +
        emp.travelTime * shopRate +
        emp.fieldTime * ftRate +
        emp.fieldOvertime * foRate;

      const isContractor = (employee?.employment_type || 'Employee') === 'Contractor';
      const sickPct = Number(employee?.sick_pay_pct) || 0;
      const statPct = Number(employee?.stat_holiday_pay_pct) || 0;
      const vacationPct = Number(employee?.vacation_pay_pct) || 0;

      let sickPay = 0, statHolidayPay = 0, vacationPay = 0, cellPhone = 0, health = 0, gst = 0;

      if (isContractor) {
        gst = basePay * 0.05;
      } else {
        sickPay = basePay * (sickPct / 100);
        statHolidayPay = basePay * (statPct / 100);
        vacationPay = basePay * (vacationPct / 100);
        cellPhone = Number(employee?.cell_phone_allowance) || 0;
        health = Number(employee?.health_allowance) || 0;
      }

      const benefitsTotal = sickPay + statHolidayPay + vacationPay + cellPhone + health;
      const grossPay = basePay + benefitsTotal + gst;

      let ei = 0, cpp = 0;
      if (!isContractor) {
        const ytdGross = ytdGrossPayByUser.get(emp.userId) || 0;
        const ytdEi = Math.min(ytdGross * EI_RATE, EI_ANNUAL_MAX);
        const ytdCpp = Math.min(ytdGross * CPP_RATE, CPP_ANNUAL_MAX);
        ei = Math.max(0, Math.min(grossPay * EI_RATE, EI_ANNUAL_MAX - ytdEi));
        cpp = Math.max(0, Math.min(grossPay * CPP_RATE, CPP_ANNUAL_MAX - ytdCpp));
      }
      const incomeTax = isContractor ? 0 : grossPay * 0.15;
      const netPay = grossPay - ei - cpp - incomeTax;
      const reimb = reimbursementsByUser.get(emp.userId)?.total || 0;
      const totalPayout = netPay + reimb;

      map.set(emp.userId, {
        basePay,
        sickPay,
        statHolidayPay,
        vacationPay,
        cellPhoneAllowance: cellPhone,
        healthAllowance: health,
        benefitsTotal,
        gst,
        ei,
        eiMaxed: !isContractor && (ei < grossPay * EI_RATE - 0.01),
        cpp,
        cppMaxed: !isContractor && (cpp < grossPay * CPP_RATE - 0.01),
        incomeTax,
        netPay,
        reimbursements: reimb,
        grossPay,
        totalPayout,
        isContractor,
        sickPct,
        statPct,
        vacationPct,
      });
    }

    return map;
  }, [allEmployees, employeeHours, reimbursementsByUser, ytdGrossPayByUser]);

  // Total Cost = Gross Pay + Employer CPP (matches employee) + Employer EI (1.4x employee) + Reimbursements
  const EMPLOYER_EI_MULTIPLIER = 1.4;
  const totalPayrollCost = useMemo(() => {
    if (!isAdmin) return 0;
    const displayedIds = new Set(displayedEmployeeHours.map((e) => e.userId));
    let total = 0;
    payrollBreakdownByUser.forEach((b, uid) => {
      if (!displayedIds.has(uid)) return;
      const employerCpp = b.cpp;
      const employerEi = b.ei * EMPLOYER_EI_MULTIPLIER;
      total += b.grossPay + employerCpp + employerEi + b.reimbursements;
    });
    return total;
  }, [isAdmin, payrollBreakdownByUser, displayedEmployeeHours]);
  grandTotalsCosts.totalCost = totalPayrollCost;

  // Which preset (if any) matches the current date range — used to highlight the active button
  const activePreset = useMemo(() => {
    for (const key of PRESET_KEYS) {
      const range = getPresetRange(key);
      if (range && range.start === startDate && range.end === endDate) return key;
    }
    return null;
  }, [startDate, endDate]);

  // Quick date range presets
  const setDatePreset = (preset: string) => {
    const today = new Date();
    let start: Date;
    let end: Date = today;

    switch (preset) {
      case 'currentPayPeriod': {
        const period = getCurrentPayPeriod();
        setStartDate(period.start);
        setEndDate(period.end);
        return;
      }
      case 'previousPayPeriod': {
        const period = getCurrentPayPeriod();
        const start = new Date(period.start + 'T12:00:00');
        const end = new Date(period.end + 'T12:00:00');
        start.setDate(start.getDate() - 14);
        end.setDate(end.getDate() - 14);
        setStartDate(start.toISOString().split('T')[0]);
        setEndDate(end.toISOString().split('T')[0]);
        return;
      }
      case 'thisWeek':
        start = startOfWeekMonday(today);
        break;
      case 'lastWeek': {
        const thisMonday = startOfWeekMonday(today);
        start = new Date(thisMonday);
        start.setDate(thisMonday.getDate() - 7);
        end = new Date(start);
        end.setDate(start.getDate() + 6);
        break;
      }
      case 'last2Weeks':
        start = new Date(today);
        start.setDate(today.getDate() - 14);
        break;
      case 'thisMonth':
        start = new Date(today.getFullYear(), today.getMonth(), 1);
        end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        break;
      case 'lastMonth':
        start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        end = new Date(today.getFullYear(), today.getMonth(), 0);
        break;
      default:
        return;
    }

    setStartDate(start.toISOString().split('T')[0]);
    setEndDate(end.toISOString().split('T')[0]);
  };
  
  // --- Paid vs Billed reconciliation memo ---
  // Builds per (user × project) row showing hours/cost paid (time_entries → payroll)
  // versus hours/revenue billed (service_tickets → customer). Deltas highlight cases
  // where overtime was absorbed (paid > billed) or extra was billed (paid < billed).
  const [showReconciliation, setShowReconciliation] = useState<boolean>(false);

  const reconciliationRows = useMemo(() => {
    if (!isAdmin) return [];

    // Build project lookup from any source we have
    const projectInfo = new Map<string, { name: string; number: string; customer: string }>();
    if (timeEntries) {
      for (const e of timeEntries) {
        if (!e.project_id || projectInfo.has(e.project_id)) continue;
        projectInfo.set(e.project_id, {
          name: e.project?.name || 'Unknown Project',
          number: e.project?.project_number || '',
          customer: e.project?.customer?.name || '',
        });
      }
    }

    type Row = {
      userId: string;
      userName: string;
      projectId: string;
      projectName: string;
      projectNumber: string;
      customer: string;
      paidHours: number;
      paidCost: number;
      paidOtHours: number;
      billedHours: number;
      billedRevenue: number;
      ticketNumbers: string[];
    };
    const map = new Map<string, Row>();
    const keyOf = (uid: string, pid: string | null | undefined) => `${uid}||${pid || '_unassigned_'}`;

    const displayedUserIds = new Set(displayedEmployeeHours.map((e) => e.userId));
    const empNameById = new Map(displayedEmployeeHours.map((e) => [e.userId, e.name] as const));

    // Paid side from time_entries
    if (timeEntries) {
      for (const entry of timeEntries) {
        if (!displayedUserIds.has(entry.user_id)) continue;
        const pid = entry.project_id || null;
        const k = keyOf(entry.user_id, pid);
        const info = pid ? projectInfo.get(pid) : null;
        if (!map.has(k)) {
          map.set(k, {
            userId: entry.user_id,
            userName: empNameById.get(entry.user_id) || 'Unknown',
            projectId: pid || '',
            projectName: info?.name || (pid ? 'Unknown Project' : 'Unassigned'),
            projectNumber: info?.number || '',
            customer: info?.customer || '',
            paidHours: 0, paidCost: 0, paidOtHours: 0,
            billedHours: 0, billedRevenue: 0,
            ticketNumbers: [],
          });
        }
        const row = map.get(k)!;
        const hrs = Number(entry.hours) || 0;
        row.paidHours += hrs;
        const rates = empRatesByUserId.get(entry.user_id);
        const rt = entry.rate_type || 'Shop Time';
        const isOt = rt === 'Shop Overtime' || rt === 'Field Overtime';
        if (isOt) row.paidOtHours += hrs;
        let payRate = 0;
        if (rates) {
          switch (rt) {
            case 'Shop Time': payRate = rates.shopRate; break;
            case 'Shop Overtime': payRate = rates.shopOtRate; break;
            case 'Travel Time': payRate = rates.shopRate; break;
            case 'Field Time': payRate = rates.ftRate; break;
            case 'Field Overtime': payRate = rates.foRate; break;
            default: payRate = rates.shopRate;
          }
        }
        row.paidCost += hrs * payRate;
      }
    }

    // Billed side from service_tickets
    for (const t of reconciliationTickets as any[]) {
      if (!displayedUserIds.has(t.user_id)) continue;
      const pid = t.project_id || null;
      const k = keyOf(t.user_id, pid);
      const info = pid ? projectInfo.get(pid) : null;
      if (!map.has(k)) {
        map.set(k, {
          userId: t.user_id,
          userName: empNameById.get(t.user_id) || 'Unknown',
          projectId: pid || '',
          projectName: info?.name || (pid ? 'Unknown Project' : 'Unassigned'),
          projectNumber: info?.number || '',
          customer: info?.customer || '',
          paidHours: 0, paidCost: 0, paidOtHours: 0,
          billedHours: 0, billedRevenue: 0,
          ticketNumbers: [],
        });
      }
      const row = map.get(k)!;
      const billed = t.is_edited && t.edited_hours != null
        ? (Number(t.edited_hours) || 0)
        : (Number(t.total_hours) || 0);
      row.billedHours += billed;
      row.billedRevenue += Number(t.total_amount) || 0;
      if (t.ticket_number) row.ticketNumbers.push(String(t.ticket_number));
    }

    return Array.from(map.values()).sort((a, b) => {
      if (a.userName !== b.userName) return a.userName.localeCompare(b.userName);
      return a.projectName.localeCompare(b.projectName);
    });
  }, [isAdmin, timeEntries, reconciliationTickets, displayedEmployeeHours, empRatesByUserId]);

  // --- CSV export for QuickBooks ---
  // Builds a friendly multi-section sheet: project allocations per employee, then a payroll summary
  // (gross, deductions, net, reimbursements, total payout, allowances) ready for QuickBooks input.
  const handleExportCsv = () => {
    const empByUserId = new Map<string, any>();
    if (allEmployees) {
      for (const e of allEmployees as any[]) {
        if (e.user_id) empByUserId.set(e.user_id, e);
      }
    }

    const csvEscape = (v: any): string => {
      const s = v === null || v === undefined ? '' : String(v);
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const rows: string[][] = [];
    const pushRow = (cells: (string | number)[]) => rows.push(cells.map((c) => typeof c === 'number' ? c.toFixed(2) : String(c)));
    const blank = () => rows.push([]);

    pushRow(['Payroll Export']);
    pushRow(['Period Start', startDate, 'Period End', endDate, 'Payday', paydayLabel]);
    pushRow(['Excludes contractors?', excludeContractors ? 'Yes' : 'No']);
    blank();

    // Section 1: project allocations (one row per employee × project × rate type)
    pushRow(['Project Allocations']);
    pushRow(['Employee', 'Email', 'Employment Type', 'Department', 'Project #', 'Project', 'Customer', 'Rate Type', 'Hours']);

    for (const emp of displayedEmployeeHours) {
      const employee = empByUserId.get(emp.userId);
      const empType = employee?.employment_type || 'Employee';
      const dept = employee?.department || '';

      // Aggregate (project, rate type, billable) → hours
      const agg = new Map<string, { projNumber: string; projName: string; custName: string; rateType: string; billable: boolean; hours: number }>();
      for (const entry of emp.entries) {
        const projNumber = entry.project?.project_number || '';
        const projName = entry.project?.name || (entry.project_id ? 'Unknown Project' : 'Unassigned');
        const custName = entry.project?.customer?.name || '';
        const rt = entry.rate_type || 'Shop Time';
        const billable = !!entry.billable;
        const key = `${projNumber}||${projName}||${custName}||${rt}||${billable ? 'B' : 'I'}`;
        if (!agg.has(key)) agg.set(key, { projNumber, projName, custName, rateType: rt, billable, hours: 0 });
        agg.get(key)!.hours += Number(entry.hours) || 0;
      }

      if (agg.size === 0) {
        // employee with no entries — emit a zero row so they still show up
        pushRow([emp.name, emp.email, empType, dept, '', '', '', '', 0]);
        continue;
      }

      for (const a of agg.values()) {
        const rtLabel = a.billable ? a.rateType : `Internal (${a.rateType})`;
        pushRow([emp.name, emp.email, empType, dept, a.projNumber, a.projName, a.custName, rtLabel, a.hours]);
      }
    }

    blank();

    // Section 2: payroll summary per employee (hours only — dollars handled in QuickBooks)
    pushRow(['Payroll Summary (per employee)']);
    pushRow([
      'Employee', 'Email', 'Employment Type',
      'Internal Hrs', 'Shop Hrs', 'Shop OT Hrs', 'Travel Hrs', 'Field Hrs', 'Field OT Hrs', 'Total Hrs',
    ]);

    for (const emp of displayedEmployeeHours) {
      const employee = empByUserId.get(emp.userId);
      pushRow([
        emp.name, emp.email, employee?.employment_type || 'Employee',
        emp.internalHours, emp.shopTime, emp.shopOvertime, emp.travelTime, emp.fieldTime, emp.fieldOvertime, emp.totalHours,
      ]);
    }

    blank();

    // Section 3: reimbursement detail (so we can copy lines straight into QB)
    pushRow(['Reimbursement Detail']);
    pushRow(['Employee', 'Email', 'Category', 'Description', 'Ticket', 'Qty', 'Rate', 'Reimb %', 'Amount']);
    for (const emp of displayedEmployeeHours) {
      const reimb = reimbursementsByUser.get(emp.userId);
      if (!reimb || reimb.lines.length === 0) continue;
      for (const line of reimb.lines) {
        pushRow([
          emp.name, emp.email, line.category, line.description, line.ticketNumber || '',
          line.quantity, line.rate, line.reimbRate * 100, line.amount,
        ]);
      }
    }

    const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payroll_${startDate}_to_${endDate}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Payday for selected range (if it's a 14-day period) or current pay period's payday
  const paydayLabel = getPaydayForRange(startDate, endDate)
    ?? (() => {
        const period = getCurrentPayPeriod();
        const end = new Date(period.end + 'T12:00:00');
        end.setDate(end.getDate() + 5);
        return end.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
      })();

  return (
    <div className="payroll-page">
      <div className="payroll-hero">
        <div>
          <div className="payroll-hero-eyebrow">{isAdmin ? 'Pay period · administrator view' : 'Pay period · my hours'}</div>
          <h1 className="payroll-hero-title">{isAdmin ? 'Payroll Report' : 'My Payroll'}</h1>
        </div>
        <div className="payroll-hero-meta">
          <span className="payroll-payday-chip">
            <span className="label">Payday</span>
            {paydayLabel}
          </span>
        </div>
      </div>

      {/* Filters */}
      <div className="ionex-filter-card">
        <div className="ionex-filter-card-row">
          {/* Date Range — pay-period calendar picker, with collapsible custom inputs */}
          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase' }}>
              Date Range
            </label>
            <div style={{ position: 'relative', display: 'inline-block' }}>
              <button
                type="button"
                onClick={() => setCalendarOpen((v) => !v)}
                aria-expanded={calendarOpen}
                style={{
                  padding: '8px 14px',
                  backgroundColor: 'var(--bg-primary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  fontFamily: 'inherit',
                  minWidth: '230px',
                }}
                title="Pick a pay period"
              >
                <span style={{ fontSize: '14px' }}>📅</span>
                <span>
                  {(() => {
                    const fmt = (s: string) => {
                      try {
                        return new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                      } catch {
                        return s;
                      }
                    };
                    return `${fmt(startDate)} – ${fmt(endDate)}`;
                  })()}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--text-tertiary)' }}>▼</span>
              </button>
              {calendarOpen && (
                <PayPeriodCalendar
                  value={{ start: startDate, end: endDate }}
                  onChange={({ start, end }) => {
                    setStartDate(start);
                    setEndDate(end);
                  }}
                  onClose={() => setCalendarOpen(false)}
                />
              )}
            </div>
          </div>

          {/* Quick Presets — active preset is highlighted */}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {(() => {
              // Compute payday dates for the two pay-period presets so the buttons read
              // "Pay 1 May" / "Pay 15 May" instead of the abstract "Previous/Current Pay Period".
              const period = getCurrentPayPeriod();
              const fmtPay = (offsetDays: number) => {
                const d = new Date(period.end + 'T12:00:00');
                d.setDate(d.getDate() + offsetDays + 5);
                return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
              };
              const upcomingPayday = fmtPay(0);    // current period's payday = next payroll
              const lastPaidPayday = fmtPay(-14);  // previous period's payday = already paid
              return PRESET_KEYS.map((key) => {
              const label =
                key === 'currentPayPeriod' ? `Pay ${upcomingPayday}` :
                key === 'previousPayPeriod' ? `Last paid (${lastPaidPayday})` :
                key === 'last2Weeks' ? 'Last 2 Weeks' :
                key === 'thisWeek' ? 'This Week' :
                key === 'lastWeek' ? 'Last Week' :
                key === 'thisMonth' ? 'This Month' : 'Last Month';
              const isActive = activePreset === key;
              return (
                <button
                  key={key}
                  className={isActive ? 'button button-primary' : 'button button-secondary'}
                  style={{ padding: '8px 12px', fontSize: '12px' }}
                  onClick={() => setDatePreset(key)}
                >
                  {label}
                </button>
              );
            });
            })()}
          </div>
          
        </div>

        {isAdmin && (
          <div className="ionex-filter-card-row" style={{ alignItems: 'center' }}>
            {/* Display mode toggle: Hours vs Dollars */}
            <div className="ionex-toggle-rail">
              <button
                type="button"
                onClick={() => setDisplayMode('hours')}
                className={`ionex-toggle-button${displayMode === 'hours' ? ' is-active' : ''}`}
              >
                Hours
              </button>
              <button
                type="button"
                onClick={() => setDisplayMode('dollars')}
                className={`ionex-toggle-button${displayMode === 'dollars' ? ' is-active' : ''}`}
              >
                Dollars
              </button>
            </div>

            {/* Exclude contractors toggle */}
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={excludeContractors}
                onChange={(e) => setExcludeContractors(e.target.checked)}
              />
              Exclude contractors
            </label>

            {/* Export to QuickBooks-friendly CSV */}
            <button
              type="button"
              onClick={handleExportCsv}
              className="payroll-action-btn payroll-action-spacer"
              title="Download a CSV with project allocations, rates, and payroll inputs for QuickBooks"
              disabled={displayedEmployeeHours.length === 0}
            >
              <span aria-hidden>⬇</span> Export CSV
            </button>
          </div>
        )}
      </div>

      {/* Loading / Error States */}
      {error ? (
        <div className="ionex-status-card is-error">
          <span className="glyph" aria-hidden>⚠️</span>
          <span className="title">Error loading report data</span>
        </div>
      ) : isLoading ? (
        <div className="ionex-status-card">
          <span className="glyph" aria-hidden>⏳</span>
          <span className="title">Loading payroll data…</span>
        </div>
      ) : employeeHours.length === 0 ? (
        <div className="ionex-empty">
          <span className="glyph" aria-hidden>🗓️</span>
          <h3 className="title">No time entries in this period</h3>
          <p className="body">Try a different date range or pay period from the filters above.</p>
        </div>
      ) : (
        <>
          {/* Summary Cards */}
          <div className="payroll-summary-grid">
            <div className="payroll-summary-card" style={{ ['--accent' as string]: 'var(--primary-color)' } as React.CSSProperties}>
              <div className="payroll-summary-eyebrow">{isAdmin ? 'Total cost' : 'Total hours'}</div>
              <div className="payroll-summary-value">
                {isAdmin ? `$${grandTotalsCosts.totalCost.toFixed(2)}` : grandTotals.totalHours.toFixed(2)}
              </div>
              {isAdmin && (
                <div className="payroll-summary-hint">
                  Gross + employer CPP/EI + reimbursements
                </div>
              )}
            </div>
            <div className="payroll-summary-card" style={{ ['--accent' as string]: '#00897b' } as React.CSSProperties}>
              <div className="payroll-summary-eyebrow">Reimbursements</div>
              <div className="payroll-summary-value">${grandTotalReimbursements.toFixed(2)}</div>
              <div className="payroll-summary-hint">Receipts + ticket expenses for this period</div>
            </div>
            {isAdmin && (
              <div className="payroll-summary-card" style={{ ['--accent' as string]: '#0ea5e9' } as React.CSSProperties}>
                <div className="payroll-summary-eyebrow">Employees on payroll</div>
                <div className="payroll-summary-value">{displayedEmployeeHours.length}</div>
                <div className="payroll-summary-hint">
                  {excludeContractors ? 'Contractors hidden' : 'Contractors included'}
                </div>
              </div>
            )}
          </div>

          {/* Employee Hours Table */}
          <div className="ionex-section-heading">
            <div className="ionex-section-heading-title-row">
              <h3>{isAdmin ? 'Employee Hours by Rate Type' : 'Hours by Rate Type'}</h3>
              <span className="ionex-section-heading-meta">
                {startDate} → {endDate}
                {isAdmin && (
                  <> · <strong>{displayedEmployeeHours.length}</strong> {displayedEmployeeHours.length === 1 ? 'employee' : 'employees'}{excludeContractors ? ' · contractors hidden' : ''}</>
                )}
              </span>
            </div>
          </div>
          <div className="payroll-table-card">
            <table className="payroll-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th className="is-numeric payroll-cell-internal">Internal</th>
                  <th className="is-numeric payroll-cell-shop">Shop</th>
                  <th className="is-numeric payroll-cell-shop-ot">Shop OT</th>
                  <th className="is-numeric payroll-cell-travel">Travel</th>
                  <th className="is-numeric payroll-cell-field">Field</th>
                  <th className="is-numeric payroll-cell-field-ot">Field OT</th>
                  <th className="is-numeric payroll-cell-reimb">Reimburse</th>
                  <th className="is-numeric">Total</th>
                </tr>
              </thead>
              <tbody>
                {displayedEmployeeHours.map((emp) => {
                  const isExpanded = expandedUsers.has(emp.userId);
                  const breakdown = payrollBreakdownByUser.get(emp.userId);
                  return (
                  <React.Fragment key={emp.userId}>
                  <tr className={isExpanded ? 'is-expanded' : ''}>
                    <td>
                      <div className="payroll-employee-cell">
                        {isAdmin && (
                          <button
                            type="button"
                            className={`payroll-row-toggle${isExpanded ? ' is-open' : ''}`}
                            onClick={() => {
                              const next = new Set(expandedUsers);
                              if (next.has(emp.userId)) next.delete(emp.userId); else next.add(emp.userId);
                              setExpandedUsers(next);
                            }}
                            aria-expanded={isExpanded}
                            title="Toggle payroll breakdown"
                          >&#9654;</button>
                        )}
                        <div
                          className="payroll-employee-link"
                          onClick={() => { if (isAdmin) navigate(`/calendar?viewUserId=${emp.userId}&from=payroll`); }}
                          title={isAdmin ? `View ${emp.name}'s calendar and time entries` : undefined}
                          style={{ cursor: isAdmin ? 'pointer' : 'default' }}
                        >
                          <span className={`payroll-employee-name${isAdmin ? ' is-link' : ''}`}>
                            {emp.name}
                            {breakdown?.isContractor && <span className="payroll-tag is-contractor">Contractor</span>}
                          </span>
                          <span className="payroll-employee-email">{emp.email}</span>
                        </div>
                      </div>
                    </td>
                    {(['internal','shop','shopOt','travel','field','fieldOt'] as const).map((kind) => {
                      const hours =
                        kind === 'internal' ? emp.internalHours :
                        kind === 'shop' ? emp.shopTime :
                        kind === 'shopOt' ? emp.shopOvertime :
                        kind === 'travel' ? emp.travelTime :
                        kind === 'field' ? emp.fieldTime :
                        emp.fieldOvertime;
                      const colorClass =
                        hours > 0
                          ? {
                              internal: 'payroll-cell-internal',
                              shop: 'payroll-cell-shop',
                              shopOt: 'payroll-cell-shop-ot',
                              travel: 'payroll-cell-travel',
                              field: 'payroll-cell-field',
                              fieldOt: 'payroll-cell-field-ot',
                            }[kind]
                          : 'payroll-cell-muted';
                      const value = formatCell(hours, cellRate(emp.userId, kind));
                      const cellKey = `${emp.userId}-${kind}`;
                      const isCopied = copiedCellKey === cellKey;
                      const canCopy = hours > 0;
                      return (
                        <td
                          key={kind}
                          className={`is-numeric ${colorClass}${canCopy ? ' payroll-copyable' : ''}${isCopied ? ' is-copied' : ''}`}
                          onClick={canCopy ? () => copyCell(value, cellKey) : undefined}
                          title={canCopy ? `Click to copy ${value}` : undefined}
                        >
                          {value}
                        </td>
                      );
                    })}
                    <td
                      className={`is-numeric ${(reimbursementsByUser.get(emp.userId)?.total || 0) > 0 ? 'payroll-cell-reimb payroll-reimb-link' : 'payroll-cell-muted'}`}
                      onClick={() => {
                        const reimb = reimbursementsByUser.get(emp.userId);
                        if (reimb && reimb.total > 0) setReimbursementModalUserId(emp.userId);
                      }}
                      title={(reimbursementsByUser.get(emp.userId)?.total || 0) > 0 ? 'Click for breakdown' : undefined}
                    >
                      ${(reimbursementsByUser.get(emp.userId)?.total || 0).toFixed(2)}
                    </td>
                    {(() => {
                      const totalVal = displayMode === 'dollars'
                        ? `$${(breakdown?.basePay ?? 0).toFixed(2)}`
                        : emp.totalHours.toFixed(2);
                      const totalKey = `${emp.userId}-total`;
                      const isCopied = copiedCellKey === totalKey;
                      const canCopy = emp.totalHours > 0 || (breakdown?.basePay ?? 0) > 0;
                      return (
                        <td
                          className={`is-numeric${canCopy ? ' payroll-copyable' : ''}${isCopied ? ' is-copied' : ''}`}
                          style={{ fontWeight: 700 }}
                          onClick={canCopy ? () => copyCell(totalVal, totalKey) : undefined}
                          title={canCopy ? `Click to copy ${totalVal}` : undefined}
                        >
                          {totalVal}
                        </td>
                      );
                    })()}
                  </tr>
                  {isExpanded && isAdmin && (
                    <tr>
                      <td colSpan={9} style={{ padding: 0, backgroundColor: 'var(--bg-secondary)' }}>
                        <EmployeeProjectsAndDailyBreakdown
                          employeeName={emp.name}
                          userId={emp.userId}
                          entries={emp.entries}
                          isContractor={!!breakdown?.isContractor}
                          onConvertOt={(args) => setOtModalState(args)}
                        />
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                  );
                })}
                {/* Totals Row */}
                {(() => {
                  let totInternal = 0, totShop = 0, totShopOt = 0, totTravel = 0, totField = 0, totFieldOt = 0, totBasePay = 0;
                  for (const emp of displayedEmployeeHours) {
                    totInternal += emp.internalHours * cellRate(emp.userId, 'internal');
                    totShop += emp.shopTime * cellRate(emp.userId, 'shop');
                    totShopOt += emp.shopOvertime * cellRate(emp.userId, 'shopOt');
                    totTravel += emp.travelTime * cellRate(emp.userId, 'travel');
                    totField += emp.fieldTime * cellRate(emp.userId, 'field');
                    totFieldOt += emp.fieldOvertime * cellRate(emp.userId, 'fieldOt');
                    totBasePay += payrollBreakdownByUser.get(emp.userId)?.basePay || 0;
                  }
                  const fmt = (hours: number, dollars: number) => displayMode === 'dollars' ? `$${dollars.toFixed(2)}` : hours.toFixed(2);
                  return (
                <tr className="is-totals">
                  <td>Totals</td>
                  {(() => {
                    const cells: { key: string; value: string; colorClass: string }[] = [
                      { key: 'tot-internal', value: fmt(grandTotals.internalHours, totInternal), colorClass: 'payroll-cell-internal' },
                      { key: 'tot-shop', value: fmt(grandTotals.shopTime, totShop), colorClass: 'payroll-cell-shop' },
                      { key: 'tot-shopOt', value: fmt(grandTotals.shopOvertime, totShopOt), colorClass: 'payroll-cell-shop-ot' },
                      { key: 'tot-travel', value: fmt(grandTotals.travelTime, totTravel), colorClass: 'payroll-cell-travel' },
                      { key: 'tot-field', value: fmt(grandTotals.fieldTime, totField), colorClass: 'payroll-cell-field' },
                      { key: 'tot-fieldOt', value: fmt(grandTotals.fieldOvertime, totFieldOt), colorClass: 'payroll-cell-field-ot' },
                      { key: 'tot-reimb', value: `$${grandTotalReimbursements.toFixed(2)}`, colorClass: 'payroll-cell-reimb' },
                      { key: 'tot-total', value: displayMode === 'dollars' ? `$${totBasePay.toFixed(2)}` : grandTotals.totalHours.toFixed(2), colorClass: '' },
                    ];
                    return cells.map((c) => {
                      const isCopied = copiedCellKey === c.key;
                      return (
                        <td
                          key={c.key}
                          className={`is-numeric ${c.colorClass} payroll-copyable${isCopied ? ' is-copied' : ''}`}
                          onClick={() => copyCell(c.value, c.key)}
                          title={`Click to copy ${c.value}`}
                        >
                          {c.value}
                        </td>
                      );
                    });
                  })()}
                </tr>
                  );
                })()}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Paid vs Billed Reconciliation Panel — admin only */}
      {isAdmin && reconciliationRows.length > 0 && (
        <div>
          <div
            className={`payroll-section-heading${showReconciliation ? ' is-open' : ''}`}
            onClick={() => setShowReconciliation((v) => !v)}
            title="Compare payroll cost (time entries) to customer billing (service tickets) per user × project"
          >
            <h3>
              <span className="toggle">&#9654;</span>
              Paid vs Billed reconciliation
            </h3>
            <span className="meta">
              {reconciliationRows.length} rows · payroll cost vs customer billing
            </span>
          </div>
          {showReconciliation && (() => {
            const totals = reconciliationRows.reduce(
              (acc, r) => ({
                paidHours: acc.paidHours + r.paidHours,
                paidCost: acc.paidCost + r.paidCost,
                paidOtHours: acc.paidOtHours + r.paidOtHours,
                billedHours: acc.billedHours + r.billedHours,
                billedRevenue: acc.billedRevenue + r.billedRevenue,
              }),
              { paidHours: 0, paidCost: 0, paidOtHours: 0, billedHours: 0, billedRevenue: 0 }
            );
            const deltaClass = (n: number) => {
              if (Math.abs(n) < 0.005) return 'payroll-delta is-zero';
              return n > 0 ? 'payroll-delta is-pos' : 'payroll-delta is-neg';
            };
            return (
              <div className="payroll-table-card">
                <table className="payroll-recon-table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Project</th>
                      <th className="is-numeric payroll-cell-internal">Paid Hrs</th>
                      <th className="is-numeric payroll-cell-shop-ot" title="Of paid hours, how many were at an OT rate">OT Hrs</th>
                      <th className="is-numeric payroll-cell-internal">Cost Paid</th>
                      <th className="is-numeric payroll-cell-shop">Billed Hrs</th>
                      <th className="is-numeric payroll-cell-shop">Revenue</th>
                      <th className="is-numeric" title="Billed hours minus paid hours">Δ Hrs</th>
                      <th className="is-numeric" title="Revenue minus payroll cost (gross labour margin)">Margin</th>
                      <th>Tickets</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconciliationRows.map((r) => {
                      const dHours = r.billedHours - r.paidHours;
                      const margin = r.billedRevenue - r.paidCost;
                      const paidOnly = r.paidHours > 0 && r.billedHours === 0;
                      const billedOnly = r.billedHours > 0 && r.paidHours === 0;
                      return (
                        <tr key={`${r.userId}|${r.projectId}`} className={paidOnly || billedOnly ? 'is-mismatch' : ''}>
                          <td>{r.userName}</td>
                          <td>
                            <div>
                              {r.projectNumber && <span className="payroll-muted" style={{ fontFamily: 'SF Mono, Menlo, Consolas, monospace', marginRight: '6px' }}>{r.projectNumber}</span>}
                              {r.projectName}
                            </div>
                            {r.customer && <div className="payroll-employee-email">{r.customer}</div>}
                          </td>
                          <td className={`is-numeric ${r.paidHours > 0 ? 'payroll-cell-internal' : 'payroll-cell-muted'}`}>{r.paidHours.toFixed(2)}</td>
                          <td className={`is-numeric ${r.paidOtHours > 0 ? 'payroll-cell-shop-ot' : 'payroll-cell-muted'}`} style={{ fontWeight: r.paidOtHours > 0 ? 600 : 400 }}>{r.paidOtHours.toFixed(2)}</td>
                          <td className={`is-numeric ${r.paidCost > 0 ? 'payroll-cell-internal' : 'payroll-cell-muted'}`}>${r.paidCost.toFixed(2)}</td>
                          <td className={`is-numeric ${r.billedHours > 0 ? 'payroll-cell-shop' : 'payroll-cell-muted'}`}>{r.billedHours.toFixed(2)}</td>
                          <td className={`is-numeric ${r.billedRevenue > 0 ? 'payroll-cell-shop' : 'payroll-cell-muted'}`}>${r.billedRevenue.toFixed(2)}</td>
                          <td className={`is-numeric ${deltaClass(dHours)}`}>{dHours > 0 ? '+' : ''}{dHours.toFixed(2)}</td>
                          <td className={`is-numeric ${deltaClass(margin)}`}>{margin >= 0 ? '+' : ''}${margin.toFixed(2)}</td>
                          <td className="payroll-employee-email">{r.ticketNumbers.length === 0 ? '—' : r.ticketNumbers.join(', ')}</td>
                        </tr>
                      );
                    })}
                    <tr className="is-totals">
                      <td colSpan={2}>Totals</td>
                      <td className="is-numeric payroll-cell-internal">{totals.paidHours.toFixed(2)}</td>
                      <td className="is-numeric payroll-cell-shop-ot">{totals.paidOtHours.toFixed(2)}</td>
                      <td className="is-numeric payroll-cell-internal">${totals.paidCost.toFixed(2)}</td>
                      <td className="is-numeric payroll-cell-shop">{totals.billedHours.toFixed(2)}</td>
                      <td className="is-numeric payroll-cell-shop">${totals.billedRevenue.toFixed(2)}</td>
                      <td className={`is-numeric ${deltaClass(totals.billedHours - totals.paidHours)}`}>
                        {(totals.billedHours - totals.paidHours) > 0 ? '+' : ''}{(totals.billedHours - totals.paidHours).toFixed(2)}
                      </td>
                      <td className={`is-numeric ${deltaClass(totals.billedRevenue - totals.paidCost)}`}>
                        {(totals.billedRevenue - totals.paidCost) >= 0 ? '+' : ''}${(totals.billedRevenue - totals.paidCost).toFixed(2)}
                      </td>
                      <td />
                    </tr>
                  </tbody>
                </table>
                <div className="payroll-recon-footnote">
                  Paid Hrs/Cost = sum of time_entries (drives payroll). Billed Hrs/Revenue = sum of service_tickets in the same period (drives invoicing).
                  Mismatch is normal when employees convert OT to regular billing or vice versa. Δ Hrs &lt; 0 = OT absorbed by employer. Margin = gross labour margin.
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* OT Allocation Modal — admin picks which entries on a flagged day flip to OT rate_type */}
      {otModalState && (() => {
        const allocated = Object.values(otAllocations).reduce((s, v) => s + (Number(v) || 0), 0);
        const target = otModalState.owedHours;
        const remaining = +(target - allocated).toFixed(2);
        const allocations: { entry: TimeEntry; hoursToConvert: number }[] = otModalState.dayEntries
          .filter((e) => {
            const rt = e.rate_type || 'Shop Time';
            return rt !== 'Shop Overtime' && rt !== 'Field Overtime';
          })
          .map((e) => ({ entry: e, hoursToConvert: Number(otAllocations[e.id]) || 0 }))
          .filter((a) => a.hoursToConvert > 0);

        const canSave = Math.abs(remaining) < 0.01 && allocated > 0 && !otConvertMutation.isPending;

        return (
          <div
            className="ionex-modal-backdrop"
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}
            onClick={() => !otConvertMutation.isPending && setOtModalState(null)}
          >
            <div
              className="ionex-modal-card"
              style={{ backgroundColor: 'var(--bg-primary)', borderRadius: '12px', padding: '24px', maxWidth: '760px', width: '92%', maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="payroll-modal-header">
                <div>
                  <h3 className="payroll-modal-title">Allocate overtime — {otModalState.userName}</h3>
                  <div className="payroll-modal-subtitle">
                    {new Date(otModalState.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                     · Owed <strong style={{ color: 'var(--warning-color)' }}>{target.toFixed(2)}h</strong> — pick which project(s) absorb the OT
                  </div>
                </div>
                <button
                  className="payroll-modal-close"
                  onClick={() => setOtModalState(null)}
                  disabled={otConvertMutation.isPending}
                  aria-label="Close"
                >×</button>
              </div>

              <table className="payroll-mini-table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Rate type</th>
                    <th className="is-numeric">Entry hrs</th>
                    <th className="is-numeric">Convert to OT</th>
                  </tr>
                </thead>
                <tbody>
                  {otModalState.dayEntries.map((e) => {
                    const rt = e.rate_type || 'Shop Time';
                    const isAlreadyOt = rt === 'Shop Overtime' || rt === 'Field Overtime';
                    const projName = e.project?.name || (e.project_id ? 'Unknown Project' : 'Unassigned');
                    const projNum = e.project?.project_number || '';
                    const otVariant = rt === 'Field Time' ? 'Field Overtime' : 'Shop Overtime';
                    return (
                      <tr key={e.id}>
                        <td>
                          {projNum && <span className="payroll-muted" style={{ marginRight: '6px', fontFamily: 'SF Mono, Menlo, Consolas, monospace' }}>{projNum}</span>}
                          {projName}
                          {e.project?.customer?.name && <div className="payroll-employee-email">{e.project.customer.name}</div>}
                        </td>
                        <td className="payroll-muted">
                          {rt}
                          {!isAlreadyOt && <span style={{ marginLeft: '4px', fontSize: '10px' }}>→ {otVariant}</span>}
                        </td>
                        <td className="is-numeric">{Number(e.hours).toFixed(2)}</td>
                        <td className="is-numeric">
                          {isAlreadyOt ? (
                            <span className="payroll-muted" style={{ fontSize: '11px' }}>already OT</span>
                          ) : (
                            <input
                              type="number"
                              step="0.25"
                              min={0}
                              max={Number(e.hours)}
                              value={otAllocations[e.id] ?? ''}
                              onChange={(ev) => {
                                const raw = ev.target.value;
                                const next = { ...otAllocations };
                                if (raw === '') delete next[e.id];
                                else next[e.id] = Math.min(Number(e.hours), Math.max(0, Number(raw) || 0));
                                setOtAllocations(next);
                              }}
                              className="payroll-input-num"
                              placeholder="0.00"
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <div className="payroll-modal-footer">
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                  Allocated: <strong style={{ color: 'var(--text-primary)' }}>{allocated.toFixed(2)}h</strong> of <strong style={{ color: 'var(--warning-color)' }}>{target.toFixed(2)}h</strong>
                  {Math.abs(remaining) >= 0.01 && (
                    <span style={{ marginLeft: '8px', color: 'var(--primary-color)' }}>
                      ({remaining > 0 ? `${remaining.toFixed(2)}h still to allocate` : `${(-remaining).toFixed(2)}h over`})
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="payroll-action-btn"
                    onClick={() => setOtModalState(null)}
                    disabled={otConvertMutation.isPending}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="payroll-action-btn is-primary"
                    onClick={() => otConvertMutation.mutate({ userId: otModalState.userId, date: otModalState.date, allocations })}
                    disabled={!canSave}
                  >
                    {otConvertMutation.isPending ? 'Saving…' : 'Convert to OT'}
                  </button>
                </div>
              </div>

              {otConvertMutation.isError && (
                <div style={{ marginTop: '12px', padding: '10px', borderRadius: '6px', backgroundColor: 'rgba(220,53,69,0.10)', color: 'var(--error-color)', fontSize: '12px' }}>
                  {(otConvertMutation.error as Error)?.message || 'Failed to convert overtime.'}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Reimbursement Breakdown Modal — shows category subtotals split by project, so each
       *  project gets its own copy-pastable line for QuickBooks. Per-line description / qty /
       *  rate are intentionally not shown: the user only types the category total per project. */}
      {reimbursementModalUserId && (() => {
        const reimb = reimbursementsByUser.get(reimbursementModalUserId);
        const empName = employeeHours.find(e => e.userId === reimbursementModalUserId)?.name || 'Employee';
        if (!reimb) return null;

        type ProjectBucket = {
          projectKey: string;
          projectLabel: string;
          subtotal: number;
          /** Every reimbursement line that rolls into this project's subtotal, in original
           *  order. Surfaced in the modal when the user expands the project row so they can
           *  audit what makes up the per-project QuickBooks line. Receipt-backed entries
           *  remain clickable for preview/download. */
          lines: ReimbursementLine[];
        };
        type CategoryBucket = { category: string; subtotal: number; projects: ProjectBucket[] };

        const categoryMap = new Map<string, { subtotal: number; projects: Map<string, ProjectBucket> }>();
        for (const line of reimb.lines) {
          if (!categoryMap.has(line.category)) {
            categoryMap.set(line.category, { subtotal: 0, projects: new Map() });
          }
          const cat = categoryMap.get(line.category)!;
          cat.subtotal += line.amount;
          const projKey = line.projectKey || '__unassigned__';
          if (!cat.projects.has(projKey)) {
            cat.projects.set(projKey, { projectKey: projKey, projectLabel: line.projectLabel, subtotal: 0, lines: [] });
          }
          const bucket = cat.projects.get(projKey)!;
          bucket.subtotal += line.amount;
          bucket.lines.push(line);
        }

        const categories: CategoryBucket[] = Array.from(categoryMap.entries()).map(([category, c]) => ({
          category,
          subtotal: c.subtotal,
          // Largest project first — most QuickBooks entries are dominated by one project, and
          // putting it at the top makes the first row visually anchor each category.
          projects: Array.from(c.projects.values()).sort((a, b) => b.subtotal - a.subtotal),
        }));

        return (
          <div
            className="ionex-modal-backdrop"
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}
            onClick={() => setReimbursementModalUserId(null)}
          >
            <div
              className="ionex-modal-card"
              style={{ backgroundColor: 'var(--bg-primary)', borderRadius: '12px', padding: '24px', maxWidth: '640px', width: '90%', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Reimbursement Breakdown — {empName}
                </h3>
                <button
                  onClick={() => setReimbursementModalUserId(null)}
                  style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-secondary)', padding: '4px' }}
                >
                  &times;
                </button>
              </div>
              <p style={{ margin: '0 0 18px', fontSize: '12px', color: 'var(--text-tertiary)' }}>
                Each row is one QuickBooks entry. Split across projects when a category covers more than one.
              </p>

              {categories.map(({ category, subtotal, projects }) => {
                return (
                  <div key={category} style={{ marginBottom: '18px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', paddingBottom: '4px', borderBottom: '1px solid var(--border-color)' }}>
                      <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#00897b', textTransform: 'uppercase' }}>{category}</h4>
                      <span style={{ fontSize: '14px', fontWeight: 700, color: '#00897b' }}>${subtotal.toFixed(2)}</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      {projects.map((p) => {
                        const isUnassigned = p.projectKey === '__unassigned__';
                        const rowKey = `${category}|${p.projectKey}`;
                        const isExpanded = expandedProjectRows.has(rowKey);
                        return (
                          <div key={p.projectKey} style={{ marginBottom: '4px' }}>
                            <button
                              type="button"
                              onClick={() => toggleProjectRowExpanded(rowKey)}
                              aria-expanded={isExpanded}
                              title={isExpanded ? 'Collapse line items' : 'Expand to see line items'}
                              style={{
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                width: '100%', padding: '8px 4px',
                                backgroundColor: 'transparent', border: 'none',
                                borderBottom: '1px solid var(--border-color)',
                                cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px',
                                color: 'inherit', textAlign: 'left',
                                transition: 'background-color 0.12s',
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'; }}
                              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                            >
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                                <span aria-hidden style={{ flexShrink: 0, fontSize: '10px', color: 'var(--text-tertiary)', transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>▶</span>
                                <span style={{ color: isUnassigned ? 'var(--text-tertiary)' : 'var(--text-primary)', fontStyle: isUnassigned ? 'italic' : 'normal', fontWeight: 600 }}>
                                  {p.projectLabel}
                                </span>
                                <span style={{ color: 'var(--text-tertiary)', fontSize: '11px', flexShrink: 0 }}>
                                  · {p.lines.length} {p.lines.length === 1 ? 'line' : 'lines'}
                                </span>
                              </span>
                              <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>${p.subtotal.toFixed(2)}</span>
                            </button>
                            {isExpanded && (
                              <div style={{ display: 'flex', flexDirection: 'column' }}>
                                {p.lines.map((line, idx) => {
                                  const hasReceipt = !!line.receipt;
                                  const hasFile = !!line.receipt?.url;
                                  if (hasReceipt) {
                                    return (
                                      <button
                                        key={`${line.receipt?.id ?? idx}`}
                                        type="button"
                                        onClick={() => openReceiptPreview(line)}
                                        title={hasFile ? 'Open receipt details and preview' : 'Open receipt details (no file attached)'}
                                        style={{
                                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                          width: '100%', padding: '6px 8px 6px 22px',
                                          backgroundColor: 'transparent', border: 'none',
                                          borderBottom: '1px solid var(--border-color)',
                                          cursor: 'pointer', fontFamily: 'inherit', fontSize: '12px',
                                          color: 'var(--text-secondary)', textAlign: 'left',
                                          transition: 'background-color 0.12s',
                                        }}
                                        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                                      >
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                                          <span aria-hidden style={{ flexShrink: 0 }}>{hasFile ? '🧾' : '📄'}</span>
                                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {line.description || '(no description)'}
                                          </span>
                                          {line.ticketNumber && (
                                            <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>· #{line.ticketNumber}</span>
                                          )}
                                          {!line.ticketNumber && line.receipt?.date && (
                                            <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>· {line.receipt.date}</span>
                                          )}
                                        </span>
                                        <span style={{ fontFamily: 'monospace', flexShrink: 0, marginLeft: '8px' }}>${line.amount.toFixed(2)}</span>
                                      </button>
                                    );
                                  }
                                  // Non-receipt lines: static row exposing the qty × rate × reimb%
                                  // math so the user can spot-check a Mileage / Truck / Per Diem
                                  // entry without leaving the modal.
                                  const detail = `${line.quantity} × $${line.rate.toFixed(2)}${line.reimbRate !== 1 ? ` × ${(line.reimbRate * 100).toFixed(0)}%` : ''}`;
                                  return (
                                    <div
                                      key={`${category}-${p.projectKey}-line-${idx}`}
                                      style={{
                                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                        padding: '6px 8px 6px 22px',
                                        borderBottom: '1px solid var(--border-color)',
                                        fontSize: '12px', color: 'var(--text-secondary)',
                                      }}
                                    >
                                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                                        <span aria-hidden style={{ flexShrink: 0 }}>•</span>
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                          {line.description || '(no description)'}
                                        </span>
                                        {line.ticketNumber && (
                                          <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>· #{line.ticketNumber}</span>
                                        )}
                                        <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>· {detail}</span>
                                      </span>
                                      <span style={{ fontFamily: 'monospace', flexShrink: 0, marginLeft: '8px' }}>${line.amount.toFixed(2)}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {(() => {
                // Mark-as-Paid CTA. Collects every unpaid line that backs this modal — both
                // receipt user_expenses and ticket_expense rows — and flips their statuses to
                // 'paid'. Disabled when nothing is pending; replaced with a quiet "All paid"
                // status pill when the employee has nothing outstanding for this period.
                const unpaidLines = reimb.lines.filter((l) => !l.isPaid);
                const paidLines = reimb.lines.filter((l) => l.isPaid);
                const unpaidTotal = unpaidLines.reduce((s, l) => s + l.amount, 0);
                const unpaidReceiptIds = Array.from(new Set(
                  unpaidLines.map((l) => l.receipt?.id).filter((id): id is string => !!id)
                ));
                const unpaidTicketExpenseIds = Array.from(new Set(
                  unpaidLines
                    .filter((l) => !l.receipt && !!l.ticketExpenseId)
                    .map((l) => l.ticketExpenseId as string)
                ));
                const nothingToMark = unpaidReceiptIds.length === 0 && unpaidTicketExpenseIds.length === 0;
                const isBusy = markEmployeePaidMutation.isPending;

                const onMarkPaid = () => {
                  if (nothingToMark) return;
                  const summaryParts: string[] = [];
                  if (unpaidReceiptIds.length > 0) summaryParts.push(`${unpaidReceiptIds.length} receipt${unpaidReceiptIds.length === 1 ? '' : 's'}`);
                  if (unpaidTicketExpenseIds.length > 0) summaryParts.push(`${unpaidTicketExpenseIds.length} ticket expense${unpaidTicketExpenseIds.length === 1 ? '' : 's'}`);
                  const proceed = window.confirm(
                    `Mark ${summaryParts.join(' + ')} as paid for ${empName} ($${unpaidTotal.toFixed(2)})?\n\n` +
                    'They will drop out of future Payroll views for this period and be stamped paid in the system.'
                  );
                  if (!proceed) return;
                  markEmployeePaidMutation.mutate({
                    receiptIds: unpaidReceiptIds,
                    ticketExpenseIds: unpaidTicketExpenseIds,
                  });
                };

                return (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px', paddingTop: '12px', borderTop: '2px solid var(--border-color)', gap: '12px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>
                      Total Reimbursement
                      {paidLines.length > 0 && (
                        <span style={{ marginLeft: '10px', fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px', backgroundColor: 'rgba(59, 130, 246, 0.14)', color: '#1d4ed8', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                          {paidLines.length} of {reimb.lines.length} paid
                        </span>
                      )}
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '12px' }}>
                      {nothingToMark ? (
                        <span style={{ fontSize: '12px', fontWeight: 700, padding: '4px 10px', borderRadius: '999px', backgroundColor: 'rgba(34, 197, 94, 0.16)', color: '#15803d', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                          ✓ All paid
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={onMarkPaid}
                          disabled={isBusy}
                          title={`Mark this employee's ${unpaidLines.length} unpaid line${unpaidLines.length === 1 ? '' : 's'} as paid for this pay period.`}
                          style={{
                            padding: '8px 14px', borderRadius: '6px',
                            backgroundColor: '#15803d', color: 'white',
                            border: 'none', fontWeight: 700, fontSize: '13px',
                            cursor: isBusy ? 'not-allowed' : 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          {isBusy ? 'Marking…' : `✓ Mark $${unpaidTotal.toFixed(2)} as paid`}
                        </button>
                      )}
                      <span style={{ fontSize: '18px', fontWeight: 700, color: '#00897b' }}>${reimb.total.toFixed(2)}</span>
                    </span>
                  </div>
                );
              })()}
            </div>
          </div>
        );
      })()}

      {/* Receipt preview modal — opens on top of the reimbursement breakdown so the user can
       *  verify a receipt's content and download the file without leaving Payroll. Layered at
       *  zIndex 10000 (above the reimbursement modal's 9999). */}
      {receiptPreview && (() => {
        const { receipt, description, projectLabel, signedUrl, isPdf, loading } = receiptPreview;
        const hasFile = !!receipt.url;
        const downloadHref = signedUrl ?? receipt.url ?? '';
        return (
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 10000, backgroundColor: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={() => setReceiptPreview(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{ backgroundColor: 'var(--bg-primary)', borderRadius: '12px', padding: '20px', width: '92%', maxWidth: '720px', maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', gap: '14px' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
                <div style={{ minWidth: 0 }}>
                  <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {description || '(no description)'}
                  </h3>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    {projectLabel}{receipt.date ? ` · ${receipt.date}` : ''}{receipt.status ? ` · ${receipt.status}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setReceiptPreview(null)}
                  style={{ background: 'none', border: 'none', fontSize: '22px', cursor: 'pointer', color: 'var(--text-secondary)', padding: '0 4px', lineHeight: 1 }}
                >
                  &times;
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
                <div style={{ padding: '10px 12px', borderRadius: '8px', backgroundColor: 'var(--bg-secondary)' }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)' }}>Subtotal</div>
                  <div style={{ fontSize: '15px', fontFamily: 'monospace', fontWeight: 600, color: 'var(--text-primary)' }}>${receipt.subtotal.toFixed(2)}</div>
                </div>
                <div style={{ padding: '10px 12px', borderRadius: '8px', backgroundColor: 'var(--bg-secondary)' }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)' }}>GST</div>
                  <div style={{ fontSize: '15px', fontFamily: 'monospace', fontWeight: 600, color: 'var(--text-primary)' }}>${receipt.gst.toFixed(2)}</div>
                </div>
                <div style={{ padding: '10px 12px', borderRadius: '8px', backgroundColor: 'var(--bg-secondary)' }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)' }}>Total</div>
                  <div style={{ fontSize: '15px', fontFamily: 'monospace', fontWeight: 700, color: '#00897b' }}>${(receipt.subtotal + receipt.gst).toFixed(2)}</div>
                </div>
              </div>

              {receipt.notes && (
                <div style={{ padding: '10px 12px', borderRadius: '8px', backgroundColor: 'var(--bg-secondary)', fontSize: '13px', color: 'var(--text-secondary)' }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)', marginBottom: '4px' }}>Notes</div>
                  {receipt.notes}
                </div>
              )}

              <div style={{ borderRadius: '8px', backgroundColor: 'var(--bg-secondary)', minHeight: '320px', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                {!hasFile ? (
                  <span style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>No receipt file attached</span>
                ) : loading || !signedUrl ? (
                  <span style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>Loading preview…</span>
                ) : isPdf ? (
                  <iframe src={signedUrl} title="Receipt PDF" style={{ width: '100%', height: '60vh', border: 'none', backgroundColor: 'white' }} />
                ) : (
                  <img src={signedUrl} alt="Receipt" style={{ maxWidth: '100%', maxHeight: '60vh', objectFit: 'contain' }} />
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                {hasFile && (
                  <button
                    type="button"
                    onClick={async () => {
                      // Download via fetch + saveAs so the user always gets a real file save,
                      // never a new tab. Cross-origin signed URLs ignore the <a download>
                      // attribute, which previously opened the receipt inline instead of
                      // downloading it.
                      const url = signedUrl ?? (receipt.url ? await userExpensesService.getReceiptSignedUrl(receipt.url).catch(() => receipt.url!) : null);
                      if (!url) return;
                      const filename = (() => {
                        const path = receipt.url ?? '';
                        const base = path.split(/[\\/]/).pop() || '';
                        if (base) return base;
                        return isPdf ? 'receipt.pdf' : 'receipt';
                      })();
                      try {
                        const res = await fetch(url);
                        const blob = await res.blob();
                        saveAs(blob, filename);
                      } catch {
                        // Fallback: trigger a navigation download as best-effort.
                        saveAs(url, filename);
                      }
                    }}
                    disabled={!downloadHref && !receipt.url}
                    style={{
                      padding: '8px 14px', borderRadius: '6px',
                      backgroundColor: 'var(--primary-color)',
                      color: 'white',
                      fontWeight: 600, fontSize: '13px',
                      border: 'none', cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Download
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setReceiptPreview(null)}
                  style={{ padding: '8px 14px', borderRadius: '6px', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
