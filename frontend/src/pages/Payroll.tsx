import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { supabase } from '../lib/supabaseClient';
import { employeesService } from '../services/supabaseServices';

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
    customer?: {
      id: string;
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

// Round UP to nearest 0.10 hour (never round down)
const roundToQuarterHour = (hours: number): number => {
  return Math.ceil(hours * 10) / 10;
};

// Fallback period: 19 Jan 2026 to 1 Feb 2026 (payday Friday 6 Feb 2026)
const FALLBACK_PERIOD = { start: '2026-01-19', end: '2026-02-01' };

const formatPeriodDate = (d: Date): string => {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Current payroll period: 2 weeks, payday Friday 5 days after period end.
// Reference: 19 Jan–1 Feb 2026 → payday Friday 6 Feb 2026.
const getCurrentPayPeriod = (): { start: string; end: string } => {
  try {
    const referenceStart = new Date(2026, 0, 19); // Jan 19, 2026
    const periodLengthDays = 14;
    const daysUntilPayday = 5;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const msPerDay = 1000 * 60 * 60 * 24;
    const daysSinceReference = Math.floor((today.getTime() - referenceStart.getTime()) / msPerDay);

    let periodNumber: number;
    if (daysSinceReference >= 0) {
      periodNumber = Math.floor(daysSinceReference / periodLengthDays);
      const periodEndDate = new Date(referenceStart.getTime() + (periodNumber + 1) * periodLengthDays * msPerDay);
      periodEndDate.setDate(periodEndDate.getDate() - 1); // last day of period
      const paydayDate = new Date(periodEndDate);
      paydayDate.setDate(paydayDate.getDate() + daysUntilPayday);
      if (today > paydayDate) periodNumber++;
    } else {
      periodNumber = Math.floor(daysSinceReference / periodLengthDays);
    }

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
      start = new Date(today);
      start.setDate(today.getDate() - today.getDay());
      return { start: formatDate(start), end: formatDate(today) };
    case 'lastWeek':
      start = new Date(today);
      start.setDate(today.getDate() - today.getDay() - 7);
      end = new Date(start);
      end.setDate(start.getDate() + 6);
      return { start: formatDate(start), end: formatDate(end) };
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
            customer:customers!projects_customer_id_fkey(id)
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

  // Calculate grand totals (already rounded from employeeHours)
  const grandTotals = useMemo(() => {
    return employeeHours.reduce(
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
  }, [employeeHours]);

  // Grand total costs (admin only) - labor cost using employee pay rates
  const grandTotalsCosts = useMemo(() => {
    if (!isAdmin || !allEmployees || allEmployees.length === 0) return null;
    const empByUserId = new Map<string, any>();
    for (const e of allEmployees as any[]) {
      if (e.user_id) empByUserId.set(e.user_id, e);
    }
    let totalCost = 0;
    let internalCost = 0;
    let shopTimeCost = 0;
    let shopOvertimeCost = 0;
    let travelTimeCost = 0;
    let fieldTimeCost = 0;
    let fieldOvertimeCost = 0;
    for (const emp of employeeHours) {
      const employee = empByUserId.get(emp.userId);
      const shopRate = Number(employee?.shop_pay_rate) || 0;
      const shopOtRate = Number(employee?.shop_ot_pay_rate) || shopRate * 1.5;
      const fieldRate = Number(employee?.field_pay_rate) || shopRate;
      const fieldOtRate = Number(employee?.field_ot_pay_rate) || fieldRate * 1.5;
      const isPanelShop = employee?.department === 'Panel Shop';
      const ftRate = isPanelShop ? (fieldRate || shopRate) : fieldRate;
      const foRate = isPanelShop ? (fieldOtRate || shopOtRate) : fieldOtRate;
      internalCost += emp.internalHours * shopRate;
      shopTimeCost += emp.shopTime * shopRate;
      shopOvertimeCost += emp.shopOvertime * shopOtRate;
      travelTimeCost += emp.travelTime * shopRate;
      fieldTimeCost += emp.fieldTime * ftRate;
      fieldOvertimeCost += emp.fieldOvertime * foRate;
    }
    totalCost = internalCost + shopTimeCost + shopOvertimeCost + travelTimeCost + fieldTimeCost + fieldOvertimeCost;
    return { totalCost, internalCost, shopTimeCost, shopOvertimeCost, travelTimeCost, fieldTimeCost, fieldOvertimeCost };
  }, [isAdmin, allEmployees, employeeHours]);

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
        start = new Date(today);
        start.setDate(today.getDate() - today.getDay()); // Start of week (Sunday)
        break;
      case 'lastWeek':
        start = new Date(today);
        start.setDate(today.getDate() - today.getDay() - 7);
        end = new Date(start);
        end.setDate(start.getDate() + 6);
        break;
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>
          {isAdmin ? 'Payroll Report' : 'My Payroll'}
        </h2>
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: '24px', padding: '20px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'flex-end' }}>
          {/* Date Range */}
          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase' }}>
              Start Date
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              style={{
                padding: '8px 12px',
                backgroundColor: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'var(--text-primary)',
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase' }}>
              End Date
            </label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              style={{
                padding: '8px 12px',
                backgroundColor: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'var(--text-primary)',
              }}
            />
          </div>

          {/* Quick Presets — active preset is highlighted */}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {PRESET_KEYS.map((key) => {
              const label = key === 'currentPayPeriod' ? 'Current Pay Period' : key === 'previousPayPeriod' ? 'Previous Pay Period' : key === 'last2Weeks' ? 'Last 2 Weeks' : key === 'thisWeek' ? 'This Week' : key === 'lastWeek' ? 'Last Week' : key === 'thisMonth' ? 'This Month' : 'Last Month';
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
            })}
          </div>
          
          {/* Payday indicator */}
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '6px', 
            padding: '8px 12px',
            backgroundColor: 'rgba(76, 175, 80, 0.1)',
            borderRadius: '6px',
            border: '1px solid rgba(76, 175, 80, 0.3)',
          }}>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Payday:</span>
            <span style={{ fontSize: '12px', fontWeight: '600', color: '#4caf50' }}>{paydayLabel}</span>
          </div>
        </div>
      </div>

      {/* Loading / Error States */}
      {error ? (
        <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: '#ef5350' }}>Error loading report data</p>
        </div>
      ) : isLoading ? (
        <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-secondary)' }}>Loading payroll data...</p>
        </div>
      ) : employeeHours.length === 0 ? (
        <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-secondary)' }}>No time entries found for the selected period.</p>
        </div>
      ) : (
        <>
          {/* Summary Cards - admin sees total costs, non-admin sees hours */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '16px', marginBottom: '24px' }}>
            <div className="card" style={{ padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>
                {isAdmin && grandTotalsCosts ? 'Total Cost' : 'Total Hours'}
              </div>
              <div style={{ fontSize: '28px', fontWeight: '700', color: 'var(--text-primary)' }}>
                {isAdmin && grandTotalsCosts ? `$${grandTotalsCosts.totalCost.toFixed(2)}` : grandTotals.totalHours.toFixed(2)}
              </div>
            </div>
            <div className="card" style={{ padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>Internal Time</div>
              <div style={{ fontSize: '28px', fontWeight: '700', color: '#dc3545' }}>
                {isAdmin && grandTotalsCosts ? `$${grandTotalsCosts.internalCost.toFixed(2)}` : grandTotals.internalHours.toFixed(2)}
              </div>
            </div>
            <div className="card" style={{ padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>Shop Time</div>
              <div style={{ fontSize: '28px', fontWeight: '700', color: '#4caf50' }}>
                {isAdmin && grandTotalsCosts ? `$${grandTotalsCosts.shopTimeCost.toFixed(2)}` : grandTotals.shopTime.toFixed(2)}
              </div>
            </div>
            <div className="card" style={{ padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>Shop OT</div>
              <div style={{ fontSize: '28px', fontWeight: '700', color: '#ff9800' }}>
                {isAdmin && grandTotalsCosts ? `$${grandTotalsCosts.shopOvertimeCost.toFixed(2)}` : grandTotals.shopOvertime.toFixed(2)}
              </div>
            </div>
            <div className="card" style={{ padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>Travel Time</div>
              <div style={{ fontSize: '28px', fontWeight: '700', color: '#2196f3' }}>
                {isAdmin && grandTotalsCosts ? `$${grandTotalsCosts.travelTimeCost.toFixed(2)}` : grandTotals.travelTime.toFixed(2)}
              </div>
            </div>
            <div className="card" style={{ padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>Field Time</div>
              <div style={{ fontSize: '28px', fontWeight: '700', color: '#9c27b0' }}>
                {isAdmin && grandTotalsCosts ? `$${grandTotalsCosts.fieldTimeCost.toFixed(2)}` : grandTotals.fieldTime.toFixed(2)}
              </div>
            </div>
            <div className="card" style={{ padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>Field OT</div>
              <div style={{ fontSize: '28px', fontWeight: '700', color: '#e91e63' }}>
                {isAdmin && grandTotalsCosts ? `$${grandTotalsCosts.fieldOvertimeCost.toFixed(2)}` : grandTotals.fieldOvertime.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Employee Hours Table */}
          <div className="card" style={{ overflow: 'hidden' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600', color: 'var(--text-primary)' }}>
                {isAdmin ? 'Employee Hours by Rate Type' : 'Hours by Rate Type'}
              </h3>
              <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: 'var(--text-secondary)' }}>
                {startDate} to {endDate}{isAdmin ? ` • ${employeeHours.length} employee${employeeHours.length !== 1 ? 's' : ''}` : ''}
              </p>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
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
                  <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-primary)', textTransform: 'uppercase' }}>
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {employeeHours.map((emp) => (
                  <tr key={emp.userId} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td
                      style={{
                        padding: '14px 16px',
                        cursor: isAdmin ? 'pointer' : 'default',
                      }}
                      onClick={() => {
                        if (!isAdmin) return;
                        navigate(`/calendar?viewUserId=${emp.userId}`);
                      }}
                      title={isAdmin ? `View ${emp.name}'s calendar and time entries` : undefined}
                    >
                      <div style={{ fontWeight: '500', color: isAdmin ? 'var(--link-color, #2563eb)' : 'var(--text-primary)' }}>
                        {emp.name}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{emp.email}</div>
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '14px', color: emp.internalHours > 0 ? '#dc3545' : 'var(--text-secondary)' }}>
                      {emp.internalHours.toFixed(2)}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '14px', color: emp.shopTime > 0 ? '#4caf50' : 'var(--text-secondary)' }}>
                      {emp.shopTime.toFixed(2)}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '14px', color: emp.shopOvertime > 0 ? '#ff9800' : 'var(--text-secondary)' }}>
                      {emp.shopOvertime.toFixed(2)}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '14px', color: emp.travelTime > 0 ? '#2196f3' : 'var(--text-secondary)' }}>
                      {emp.travelTime.toFixed(2)}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '14px', color: emp.fieldTime > 0 ? '#9c27b0' : 'var(--text-secondary)' }}>
                      {emp.fieldTime.toFixed(2)}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '14px', color: emp.fieldOvertime > 0 ? '#e91e63' : 'var(--text-secondary)' }}>
                      {emp.fieldOvertime.toFixed(2)}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: 'var(--text-primary)' }}>
                      {emp.totalHours.toFixed(2)}
                    </td>
                  </tr>
                ))}
                {/* Totals Row */}
                <tr style={{ backgroundColor: 'var(--bg-secondary)', borderTop: '2px solid var(--border-color)' }}>
                  <td style={{ padding: '14px 16px', fontWeight: '700', color: 'var(--text-primary)' }}>
                    TOTALS
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#dc3545' }}>
                    {grandTotals.internalHours.toFixed(2)}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#4caf50' }}>
                    {grandTotals.shopTime.toFixed(2)}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#ff9800' }}>
                    {grandTotals.shopOvertime.toFixed(2)}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#2196f3' }}>
                    {grandTotals.travelTime.toFixed(2)}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#9c27b0' }}>
                    {grandTotals.fieldTime.toFixed(2)}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#e91e63' }}>
                    {grandTotals.fieldOvertime.toFixed(2)}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)' }}>
                    {grandTotals.totalHours.toFixed(2)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
