import React, { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { supabase } from '../lib/supabaseClient';
import { employeesService, serviceTicketExpensesService, userExpensesService } from '../services/supabaseServices';
import { ticketExpenseReimbursementBase } from '../utils/ticketExpenseReimbursement';
import { linkedUserExpenseRedundantWithTicketExpenseLine } from '../utils/ticketExpenseReceiptMatch';
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
        reimbRate = Number(employee?.mileage_reimb_rate) || 0.90;
        category = 'Mileage';
      } else if (expType === 'hotel' || desc.includes('hotel')) {
        if (exp.needs_reimbursement === false) continue;
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
        category = 'Other Expense';
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

    // Process receipt expenses (subtotal + GST = employee out-of-pocket); includes catch-up for current period
    for (const exp of receiptExpensesForReimbursements as any[]) {
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
  }, [ticketExpenses, receiptExpensesForReimbursements, allEmployees, payrollLinkedApprovedReceipts]);

  const grandTotalReimbursements = useMemo(() => {
    const employeeIds = new Set(employeeHours.map((e) => e.userId));
    let total = 0;
    reimbursementsByUser.forEach((v, userId) => {
      if (employeeIds.has(userId)) total += v.total;
    });
    return total;
  }, [reimbursementsByUser, employeeHours]);

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
    let total = 0;
    payrollBreakdownByUser.forEach((b) => {
      const employerCpp = b.cpp;
      const employerEi = b.ei * EMPLOYER_EI_MULTIPLIER;
      total += b.grossPay + employerCpp + employerEi + b.reimbursements;
    });
    return total;
  }, [isAdmin, payrollBreakdownByUser]);
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
          {/* Summary Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '24px' }}>
            <div className="card" style={{ padding: '20px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>
                {isAdmin ? 'Total Cost' : 'Total Hours'}
              </div>
              <div style={{ fontSize: '32px', fontWeight: '700', color: 'var(--text-primary)' }}>
                {isAdmin ? `$${grandTotalsCosts.totalCost.toFixed(2)}` : grandTotals.totalHours.toFixed(2)}
              </div>
              {isAdmin && (
                <div style={{ fontSize: '10px', color: 'var(--text-tertiary)', marginTop: '4px', fontStyle: 'italic' }}>
                  Gross + employer CPP/EI + reimbursements
                </div>
              )}
            </div>
            <div className="card" style={{ padding: '20px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>Reimbursements</div>
              <div style={{ fontSize: '32px', fontWeight: '700', color: '#00897b' }}>
                ${grandTotalReimbursements.toFixed(2)}
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
                  <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: '#00897b', textTransform: 'uppercase' }}>
                    Reimburse
                  </th>
                  <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-primary)', textTransform: 'uppercase' }}>
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {employeeHours.map((emp) => {
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
                      {emp.totalHours.toFixed(2)}
                    </td>
                  </tr>
                  {isExpanded && isAdmin && breakdown && (
                    <tr>
                      <td colSpan={9} style={{ padding: '0 16px 16px 42px', backgroundColor: 'var(--bg-secondary)' }}>
                        <div style={{ padding: '14px 16px', borderRadius: '6px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)' }}>
                          <div style={{ fontWeight: '700', fontSize: '13px', color: 'var(--text-primary)', marginBottom: '10px' }}>
                            Payroll Breakdown — {emp.name}
                            {breakdown.isContractor && <span style={{ fontSize: '11px', marginLeft: '8px', color: '#f59e0b' }}>(Contractor)</span>}
                          </div>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                            <tbody>
                              <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}>Base Pay (Hours)</td>
                                <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', fontWeight: '600' }}>${breakdown.basePay.toFixed(2)}</td>
                              </tr>
                              {!breakdown.isContractor && (
                                <>
                                  <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                    <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}>Sick Pay ({breakdown.sickPct}%)</td>
                                    <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace' }}>${breakdown.sickPay.toFixed(2)}</td>
                                  </tr>
                                  <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                    <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}>Stat Holiday Pay ({breakdown.statPct}%)</td>
                                    <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace' }}>${breakdown.statHolidayPay.toFixed(2)}</td>
                                  </tr>
                                  <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                    <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}>Vacation Pay ({breakdown.vacationPct}%)</td>
                                    <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace' }}>${breakdown.vacationPay.toFixed(2)}</td>
                                  </tr>
                                  {breakdown.cellPhoneAllowance > 0 && (
                                    <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}>Cell Phone Allowance</td>
                                      <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace' }}>${breakdown.cellPhoneAllowance.toFixed(2)}</td>
                                    </tr>
                                  )}
                                  {breakdown.healthAllowance > 0 && (
                                    <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}>Health Allowance</td>
                                      <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace' }}>${breakdown.healthAllowance.toFixed(2)}</td>
                                    </tr>
                                  )}
                                </>
                              )}
                              {breakdown.isContractor && (
                                <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                  <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}>GST (5%)</td>
                                  <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace' }}>${breakdown.gst.toFixed(2)}</td>
                                </tr>
                              )}
                              <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
                                <td style={{ padding: '6px 8px', fontWeight: '600', color: 'var(--text-primary)' }}>Gross Pay</td>
                                <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', fontWeight: '700' }}>${breakdown.grossPay.toFixed(2)}</td>
                              </tr>
                              {!breakdown.isContractor && (
                                <>
                                  <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                    <td style={{ padding: '6px 8px', color: 'var(--text-secondary)', fontSize: '12px' }}>
                                      EI (1.66% est.){breakdown.eiMaxed && <span style={{ marginLeft: '6px', fontSize: '10px', color: '#ff9800', fontWeight: '600' }}>MAXED</span>}
                                    </td>
                                    <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', color: '#e53935' }}>-${breakdown.ei.toFixed(2)}</td>
                                  </tr>
                                  <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                    <td style={{ padding: '6px 8px', color: 'var(--text-secondary)', fontSize: '12px' }}>
                                      CPP (5.95% est.){breakdown.cppMaxed && <span style={{ marginLeft: '6px', fontSize: '10px', color: '#ff9800', fontWeight: '600' }}>MAXED</span>}
                                    </td>
                                    <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', color: '#e53935' }}>-${breakdown.cpp.toFixed(2)}</td>
                                  </tr>
                                  <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                    <td style={{ padding: '6px 8px', color: 'var(--text-secondary)', fontSize: '12px' }}>
                                      Income Tax (15% est.)
                                    </td>
                                    <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', color: '#e53935' }}>-${breakdown.incomeTax.toFixed(2)}</td>
                                  </tr>
                                  <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
                                    <td style={{ padding: '6px 8px', fontWeight: '600', color: 'var(--text-primary)' }}>Net Pay</td>
                                    <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', fontWeight: '700' }}>${breakdown.netPay.toFixed(2)}</td>
                                  </tr>
                                </>
                              )}
                              {breakdown.reimbursements > 0 && (
                                <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                  <td style={{ padding: '6px 8px', color: '#00897b' }}>Reimbursements</td>
                                  <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', color: '#00897b' }}>${breakdown.reimbursements.toFixed(2)}</td>
                                </tr>
                              )}
                              <tr style={{ backgroundColor: 'var(--bg-secondary)' }}>
                                <td style={{ padding: '8px', fontWeight: '700', fontSize: '14px', color: 'var(--text-primary)' }}>Total Payout</td>
                                <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'monospace', fontWeight: '700', fontSize: '14px', color: 'var(--text-primary)' }}>${breakdown.totalPayout.toFixed(2)}</td>
                              </tr>
                              {!breakdown.isContractor && (
                                <tr>
                                  <td colSpan={2} style={{ padding: '6px 8px', fontSize: '10px', color: 'var(--text-tertiary)', fontStyle: 'italic', textAlign: 'right' }}>
                                    * EI, CPP &amp; Income Tax are estimates only
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                  );
                })}
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
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#00897b' }}>
                    ${grandTotalReimbursements.toFixed(2)}
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
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}
            onClick={() => setReimbursementModalUserId(null)}
          >
            <div
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
