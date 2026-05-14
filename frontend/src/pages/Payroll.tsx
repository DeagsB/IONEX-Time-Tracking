import React, { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { supabase } from '../lib/supabaseClient';
import { employeesService, serviceTicketExpensesService, userExpensesService } from '../services/supabaseServices';
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
  entries,
  isContractor,
}: {
  employeeName: string;
  entries: TimeEntry[];
  isContractor: boolean;
}) {
  // Group by project
  const byProject = new Map<string, { name: string; customer: string; hours: number; byRateType: Map<string, number> }>();
  // Group by date for daily overtime check
  const byDate = new Map<string, { total: number; byRateType: Map<string, number> }>();
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

    if (!byDate.has(e.date)) byDate.set(e.date, { total: 0, byRateType: new Map() });
    const d = byDate.get(e.date)!;
    d.total += hrs;
    d.byRateType.set(rt, (d.byRateType.get(rt) || 0) + hrs);

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
    <div style={{ padding: '14px 16px', borderRadius: '6px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)' }}>
      <div style={{ fontWeight: '700', fontSize: '13px', color: 'var(--text-primary)', marginBottom: '12px' }}>
        Project Allocation & Daily Hours — {employeeName}
        {isContractor && <span style={{ fontSize: '11px', marginLeft: '8px', color: '#f59e0b' }}>(Contractor)</span>}
      </div>

      {/* Projects */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontSize: '11px', fontWeight: '700', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '6px' }}>
          Projects ({sortedProjects.length})
        </div>
        {sortedProjects.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', fontStyle: 'italic' }}>No project allocations.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                <th style={{ padding: '6px 8px', textAlign: 'left', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '600' }}>Project</th>
                <th style={{ padding: '6px 8px', textAlign: 'left', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '600' }}>Customer</th>
                <th style={{ padding: '6px 8px', textAlign: 'left', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '600' }}>Hours by rate type</th>
                <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '600' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {sortedProjects.map(([key, p]) => (
                <tr key={key} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '6px 8px' }}>{p.name}</td>
                  <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}>{p.customer || '—'}</td>
                  <td style={{ padding: '6px 8px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                    {Array.from(p.byRateType.entries()).map(([rt, h]) => `${rt}: ${h.toFixed(2)}h`).join(' · ')}
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', fontWeight: '600' }}>{p.hours.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Daily hours */}
      <div>
        <div style={{ fontSize: '11px', fontWeight: '700', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '6px' }}>
          Daily Hours — flagged when day &gt; {OVERTIME_DAILY_THRESHOLD}h or week &gt; {OVERTIME_WEEKLY_THRESHOLD}h
        </div>
        {sortedDates.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', fontStyle: 'italic' }}>No daily entries.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                <th style={{ padding: '6px 8px', textAlign: 'left', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '600' }}>Date</th>
                <th style={{ padding: '6px 8px', textAlign: 'left', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '600' }}>By rate type</th>
                <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '600' }}>Total</th>
                <th style={{ padding: '6px 8px', textAlign: 'center', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '600' }}>OT?</th>
              </tr>
            </thead>
            <tbody>
              {sortedDates.map(([date, d]) => {
                const wk = isoWeekKey(date);
                const weekTotal = byWeek.get(wk)?.total || 0;
                const paidOt = Array.from(d.byRateType.entries())
                  .filter(([rt]) => isPaidOvertimeRateType(rt))
                  .reduce((s, [, h]) => s + h, 0);
                const dayOver = d.total > OVERTIME_DAILY_THRESHOLD;
                const weekOver = weekTotal > OVERTIME_WEEKLY_THRESHOLD;
                const flagged = dayOver || weekOver;
                const otAlreadyPaid = paidOt > 0;
                const rowBg = flagged && !otAlreadyPaid ? 'rgba(245,158,11,0.10)' : 'transparent';
                return (
                  <tr key={date} style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: rowBg }}>
                    <td style={{ padding: '6px 8px' }}>{fmtDate(date)}</td>
                    <td style={{ padding: '6px 8px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                      {Array.from(d.byRateType.entries()).map(([rt, h]) => `${rt}: ${h.toFixed(2)}h`).join(' · ')}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', fontWeight: dayOver ? '700' : '500', color: dayOver ? '#ff9800' : 'var(--text-primary)' }}>
                      {d.total.toFixed(2)}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'center', fontSize: '11px' }}>
                      {!flagged ? (
                        <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                      ) : otAlreadyPaid ? (
                        <span style={{ color: '#4caf50', fontWeight: '600' }} title={`Paid OT: ${paidOt.toFixed(2)}h`}>Paid</span>
                      ) : (
                        <span style={{ color: '#ff9800', fontWeight: '700' }} title={`Day ${d.total.toFixed(2)}h${weekOver ? `, Week ${weekTotal.toFixed(2)}h` : ''}`}>
                          Owed?
                        </span>
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
      const { data, error } = await supabase
        .from('user_expenses')
        .select('service_ticket_id, description, status')
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
        .select('*')
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

  const { data: linkedTicketExpensesForReceipts = [] } = useQuery({
    queryKey: ['payrollLinkedTicketExpensesForReceipts', payrollReceiptIds.slice().sort().join(',')],
    queryFn: async () => {
      if (payrollReceiptIds.length === 0) return [];
      const { data, error } = await supabase
        .from('service_ticket_expenses')
        .select('user_expense_id, needs_reimbursement')
        .in('user_expense_id', payrollReceiptIds)
        .eq('needs_reimbursement', true);
      if (error) throw error;
      return data || [];
    },
    enabled: payrollReceiptIds.length > 0,
  });

  const receiptIdsCoveredByTicketLink = useMemo(() => {
    const s = new Set<string>();
    for (const r of linkedTicketExpensesForReceipts as any[]) {
      if (r.user_expense_id) s.add(String(r.user_expense_id));
    }
    return s;
  }, [linkedTicketExpensesForReceipts]);

  const queryClient = useQueryClient();
  const markPaidMutation = useMutation({
    mutationFn: async () => {
      await userExpensesService.markPaidForPeriod(startDate, endDate);
      await serviceTicketExpensesService.markReimbursementPaidForPeriod(startDate, endDate);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payrollReceiptExpenses', startDate, endDate] });
      queryClient.invalidateQueries({ queryKey: ['payrollTicketExpenses', startDate, endDate] });
    },
  });

  useEffect(() => {
    if (!isCurrentPeriod && startDate && endDate) {
      markPaidMutation.mutate();
    }
  }, [startDate, endDate, isCurrentPeriod]);

  // State for the reimbursement breakdown modal
  const [reimbursementModalUserId, setReimbursementModalUserId] = useState<string | null>(null);

  // State for expandable payroll breakdown rows
  const [expandedUsers, setExpandedUsers] = useState<Set<string>>(new Set());

  interface ReimbursementLine {
    category: string;
    description: string;
    quantity: number;
    rate: number;
    reimbRate: number;
    amount: number;
    ticketNumber?: string;
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
      });
    }

    // Process receipt expenses (subtotal + GST = employee out-of-pocket); includes catch-up for current period.
    // Skip receipts that are paid through a ticket-expense line — either via the
    // legacy direct-apply (matched by description on this period's ticket lines),
    // or via the new user_expense_id link (matched against ANY period's ticket
    // lines so a receipt linked to past-period tickets isn't paid again here).
    for (const exp of receiptExpensesForReimbursements as any[]) {
      if (receiptIdsCoveredByTicketLink.has(String(exp.id))) continue;
      if (linkedUserExpenseRedundantWithTicketExpenseLine(exp, ticketExpenses as any[])) continue;
      const userId = exp.user_id;
      if (!userId) continue;

      const amount = (Number(exp.amount) || 0) + (Number(exp.gst) || 0);
      const entry = getOrCreate(userId);
      entry.total += amount;
      entry.lines.push({
        category: 'Receipt',
        description: exp.description || '',
        quantity: 1,
        rate: amount,
        reimbRate: 1.00,
        amount,
      });
    }

    return map;
  }, [ticketExpenses, receiptExpensesForReimbursements, allEmployees, payrollLinkedApprovedReceipts, receiptIdsCoveredByTicketLink]);

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
    <div>
      <h1 className="ionex-page-title">{isAdmin ? 'Payroll Report' : 'My Payroll'}</h1>

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
          
          {/* Payday indicator */}
          <span className="ionex-tag" style={{ ['--tag-color' as string]: '#4caf50' } as React.CSSProperties}>
            <span className="label">Payday:</span>
            {paydayLabel}
          </span>
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
              className="button button-secondary"
              style={{ padding: '8px 14px', fontSize: '12px', marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px' }}
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
          <div className="ionex-summary-grid">
            <div className="ionex-summary-card" style={{ ['--summary-accent' as string]: 'var(--primary-color)' } as React.CSSProperties}>
              <span className="ionex-summary-card-eyebrow">
                <span className="accent" aria-hidden />
                {isAdmin ? 'Total Cost' : 'Total Hours'}
              </span>
              <span className="ionex-summary-card-value">
                {isAdmin ? `$${grandTotalsCosts.totalCost.toFixed(2)}` : grandTotals.totalHours.toFixed(2)}
              </span>
              {isAdmin && (
                <span className="ionex-summary-card-hint">
                  Gross + employer CPP/EI + reimbursements
                </span>
              )}
            </div>
            <div className="ionex-summary-card" style={{ ['--summary-accent' as string]: '#00897b' } as React.CSSProperties}>
              <span className="ionex-summary-card-eyebrow">
                <span className="accent" aria-hidden />
                Reimbursements
              </span>
              <span className="ionex-summary-card-value">
                ${grandTotalReimbursements.toFixed(2)}
              </span>
            </div>
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
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {/* overflow-x:auto on this wrapper would hide the scrollbar below the fold on tall tables.
                Letting the table push the page wide instead surfaces the Layout's existing overflow:auto
                horizontal scrollbar at the bottom of the viewport, which is always reachable. */}
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '900px' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
                  <th style={{ padding: '14px 16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                    Employee
                  </th>
                  <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: '#dc3545', textTransform: 'uppercase' }}>
                    Internal Time
                  </th>
                  <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: '#4caf50', textTransform: 'uppercase' }}>
                    Shop Time
                  </th>
                  <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: '#ff9800', textTransform: 'uppercase' }}>
                    Shop OT
                  </th>
                  <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: '#2196f3', textTransform: 'uppercase' }}>
                    Travel
                  </th>
                  <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: '#9c27b0', textTransform: 'uppercase' }}>
                    Field
                  </th>
                  <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: '#e91e63', textTransform: 'uppercase' }}>
                    Field OT
                  </th>
                  <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: '#00897b', textTransform: 'uppercase' }}>
                    Reimburse
                  </th>
                  <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-primary)', textTransform: 'uppercase' }}>
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayedEmployeeHours.map((emp) => {
                  const isExpanded = expandedUsers.has(emp.userId);
                  const breakdown = payrollBreakdownByUser.get(emp.userId);
                  return (
                  <React.Fragment key={emp.userId}>
                  <tr style={{ borderBottom: isExpanded ? 'none' : '1px solid var(--border-color)' }}>
                    <td style={{ padding: '14px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {isAdmin && (
                          <span
                            onClick={() => {
                              const next = new Set(expandedUsers);
                              if (next.has(emp.userId)) next.delete(emp.userId); else next.add(emp.userId);
                              setExpandedUsers(next);
                            }}
                            style={{
                              cursor: 'pointer', fontSize: '12px', color: 'var(--text-secondary)',
                              transition: 'transform 0.15s, color 0.15s', display: 'inline-block',
                              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                              userSelect: 'none', flexShrink: 0, width: '14px', textAlign: 'center',
                            }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLSpanElement).style.color = 'var(--text-primary)'; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLSpanElement).style.color = 'var(--text-secondary)'; }}
                            title="Toggle payroll breakdown"
                          >&#9654;</span>
                        )}
                        <div
                          style={{ cursor: isAdmin ? 'pointer' : 'default' }}
                          onClick={() => { if (isAdmin) navigate(`/calendar?viewUserId=${emp.userId}&from=payroll`); }}
                          title={isAdmin ? `View ${emp.name}'s calendar and time entries` : undefined}
                        >
                          <div style={{ fontWeight: '500', color: isAdmin ? 'var(--link-color, #2563eb)' : 'var(--text-primary)' }}>
                            {emp.name}
                            {breakdown?.isContractor && (
                              <span style={{ fontSize: '10px', marginLeft: '6px', padding: '1px 5px', borderRadius: '3px', backgroundColor: 'rgba(245,158,11,0.12)', color: '#f59e0b', fontWeight: '600', verticalAlign: 'middle' }}>
                                Contractor
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{emp.email}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '14px', color: emp.internalHours > 0 ? '#dc3545' : 'var(--text-secondary)' }}>
                      {formatCell(emp.internalHours, cellRate(emp.userId, 'internal'))}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '14px', color: emp.shopTime > 0 ? '#4caf50' : 'var(--text-secondary)' }}>
                      {formatCell(emp.shopTime, cellRate(emp.userId, 'shop'))}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '14px', color: emp.shopOvertime > 0 ? '#ff9800' : 'var(--text-secondary)' }}>
                      {formatCell(emp.shopOvertime, cellRate(emp.userId, 'shopOt'))}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '14px', color: emp.travelTime > 0 ? '#2196f3' : 'var(--text-secondary)' }}>
                      {formatCell(emp.travelTime, cellRate(emp.userId, 'travel'))}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '14px', color: emp.fieldTime > 0 ? '#9c27b0' : 'var(--text-secondary)' }}>
                      {formatCell(emp.fieldTime, cellRate(emp.userId, 'field'))}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '14px', color: emp.fieldOvertime > 0 ? '#e91e63' : 'var(--text-secondary)' }}>
                      {formatCell(emp.fieldOvertime, cellRate(emp.userId, 'fieldOt'))}
                    </td>
                    <td
                      style={{
                        padding: '14px 16px',
                        textAlign: 'right',
                        fontFamily: 'monospace',
                        fontSize: '14px',
                        fontWeight: '600',
                        color: (reimbursementsByUser.get(emp.userId)?.total || 0) > 0 ? '#00897b' : 'var(--text-secondary)',
                        cursor: (reimbursementsByUser.get(emp.userId)?.total || 0) > 0 ? 'pointer' : 'default',
                        textDecoration: (reimbursementsByUser.get(emp.userId)?.total || 0) > 0 ? 'underline' : 'none',
                      }}
                      onClick={() => {
                        const reimb = reimbursementsByUser.get(emp.userId);
                        if (reimb && reimb.total > 0) setReimbursementModalUserId(emp.userId);
                      }}
                      title={(reimbursementsByUser.get(emp.userId)?.total || 0) > 0 ? 'Click for breakdown' : undefined}
                    >
                      ${(reimbursementsByUser.get(emp.userId)?.total || 0).toFixed(2)}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: 'var(--text-primary)' }}>
                      {displayMode === 'dollars'
                        ? `$${(breakdown?.basePay ?? 0).toFixed(2)}`
                        : emp.totalHours.toFixed(2)}
                    </td>
                  </tr>
                  {isExpanded && isAdmin && (
                    <tr>
                      <td colSpan={9} style={{ padding: '0 16px 16px 42px', backgroundColor: 'var(--bg-secondary)' }}>
                        <EmployeeProjectsAndDailyBreakdown
                          employeeName={emp.name}
                          entries={emp.entries}
                          isContractor={!!breakdown?.isContractor}
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
                <tr style={{ backgroundColor: 'var(--bg-secondary)', borderTop: '2px solid var(--border-color)' }}>
                  <td style={{ padding: '14px 16px', fontWeight: '700', color: 'var(--text-primary)' }}>
                    TOTALS
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#dc3545' }}>
                    {fmt(grandTotals.internalHours, totInternal)}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#4caf50' }}>
                    {fmt(grandTotals.shopTime, totShop)}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#ff9800' }}>
                    {fmt(grandTotals.shopOvertime, totShopOt)}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#2196f3' }}>
                    {fmt(grandTotals.travelTime, totTravel)}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#9c27b0' }}>
                    {fmt(grandTotals.fieldTime, totField)}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#e91e63' }}>
                    {fmt(grandTotals.fieldOvertime, totFieldOt)}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#00897b' }}>
                    ${grandTotalReimbursements.toFixed(2)}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)' }}>
                    {displayMode === 'dollars' ? `$${totBasePay.toFixed(2)}` : grandTotals.totalHours.toFixed(2)}
                  </td>
                </tr>
                  );
                })()}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Reimbursement Breakdown Modal */}
      {reimbursementModalUserId && (() => {
        const reimb = reimbursementsByUser.get(reimbursementModalUserId);
        const empName = employeeHours.find(e => e.userId === reimbursementModalUserId)?.name || 'Employee';
        if (!reimb) return null;

        const grouped = new Map<string, { lines: ReimbursementLine[]; subtotal: number }>();
        for (const line of reimb.lines) {
          if (!grouped.has(line.category)) grouped.set(line.category, { lines: [], subtotal: 0 });
          const g = grouped.get(line.category)!;
          g.lines.push(line);
          g.subtotal += line.amount;
        }

        return (
          <div
            className="ionex-modal-backdrop"
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}
            onClick={() => setReimbursementModalUserId(null)}
          >
            <div
              className="ionex-modal-card"
              style={{ backgroundColor: 'var(--bg-primary)', borderRadius: '12px', padding: '24px', maxWidth: '700px', width: '90%', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '700', color: 'var(--text-primary)' }}>
                  Reimbursement Breakdown — {empName}
                </h3>
                <button
                  onClick={() => setReimbursementModalUserId(null)}
                  style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-secondary)', padding: '4px' }}
                >
                  &times;
                </button>
              </div>

              {Array.from(grouped.entries()).map(([category, group]) => (
                <div key={category} style={{ marginBottom: '20px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', paddingBottom: '4px', borderBottom: '1px solid var(--border-color)' }}>
                    <h4 style={{ margin: 0, fontSize: '14px', fontWeight: '700', color: '#00897b', textTransform: 'uppercase' }}>{category}</h4>
                    <span style={{ fontSize: '14px', fontWeight: '700', color: '#00897b' }}>${group.subtotal.toFixed(2)}</span>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ padding: '6px 8px', textAlign: 'left', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '600' }}>Description</th>
                        <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '600' }}>Qty</th>
                        <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '600' }}>Rate</th>
                        <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '600' }}>Reimb %</th>
                        <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '600' }}>Amount</th>
                        {category !== 'Receipt' && <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '600' }}>Ticket</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {group.lines.map((line, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-color)' }}>
                          <td style={{ padding: '6px 8px', fontSize: '13px' }}>{line.description}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '13px', fontFamily: 'monospace' }}>{line.quantity}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '13px', fontFamily: 'monospace' }}>${line.rate.toFixed(2)}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '13px', fontFamily: 'monospace' }}>{(line.reimbRate * 100).toFixed(0)}%</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '13px', fontFamily: 'monospace', fontWeight: '600' }}>${line.amount.toFixed(2)}</td>
                          {category !== 'Receipt' && <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '12px', color: 'var(--text-tertiary)' }}>{line.ticketNumber || '-'}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px', paddingTop: '12px', borderTop: '2px solid var(--border-color)' }}>
                <span style={{ fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)' }}>Total Reimbursement</span>
                <span style={{ fontSize: '18px', fontWeight: '700', color: '#00897b' }}>${reimb.total.toFixed(2)}</span>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
