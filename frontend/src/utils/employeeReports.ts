// Employee Reports utility functions for data aggregation and analysis

import {
  buildSharedFieldsMapForProject,
  entryServiceTicketMatchKeys,
  dbServiceTicketMatchKeys,
} from './serviceTickets';
import { ticketExpenseBilledAmount, ticketExpenseCostForMargin } from './ticketExpenseReimbursement';

export interface TimeEntry {
  id: string;
  date: string;
  hours: number;
  rate: number;
  billable: boolean;
  rate_type?: string;
  description?: string;
  user_id: string;
  project_id?: string;
  location?: string;
  po_afe?: string;
  approver?: string;
  cc?: string;
  other?: string;
  user?: {
    id: string;
    first_name?: string;
    last_name?: string;
    email?: string;
  };
  project?: {
    id: string;
    name: string;
    project_number?: string;
    location?: string;
    po_afe?: string;
    customer?: {
      id: string;
      name: string;
    };
  };
}

export interface EmployeeWithRates {
  id: string;
  user_id: string;
  employee_id?: string;
  department?: string;
  position?: string;
  status?: string;
  // Billable rates (what customers are charged)
  rt_rate?: number;
  tt_rate?: number;
  ft_rate?: number;
  shop_ot_rate?: number;
  field_ot_rate?: number;
  // Internal rate (for non-billable work)
  internal_rate?: number;
  // Pay rates (what employee gets paid)
  shop_pay_rate?: number;
  field_pay_rate?: number;
  shop_ot_pay_rate?: number;
  field_ot_pay_rate?: number;
  // Employment type & benefits
  employment_type?: string;
  sick_pay_pct?: number;
  stat_holiday_pay_pct?: number;
  vacation_pay_pct?: number;
  cell_phone_allowance?: number;
  health_allowance?: number;
  // Reimbursement rate multipliers (0.90 = 90% of billed amount paid to employee)
  mileage_reimb_rate?: number;
  per_diem_reimb_rate?: number;
  hotel_reimb_rate?: number;
  truck_reimb_rate?: number;
  user?: {
    id: string;
    first_name?: string;
    last_name?: string;
    email?: string;
  };
}

export interface TicketExpense {
  id: string;
  service_ticket_id: string;
  expense_type?: string;
  description?: string;
  quantity: number;
  rate: number;
  actual_cost?: number;
  needs_reimbursement?: boolean;
  reimbursement_status?: string;
  service_tickets: {
    id: string;
    user_id: string;
    project_id?: string;
    date: string;
    workflow_status?: string;
    is_discarded?: boolean;
  };
}

export interface EmployeeMetrics {
  userId: string;
  employeeName: string;
  employeeEmail?: string;
  department?: string;
  position?: string;
  totalHours: number;
  billableHours: number;
  /** Billable hours from approved/exported tickets only (revenue-contributing) */
  billableHoursApproved: number;
  /** Billable hours from all tickets including draft/submitted/rejected */
  billableHoursAllTickets: number;
  nonBillableHours: number;
  billableRatio: number;
  /** Labor ticket revenue plus expense amounts billed to customer (GST per includeGst) */
  totalRevenue: number;
  laborCost: number;
  expenseCost: number;
  /** Amount billed to customer for expenses (all ticket expenses: quantity × rate) */
  expenseBilled: number;
  /** Breakdown by category: Per Diem, Mileage, Hotel, laptop rows, Other/Parts */
  expenseBreakdown: { category: string; billed: number; cost: number }[];
  totalCost: number; // laborCost + expenseCost
  netProfit: number; // totalRevenue - totalCost (includes expense billed in revenue)
  profitMargin: number; // (Net Profit / totalRevenue) * 100
  averageRate: number;
  averageCostPerHour: number;
  revenuePerHour: number;
  profitPerHour: number;
  serviceTicketCount: number;
  efficiency: number;
  rateTypeBreakdown: RateTypeBreakdown;
  projectBreakdown: ProjectBreakdown[];
  customerBreakdown: CustomerBreakdown[];
  trends: TrendData[];
}

export interface RateTypeBreakdown {
  internalTime: { hours: number; revenue: number; cost: number; profit: number };
  shopTime: { hours: number; revenue: number; cost: number; profit: number };
  fieldTime: { hours: number; revenue: number; cost: number; profit: number };
  travelTime: { hours: number; revenue: number; cost: number; profit: number };
  shopOvertime: { hours: number; revenue: number; cost: number; profit: number };
  fieldOvertime: { hours: number; revenue: number; cost: number; profit: number };
}

export interface ProjectBreakdown {
  projectId: string;
  projectName: string;
  hours: number;
  revenue: number;
  billableHours: number;
  expenseBilled: number;
  expenseCost: number;
}

export interface CustomerBreakdown {
  customerId: string;
  customerName: string;
  hours: number;
  revenue: number;
  billableHours: number;
}

export interface TrendData {
  date: string;
  hours: number;
  billableHours: number;
  revenue: number;
}

// Service ticket hours interface
export interface ServiceTicketHours {
  id: string;
  user_id: string;
  date: string;
  total_hours: number;
  total_amount?: number;
  customer_id?: string;
  project_id?: string;
  location?: string | null;
  header_overrides?: Record<string, string | undefined> | null;
  is_edited?: boolean;
  edited_hours?: Record<string, number | number[]>;
  workflow_status?: string;
  rejected_at?: string | null;
}

export interface PayRateHistory {
  id: string;
  employee_id: string;
  effective_date: string;
  shop_pay_rate?: number;
  field_pay_rate?: number;
  shop_ot_pay_rate?: number;
  field_ot_pay_rate?: number;
  internal_rate?: number;
}

function buildRateHistoryMap(rateHistory: PayRateHistory[]): Map<string, PayRateHistory[]> {
  const map = new Map<string, PayRateHistory[]>();
  for (const r of rateHistory) {
    const list = map.get(r.employee_id) || [];
    list.push(r);
    map.set(r.employee_id, list);
  }
  map.forEach(list => list.sort((a, b) => a.effective_date.localeCompare(b.effective_date)));
  return map;
}

function getRatesForDate(emp: EmployeeWithRates, historyMap: Map<string, PayRateHistory[]>, date: string): any {
  const history = historyMap.get(emp.id);
  if (!history || history.length === 0) return emp;
  let match: any = history[0];
  for (const h of history) {
    if (h.effective_date <= date) match = h;
    else break;
  }
  return match;
}

/** GST rate for billable amounts (Canada) */
const GST_RATE = 0.05;

/** Apply GST to a billable amount (returns amount inclusive of GST). Exported for use in Profitability. */
export function applyGst(amount: number): number {
  return amount * (1 + GST_RATE);
}

/** Apply GST to amount if includeGst is true; otherwise return amount unchanged. */
export function maybeApplyGst(amount: number, includeGst: boolean): number {
  return includeGst ? applyGst(amount) : amount;
}

/** Display / aggregation order for Hours by Rate Type → Expenses sub-rows */
export const EMPLOYEE_REPORT_EXPENSE_CATEGORY_ORDER = [
  'Per Diem',
  'Mileage',
  'Hotel',
  'Laptop/Basic Equipment',
  'Laptop/Field Service',
  'Other/Parts',
] as const;

export type EmployeeReportExpenseCategory = (typeof EMPLOYEE_REPORT_EXPENSE_CATEGORY_ORDER)[number];

/** Bucket for employee-report expense breakdown (must match {@link EMPLOYEE_REPORT_EXPENSE_CATEGORY_ORDER}). */
export function ticketExpenseCategoryForEmployeeReport(exp: {
  expense_type?: string;
  description?: string;
}): EmployeeReportExpenseCategory {
  const expType = (exp.expense_type || '').toLowerCase();
  const desc = (exp.description || '').toLowerCase();
  if (desc.includes('per diem')) return 'Per Diem';
  if (expType === 'travel') return 'Mileage';
  if (expType === 'hotel' || desc.includes('hotel')) return 'Hotel';
  if (desc.includes('laptop/basic') || desc.includes('laptop basic')) return 'Laptop/Basic Equipment';
  if (desc.includes('laptop/field') || (desc.includes('laptop') && desc.includes('field service')))
    return 'Laptop/Field Service';
  return 'Other/Parts';
}

function reimbRateForTicketExpenseCategory(
  category: EmployeeReportExpenseCategory,
  exp: { needs_reimbursement?: boolean },
  employee?: EmployeeWithRates
): number {
  switch (category) {
    case 'Per Diem':
      return Number(employee?.per_diem_reimb_rate) || 1;
    case 'Mileage':
      return exp.needs_reimbursement === false ? 0 : Number(employee?.mileage_reimb_rate) || 0.9;
    case 'Hotel':
      return exp.needs_reimbursement === false ? 0 : Number(employee?.hotel_reimb_rate) || 1;
    default:
      return 1;
  }
}

/** Same reimbursement rate rules as aggregateEmployeeMetrics (for drill-down line costs in UI). */
export function reimbRateForEmployeeReportExpense(
  exp: { expense_type?: string; description?: string; needs_reimbursement?: boolean },
  employee?: EmployeeWithRates
): number {
  const category = ticketExpenseCategoryForEmployeeReport(exp);
  return reimbRateForTicketExpenseCategory(category, exp, employee);
}

/** Employer CPP rate (matches employee portion) */
const CPP_RATE = 0.0595;
/** Employer EI: 1.4 × employee EI (1.66%) */
const EMPLOYER_EI_RATE = 1.4 * 0.0166;
/** Typical bi-weekly hours for flat allowance burden calculation */
const HOURS_PER_PAY_PERIOD = 80;

/**
 * Calculate burden rate from actual employee data (benefits, CPP, EI, allowances).
 * Contractors: 5% GST. Employees: sick + stat + vacation % + employer CPP + employer EI + flat allowances as % of base.
 */
export function calculateBurden(employee?: EmployeeWithRates): number {
  if (!employee) return 0;
  const isContractor = (employee.employment_type || 'Employee') === 'Contractor';
  if (isContractor) return 0.05;

  const sickPct = (Number(employee.sick_pay_pct) || 0) / 100;
  const statPct = (Number(employee.stat_holiday_pay_pct) || 0) / 100;
  const vacPct = (Number(employee.vacation_pay_pct) || 0) / 100;
  const benefitPct = sickPct + statPct + vacPct;

  // Employer CPP and EI are % of gross; gross = base × (1 + benefitPct)
  const payrollTaxPct = (CPP_RATE + EMPLOYER_EI_RATE) * (1 + benefitPct);

  // Flat allowances as % of typical bi-weekly base (80 hrs × rate)
  const baseRate = Number(employee.shop_pay_rate) || Number(employee.internal_rate) || 0;
  const cellPhone = Number(employee.cell_phone_allowance) || 0;
  const health = Number(employee.health_allowance) || 0;
  const flatAllowancePct =
    baseRate > 0 && (cellPhone > 0 || health > 0)
      ? (cellPhone + health) / (HOURS_PER_PAY_PERIOD * baseRate)
      : 0;

  return benefitPct + payrollTaxPct + flatAllowancePct;
}

/** Coerce billable: DB may return boolean or string; only true/'true' is billable. */
function isBillable(entry: TimeEntry): boolean {
  const b = entry.billable as unknown;
  return b === true || (typeof b === 'string' && b.toLowerCase() === 'true');
}

/** Precompute shared location/PO maps per project (same as Service Tickets grouping). */
function buildSharedMapsByProject(entries: TimeEntry[]): Map<string, ReturnType<typeof buildSharedFieldsMapForProject>> {
  const byProject = new Map<string, TimeEntry[]>();
  entries.forEach((e) => {
    if (!e.project_id) return;
    if (!byProject.has(e.project_id)) byProject.set(e.project_id, []);
    byProject.get(e.project_id)!.push(e);
  });
  const out = new Map<string, ReturnType<typeof buildSharedFieldsMapForProject>>();
  byProject.forEach((list, pid) => {
    out.set(pid, buildSharedFieldsMapForProject(list, pid));
  });
  return out;
}

/** Time entries that belong on this service ticket (not all same-day rows for user+project). */
function entriesMatchingServiceTicket(
  entries: TimeEntry[],
  ticket: ServiceTicketHours,
  sharedMapsByProject: Map<string, ReturnType<typeof buildSharedFieldsMapForProject>>
): TimeEntry[] {
  if (!ticket.project_id) return [];
  const sharedMap = sharedMapsByProject.get(ticket.project_id);
  if (!sharedMap) return [];
  const shareKey = `${ticket.date}-${ticket.user_id}-${ticket.project_id}`;
  const shared = sharedMap.get(shareKey) || {};
  const projectFallback = entries.find((e) => e.project_id === ticket.project_id)?.project as
    | { location?: string; po_afe?: string }
    | undefined;
  const ticketKeys = dbServiceTicketMatchKeys(ticket, projectFallback || null);
  return entries.filter((entry) => {
    if (entry.user_id !== ticket.user_id || entry.project_id !== ticket.project_id || entry.date !== ticket.date) return false;
    if (!isBillable(entry)) return false;
    if (ticket.customer_id && entry.project?.customer?.id && entry.project.customer.id !== ticket.customer_id) return false;
    const ek = entryServiceTicketMatchKeys(entry, shared, entry.project || projectFallback);
    return ek.locationKey === ticketKeys.locationKey && ek.groupingKey === ticketKeys.groupingKey;
  });
}

const NON_REVENUE_STATUSES = new Set(['draft', 'submitted', 'rejected']);

/**
 * Sum billable hours from service tickets, split by approved vs all (including draft/submitted/rejected).
 */
function calculateBillableHoursByStatus(
  userId: string,
  serviceTicketHours: ServiceTicketHours[],
  entries: TimeEntry[]
): { approved: number; all: number } {
  let approved = 0;
  let all = 0;
  const userTickets = serviceTicketHours.filter(t => t.user_id === userId);
  const sharedMapsByProject = buildSharedMapsByProject(entries);
  for (const ticket of userTickets) {
    let hours = 0;
    if (ticket.is_edited && ticket.edited_hours) {
      Object.values(ticket.edited_hours).forEach(h => {
        if (Array.isArray(h)) hours += (h as number[]).reduce((s, x) => s + (Number(x) || 0), 0);
        else hours += Number(h) || 0;
      });
    } else {
      hours = Number(ticket.total_hours) || 0;
      const ws = (ticket.workflow_status || 'draft').toLowerCase();
      const isDraftRejected = ws === 'draft' || ws === 'rejected' || !!(ticket.rejected_at != null && ticket.rejected_at !== '');
      if (hours === 0 && isDraftRejected) {
        const matching = entriesMatchingServiceTicket(entries, ticket, sharedMapsByProject);
        hours = matching.reduce((s, e) => s + (Number(e.hours) || 0), 0);
      }
    }
    if (hours > 0) {
      all += hours;
      if (!NON_REVENUE_STATUSES.has(ticket.workflow_status || 'draft')) {
        approved += hours;
      }
    }
  }
  return { approved, all };
}

// Aggregate metrics for a single employee from their time entries
export function aggregateEmployeeMetrics(
  entries: TimeEntry[],
  employee?: EmployeeWithRates,
  serviceTicketHours?: ServiceTicketHours[],
  rateHistory?: PayRateHistory[],
  ticketExpenses?: TicketExpense[],
  includeGst: boolean = true
): EmployeeMetrics {
  const rateHistoryMap = buildRateHistoryMap(rateHistory || []);
  console.log('aggregateEmployeeMetrics called:', { entriesCount: entries?.length || 0, employee: employee?.user_id });
  
  if (!entries || entries.length === 0) {
    const userId = employee?.user_id || '';
    const employeeName = employee?.user 
      ? `${employee.user.first_name || ''} ${employee.user.last_name || ''}`.trim() || 'Unknown'
      : employee?.user_id || 'Unknown';
    
    console.log('No entries for employee:', { userId, employeeName, employee });

    // Still compute project breakdown for expenses-only (employee may have expenses without time entries)
    const projectBreakdown = calculateProjectBreakdown([], employee, undefined, ticketExpenses, includeGst);
    const expenseBilled = projectBreakdown.reduce((s, p) => s + p.expenseBilled, 0);
    const expenseCost = projectBreakdown.reduce((s, p) => s + p.expenseCost, 0);
    const totalRevenueExpensesOnly = expenseBilled;
    const totalCostExpensesOnly = expenseCost;
    const netProfitExpensesOnly = totalRevenueExpensesOnly - totalCostExpensesOnly;
    
    return {
      userId,
      employeeName,
      employeeEmail: employee?.user?.email,
      department: employee?.department,
      position: employee?.position,
      totalHours: 0,
      billableHours: 0,
      billableHoursApproved: 0,
      billableHoursAllTickets: 0,
      nonBillableHours: 0,
      billableRatio: 0,
      totalRevenue: totalRevenueExpensesOnly,
      laborCost: 0,
      expenseCost,
      expenseBilled,
      expenseBreakdown: [], // Category breakdown requires full aggregation; project breakdown has expenses
      totalCost: totalCostExpensesOnly,
      netProfit: netProfitExpensesOnly,
      profitMargin: totalRevenueExpensesOnly > 0 ? (netProfitExpensesOnly / totalRevenueExpensesOnly) * 100 : 0,
      averageRate: 0,
      averageCostPerHour: 0,
      revenuePerHour: 0,
      profitPerHour: 0,
      serviceTicketCount: 0,
      efficiency: 0,
      rateTypeBreakdown: {
        internalTime: { hours: 0, revenue: 0, cost: 0, profit: 0 },
        shopTime: { hours: 0, revenue: 0, cost: 0, profit: 0 },
        fieldTime: { hours: 0, revenue: 0, cost: 0, profit: 0 },
        travelTime: { hours: 0, revenue: 0, cost: 0, profit: 0 },
        shopOvertime: { hours: 0, revenue: 0, cost: 0, profit: 0 },
        fieldOvertime: { hours: 0, revenue: 0, cost: 0, profit: 0 },
      },
      projectBreakdown,
      customerBreakdown: [],
      trends: [],
    };
  }

  const user = entries[0]?.user;
  const userId = entries[0]?.user_id || employee?.user_id || '';
  
  console.log('Processing entries for userId:', userId, 'entry count:', entries.length);

  // Calculate totals
  let totalHours = 0; // Will be calculated as billable + non-billable
  let billableHours = 0; // Will be overwritten from rateTypeBreakdown
  let totalRevenue = 0; // Will be overwritten from rateTypeBreakdown

  // Rate type breakdown (includes cost and profit calculations)
  // Calculate this FIRST so we can use it for billable hours and revenue
  const rateTypeBreakdown = calculateRateTypeBreakdown(entries, employee, serviceTicketHours, rateHistoryMap);

  // Billable hours should come from service ticket hours (via rateTypeBreakdown), not time entries
  // This ensures billable hours match what's on the service tickets
  billableHours = rateTypeBreakdown.shopTime.hours +
                  rateTypeBreakdown.fieldTime.hours +
                  rateTypeBreakdown.travelTime.hours +
                  rateTypeBreakdown.shopOvertime.hours +
                  rateTypeBreakdown.fieldOvertime.hours;

  // Split billable hours by workflow status (approved vs draft/submitted/rejected)
  const { approved: approvedFromHelper, all: allFromHelper } = serviceTicketHours
    ? calculateBillableHoursByStatus(userId, serviceTicketHours, entries)
    : { approved: billableHours, all: billableHours };
  const billableHoursAllTickets = billableHours;
  const billableHoursApproved = allFromHelper > 0
    ? billableHours * (approvedFromHelper / allFromHelper)
    : billableHours;

  // Revenue: use total_amount from approved/exported service tickets (matching Profitability page)
  // Draft/submitted/rejected tickets do NOT contribute to revenue
  if (serviceTicketHours) {
    serviceTicketHours
      .filter(t => t.user_id === userId)
      .filter(t => {
        const hrs = Number(t.total_hours) || 0;
        const amt = Number(t.total_amount) || 0;
        if (hrs === 0 && amt === 0 && !t.is_edited && (t.workflow_status || 'draft') === 'draft') return false;
        return true;
      })
      .forEach(t => {
        if (!NON_REVENUE_STATUSES.has(t.workflow_status || 'draft')) {
          totalRevenue += Number(t.total_amount) || 0;
        }
      });
  }

  // Apply GST to billable revenue when includeGst is true
  const totalRevenuePreGst = totalRevenue;
  totalRevenue = maybeApplyGst(totalRevenue, includeGst);

  // Update rate type breakdown revenue to use actual total_amount (proportionally distributed)
  // This ensures the breakdown rows sum to the actual revenue (GST-inclusive when includeGst)
  const estimatedRevenue = rateTypeBreakdown.shopTime.revenue +
                           rateTypeBreakdown.fieldTime.revenue +
                           rateTypeBreakdown.travelTime.revenue +
                           rateTypeBreakdown.shopOvertime.revenue +
                           rateTypeBreakdown.fieldOvertime.revenue;
  if (estimatedRevenue > 0 && totalRevenuePreGst > 0) {
    const scale = totalRevenuePreGst / estimatedRevenue;
    rateTypeBreakdown.shopTime.revenue = maybeApplyGst(rateTypeBreakdown.shopTime.revenue * scale, includeGst);
    rateTypeBreakdown.fieldTime.revenue = maybeApplyGst(rateTypeBreakdown.fieldTime.revenue * scale, includeGst);
    rateTypeBreakdown.travelTime.revenue = maybeApplyGst(rateTypeBreakdown.travelTime.revenue * scale, includeGst);
    rateTypeBreakdown.shopOvertime.revenue = maybeApplyGst(rateTypeBreakdown.shopOvertime.revenue * scale, includeGst);
    rateTypeBreakdown.fieldOvertime.revenue = maybeApplyGst(rateTypeBreakdown.fieldOvertime.revenue * scale, includeGst);
    rateTypeBreakdown.shopTime.profit = rateTypeBreakdown.shopTime.revenue - rateTypeBreakdown.shopTime.cost;
    rateTypeBreakdown.fieldTime.profit = rateTypeBreakdown.fieldTime.revenue - rateTypeBreakdown.fieldTime.cost;
    rateTypeBreakdown.travelTime.profit = rateTypeBreakdown.travelTime.revenue - rateTypeBreakdown.travelTime.cost;
    rateTypeBreakdown.shopOvertime.profit = rateTypeBreakdown.shopOvertime.revenue - rateTypeBreakdown.shopOvertime.cost;
    rateTypeBreakdown.fieldOvertime.profit = rateTypeBreakdown.fieldOvertime.revenue - rateTypeBreakdown.fieldOvertime.cost;
  } else if (totalRevenue > 0 && estimatedRevenue === 0) {
    rateTypeBreakdown.shopTime.revenue = totalRevenue; // already GST-inclusive
    rateTypeBreakdown.shopTime.profit = totalRevenue - rateTypeBreakdown.shopTime.cost;
  }

  // Helper function to round up to nearest 0.25 (quarter hour) for payroll hours calculation
  const roundToQuarterHourForPayroll = (hours: number): number => {
    return Math.ceil(hours * 4) / 4;
  };

  // Calculate payroll hours by rate type (actual hours worked from time entries)
  const payrollHoursByRateType = {
    shopTime: 0,
    fieldTime: 0,
    travelTime: 0,
    shopOvertime: 0,
    fieldOvertime: 0,
    internal: 0,
  };

  entries.forEach(entry => {
    const hours = Number(entry.hours) || 0;
    const rateType = (entry.rate_type || 'Shop Time').toLowerCase();
    const isInternal = !isBillable(entry);
    
    if (isInternal) {
      payrollHoursByRateType.internal += hours;
    } else if (rateType.includes('shop') && rateType.includes('overtime')) {
      payrollHoursByRateType.shopOvertime += hours;
    } else if (rateType.includes('field') && rateType.includes('overtime')) {
      payrollHoursByRateType.fieldOvertime += hours;
    } else if (rateType.includes('field')) {
      payrollHoursByRateType.fieldTime += hours;
    } else if (rateType.includes('travel')) {
      payrollHoursByRateType.travelTime += hours;
    } else {
      payrollHoursByRateType.shopTime += hours;
    }
  });

  // Calculate non-billable hours:
  // Non-billable = internal time entries + unbilled work (entry hours not on a non-discarded service ticket).
  // - Time that was on discarded service tickets counts as non-billable only when it has backing
  //   calendar (time) entries; unbilled is computed from entry hours minus non-discarded ticket hours,
  //   so discarded-ticket time that has entries is already included in unbilled.
  // - Manually added ticket rows (no time entry on the calendar) must NOT contribute to non-billable;
  //   we never add ticket-only hours here because unbilled uses payroll (entry) hours only.
  // First, round each payroll rate type to 0.25 (matching Payroll page)
  const roundedPayrollHours = {
    shopTime: roundToQuarterHourForPayroll(payrollHoursByRateType.shopTime),
    fieldTime: roundToQuarterHourForPayroll(payrollHoursByRateType.fieldTime),
    travelTime: roundToQuarterHourForPayroll(payrollHoursByRateType.travelTime),
    shopOvertime: roundToQuarterHourForPayroll(payrollHoursByRateType.shopOvertime),
    fieldOvertime: roundToQuarterHourForPayroll(payrollHoursByRateType.fieldOvertime),
    internal: roundToQuarterHourForPayroll(payrollHoursByRateType.internal),
  };
  
  const internalTimeEntryHours = roundedPayrollHours.internal;
  
  // Calculate unbilled work for each billable rate type using ROUNDED payroll hours
  // Only add positive differences (work done but not billed)
  // Negative differences (billed more than worked, like minimums) don't affect non-billable
  const unbilledShopTime = Math.max(0, roundedPayrollHours.shopTime - rateTypeBreakdown.shopTime.hours);
  const unbilledFieldTime = Math.max(0, roundedPayrollHours.fieldTime - rateTypeBreakdown.fieldTime.hours);
  const unbilledTravelTime = Math.max(0, roundedPayrollHours.travelTime - rateTypeBreakdown.travelTime.hours);
  const unbilledShopOT = Math.max(0, roundedPayrollHours.shopOvertime - rateTypeBreakdown.shopOvertime.hours);
  const unbilledFieldOT = Math.max(0, roundedPayrollHours.fieldOvertime - rateTypeBreakdown.fieldOvertime.hours);
  
  const totalUnbilledWork = unbilledShopTime + unbilledFieldTime + unbilledTravelTime + unbilledShopOT + unbilledFieldOT;
  
  // Non-billable hours = rounded internal time entries + unbilled work from billable rate types
  const nonBillableHours = internalTimeEntryHours + totalUnbilledWork;
  
  // Calculate the COST of unbilled work (hours worked but not billed still have a cost)
  // Use the employee's loaded pay rates (with burden) to determine the cost of unbilled hours
  const unbilledBurden = 1 + calculateBurden(employee);
  const getPayRateForUnbilled = (rateType: 'shop' | 'field' | 'travel' | 'shopOT' | 'fieldOT'): number => {
    if (!employee) return 0;
    const panelShop = employee.department === 'Panel Shop';
    let baseRate = 0;
    if (panelShop) {
      if (rateType === 'shopOT') baseRate = employee.shop_ot_pay_rate || employee.shop_pay_rate || 0;
      else if (rateType === 'fieldOT') baseRate = employee.field_ot_pay_rate || employee.shop_pay_rate || 0;
      else if (rateType === 'field') baseRate = employee.field_pay_rate || employee.shop_pay_rate || 0;
      else baseRate = employee.shop_pay_rate || 0;
    } else {
      if (rateType === 'shopOT') baseRate = employee.shop_ot_pay_rate || 0;
      else if (rateType === 'fieldOT') baseRate = employee.field_ot_pay_rate || 0;
      else if (rateType === 'field') baseRate = employee.field_pay_rate || 0;
      else if (rateType === 'travel') baseRate = employee.shop_pay_rate || 0;
      else baseRate = employee.shop_pay_rate || 0;
    }
    return baseRate * unbilledBurden;
  };
  
  const unbilledShopTimeCost = unbilledShopTime * getPayRateForUnbilled('shop');
  const unbilledFieldTimeCost = unbilledFieldTime * getPayRateForUnbilled('field');
  const unbilledTravelTimeCost = unbilledTravelTime * getPayRateForUnbilled('travel');
  const unbilledShopOTCost = unbilledShopOT * getPayRateForUnbilled('shopOT');
  const unbilledFieldOTCost = unbilledFieldOT * getPayRateForUnbilled('fieldOT');
  const totalUnbilledWorkCost = unbilledShopTimeCost + unbilledFieldTimeCost + unbilledTravelTimeCost + unbilledShopOTCost + unbilledFieldOTCost;

  // Update the rate type breakdown to reflect the non-billable hours AND cost (for display)
  rateTypeBreakdown.internalTime.hours = nonBillableHours;
  // Add the cost of unbilled work to the internal time cost (which already has cost of non-billable entries)
  rateTypeBreakdown.internalTime.cost += totalUnbilledWorkCost;
  // Update profit: non-billable work has 0 revenue, so profit = -cost
  rateTypeBreakdown.internalTime.profit = -rateTypeBreakdown.internalTime.cost;

  // Total hours = billable + non-billable (based on rounded payroll, for consistency)
  totalHours = billableHours + nonBillableHours;

  // Total payroll hours for ratio calculation (sum of rounded values)
  const totalPayrollHours = roundedPayrollHours.shopTime + 
                            roundedPayrollHours.fieldTime + 
                            roundedPayrollHours.travelTime + 
                            roundedPayrollHours.shopOvertime + 
                            roundedPayrollHours.fieldOvertime + 
                            roundedPayrollHours.internal;
  
  // Billable ratio should be calculated as billable hours / total hours worked
  // This represents what percentage of total hours are billable (should be <= 100%)
  // Using totalHours instead of totalPayrollHours to avoid efficiency > 100% when service tickets have minimums
  const billableRatio = totalHours > 0 ? (billableHours / totalHours) * 100 : 0;
  
  // Total service ticket hours for average rate = billable hours (includes approved + draft/rejected/resubmitted from breakdown)
  const totalServiceTicketHours = billableHours;
  
  const averageRate = totalServiceTicketHours > 0 ? totalRevenue / totalServiceTicketHours : 0;
  const efficiency = billableRatio; // Efficiency is same as billable ratio

  // Count actual service ticket records for this employee, excluding empty placeholders
  const serviceTicketCount = serviceTicketHours
    ? serviceTicketHours.filter(t => {
        if (t.user_id !== userId) return false;
        const hrs = Number(t.total_hours) || 0;
        const amt = Number(t.total_amount) || 0;
        if (hrs === 0 && amt === 0 && !t.is_edited && (t.workflow_status || 'draft') === 'draft') return false;
        return true;
      }).length
    : 0;

  // Labor cost: derive from the rate type breakdown (single source of truth)
  const laborCost = rateTypeBreakdown.internalTime.cost +
                    rateTypeBreakdown.shopTime.cost +
                    rateTypeBreakdown.fieldTime.cost +
                    rateTypeBreakdown.travelTime.cost +
                    rateTypeBreakdown.shopOvertime.cost +
                    rateTypeBreakdown.fieldOvertime.cost;

  // Calculate expense cost and billed amount from service ticket expenses for this employee.
  // expenseBilled = total amount billed to customer (all expenses: quantity × rate).
  // expenseCost = employee reimbursement (reimb base × rate) and/or company COGS on billed-only lines
  // (see ticketExpenseCostForMargin: actual_cost when set, else billed for parts/hotel; travel billed-only uses actual only).
  const expenseBreakdownMap = new Map<string, { billed: number; cost: number }>();
  const getOrCreate = (cat: string) => {
    if (!expenseBreakdownMap.has(cat)) expenseBreakdownMap.set(cat, { billed: 0, cost: 0 });
    return expenseBreakdownMap.get(cat)!;
  };

  let expenseCost = 0;
  let expenseBilled = 0;
  if (ticketExpenses) {
    ticketExpenses.forEach(exp => {
      if (exp.service_tickets?.user_id !== userId) return;
      const billed = ticketExpenseBilledAmount(exp);
      expenseBilled += billed;

      const category = ticketExpenseCategoryForEmployeeReport(exp);
      const reimbRate = reimbRateForTicketExpenseCategory(category, exp, employee);

      const lineCost = ticketExpenseCostForMargin(exp, reimbRate);
      const entry = getOrCreate(category);
      entry.billed += billed;
      entry.cost += lineCost;
      expenseCost += lineCost;
    });
  }

  // Apply GST to billable expense amounts when includeGst is true
  expenseBilled = maybeApplyGst(expenseBilled, includeGst);

  // Total revenue for KPIs / profit = labor (service ticket amounts) + amounts billed for expenses
  totalRevenue += expenseBilled;

  const expenseBreakdown = Array.from(expenseBreakdownMap.entries())
    .filter(([, v]) => v.billed > 0)
    .map(([category, v]) => ({ category, billed: maybeApplyGst(v.billed, includeGst), cost: v.cost }))
    .sort((a, b) => {
      const order = EMPLOYEE_REPORT_EXPENSE_CATEGORY_ORDER as readonly string[];
      const ia = order.indexOf(a.category);
      const ib = order.indexOf(b.category);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });

  const totalCost = laborCost + expenseCost;

  // Calculate profit metrics
  const netProfit = totalRevenue - totalCost;
  const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;
  const averageCostPerHour = totalHours > 0 ? totalCost / totalHours : 0;
  const revenuePerHour = totalHours > 0 ? totalRevenue / totalHours : 0;
  const profitPerHour = totalHours > 0 ? netProfit / totalHours : 0;

  // Project breakdown (includes expenses allocated to each project)
  const projectBreakdown = calculateProjectBreakdown(entries, employee, serviceTicketHours, ticketExpenses, includeGst);

  // Customer breakdown
  const customerBreakdown = calculateCustomerBreakdown(entries, employee, serviceTicketHours, includeGst);

  // Trends
  const trends = calculateTrends(entries, includeGst);

  // Use rate type breakdown as single source of truth for non-billable (keeps summary and breakdown in sync)
  const nonBillableHoursDisplay = rateTypeBreakdown.internalTime.hours;

  return {
    userId,
    employeeName: user 
      ? `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Unknown'
      : employee?.user 
        ? `${employee.user.first_name || ''} ${employee.user.last_name || ''}`.trim() || 'Unknown'
        : 'Unknown',
    employeeEmail: user?.email || employee?.user?.email,
    department: employee?.department,
    position: employee?.position,
    totalHours,
    billableHours,
    billableHoursApproved,
    billableHoursAllTickets,
    nonBillableHours: nonBillableHoursDisplay,
    billableRatio,
    totalRevenue,
    laborCost,
    expenseCost,
    expenseBilled,
    expenseBreakdown,
    totalCost,
    netProfit,
    profitMargin,
    averageRate,
    averageCostPerHour,
    revenuePerHour,
    profitPerHour,
    serviceTicketCount,
    efficiency,
    rateTypeBreakdown,
    projectBreakdown,
    customerBreakdown,
    trends,
  };
}

// Calculate breakdown by rate type (includes cost and profit)
export function calculateRateTypeBreakdown(
  entries: TimeEntry[],
  employee?: EmployeeWithRates,
  serviceTicketHours?: ServiceTicketHours[],
  rateHistoryMap?: Map<string, PayRateHistory[]>
): RateTypeBreakdown {
  const breakdown: RateTypeBreakdown = {
    internalTime: { hours: 0, revenue: 0, cost: 0, profit: 0 },
    shopTime: { hours: 0, revenue: 0, cost: 0, profit: 0 },
    fieldTime: { hours: 0, revenue: 0, cost: 0, profit: 0 },
    travelTime: { hours: 0, revenue: 0, cost: 0, profit: 0 },
    shopOvertime: { hours: 0, revenue: 0, cost: 0, profit: 0 },
    fieldOvertime: { hours: 0, revenue: 0, cost: 0, profit: 0 },
  };

  const userId = entries[0]?.user_id || employee?.user_id || '';
  const isPanelShop = employee?.department === 'Panel Shop';
  const burdenMult = 1 + calculateBurden(employee);

  // Helper function to get loaded pay rate for a rate type using historical rates (base pay × burden)
  const getPayRate = (rateType: string, date: string): number => {
    if (!employee) return 0;
    const rates = rateHistoryMap && rateHistoryMap.size > 0
      ? getRatesForDate(employee, rateHistoryMap, date)
      : employee;
    let baseRate = 0;
    if (rateType.includes('shop') && rateType.includes('overtime')) {
      baseRate = Number(rates.shop_ot_pay_rate) || 0;
    } else if (rateType.includes('field') && rateType.includes('overtime')) {
      baseRate = Number(rates.field_ot_pay_rate) || 0;
    } else if (rateType.includes('field')) {
      baseRate = Number(rates.field_pay_rate) || 0;
    } else if (rateType.includes('travel')) {
      // Travel time always uses shop pay rate (never field). Prefer current employee rate to avoid inflated cost from stale history.
      baseRate = Number(employee.shop_pay_rate) || Number(rates.shop_pay_rate) || 0;
    } else {
      baseRate = Number(rates.shop_pay_rate) || 0;
    }
    return baseRate * burdenMult;
  };

  // Helper function to get billable rate for a rate type
  const getBillableRate = (rateType: string): number => {
    if (employee) {
      if (rateType.includes('shop') && rateType.includes('overtime')) {
        return Number(employee.shop_ot_rate) || 0;
      } else if (rateType.includes('field') && rateType.includes('overtime')) {
        return Number(employee.field_ot_rate) || 0;
      } else if (rateType.includes('field')) {
        return Number(employee.ft_rate) || 0;
      } else if (rateType.includes('travel')) {
        return Number(employee.tt_rate) || 0;
      } else {
        return Number(employee.rt_rate) || 0;
      }
    }
    return 0;
  };

  // Helper function to add to breakdown
  const addToBreakdown = (rateType: string, hours: number, revenue: number, cost: number) => {
    const profit = revenue - cost;
    if (rateType.includes('shop') && rateType.includes('overtime')) {
      breakdown.shopOvertime.hours += hours;
      breakdown.shopOvertime.revenue += revenue;
      breakdown.shopOvertime.cost += cost;
      breakdown.shopOvertime.profit += profit;
    } else if (rateType.includes('field') && rateType.includes('overtime')) {
      breakdown.fieldOvertime.hours += hours;
      breakdown.fieldOvertime.revenue += revenue;
      breakdown.fieldOvertime.cost += cost;
      breakdown.fieldOvertime.profit += profit;
    } else if (rateType.includes('field')) {
      breakdown.fieldTime.hours += hours;
      breakdown.fieldTime.revenue += revenue;
      breakdown.fieldTime.cost += cost;
      breakdown.fieldTime.profit += profit;
    } else if (rateType.includes('travel')) {
      breakdown.travelTime.hours += hours;
      breakdown.travelTime.revenue += revenue;
      breakdown.travelTime.cost += cost;
      breakdown.travelTime.profit += profit;
    } else {
      breakdown.shopTime.hours += hours;
      breakdown.shopTime.revenue += revenue;
      breakdown.shopTime.cost += cost;
      breakdown.shopTime.profit += profit;
    }
  };

  // STEP 1: Calculate Internal Time from time entries (payroll hours)
  // Internal time has NO revenue - it's a cost we cannot bill for. Use historical internal_rate.
  entries.forEach(entry => {
    if (!isBillable(entry)) {
      const hours = Number(entry.hours) || 0;
      const rates = employee && rateHistoryMap && rateHistoryMap.size > 0
        ? getRatesForDate(employee, rateHistoryMap, entry.date)
        : employee;
      const internalBase = Number(rates?.internal_rate) || Number(rates?.shop_pay_rate) || 0;
      const payRate = internalBase * burdenMult;
      const cost = hours * payRate;

      breakdown.internalTime.hours += hours;
      breakdown.internalTime.revenue += 0;
      breakdown.internalTime.cost += cost;
      breakdown.internalTime.profit += -cost;
    }
  });

  // STEP 2: Calculate COSTS for billable entries from time entries (payroll hours)
  // Cost is always based on actual hours worked (payroll)
  const payrollCostsByRateType: Record<string, number> = {
    shopTime: 0,
    fieldTime: 0,
    travelTime: 0,
    shopOvertime: 0,
    fieldOvertime: 0,
  };

  entries.forEach(entry => {
    if (isBillable(entry)) {
      const hours = Number(entry.hours) || 0;
      const rateType = (entry.rate_type || 'Shop Time').toLowerCase();
      const payRate = getPayRate(rateType, entry.date);
      const cost = hours * payRate;

      if (rateType.includes('shop') && rateType.includes('overtime')) {
        payrollCostsByRateType.shopOvertime += cost;
      } else if (rateType.includes('field') && rateType.includes('overtime')) {
        payrollCostsByRateType.fieldOvertime += cost;
      } else if (rateType.includes('field')) {
        payrollCostsByRateType.fieldTime += cost;
      } else if (rateType.includes('travel')) {
        payrollCostsByRateType.travelTime += cost;
      } else {
        payrollCostsByRateType.shopTime += cost;
      }
    }
  });

  // STEP 3: Calculate HOURS and REVENUE — one pass per service ticket, entries matched by location + PO/AFE (same as Service Tickets / Profitability).
  console.log('[RateTypeBreakdown] Service tickets received:', serviceTicketHours?.length || 0, 'userId:', userId);

  const billableHoursByRateType: Record<string, number> = {
    shopTime: 0,
    fieldTime: 0,
    travelTime: 0,
    shopOvertime: 0,
    fieldOvertime: 0,
  };

  const isDraftRejectedOrResubmitted = (t: ServiceTicketHours) => {
    const ws = (t.workflow_status || 'draft').toLowerCase();
    if (ws === 'draft' || ws === 'rejected') return true;
    return !!(t.rejected_at != null && t.rejected_at !== '');
  };

  const sharedMapsByProject = buildSharedMapsByProject(entries);

  const addProportionalHours = (matchingEntries: TimeEntry[], sourceHours: number) => {
    const totalEntryHours = matchingEntries.reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
    if (totalEntryHours > 0) {
      matchingEntries.forEach((entry) => {
        const entryHours = Number(entry.hours) || 0;
        const proportion = entryHours / totalEntryHours;
        const proportionalHours = sourceHours * proportion;
        const rateType = (entry.rate_type || 'Shop Time').toLowerCase();
        if (rateType.includes('shop') && rateType.includes('overtime')) {
          billableHoursByRateType.shopOvertime += proportionalHours;
        } else if (rateType.includes('field') && rateType.includes('overtime')) {
          billableHoursByRateType.fieldOvertime += proportionalHours;
        } else if (rateType.includes('field')) {
          billableHoursByRateType.fieldTime += proportionalHours;
        } else if (rateType.includes('travel')) {
          billableHoursByRateType.travelTime += proportionalHours;
        } else {
          billableHoursByRateType.shopTime += proportionalHours;
        }
      });
    } else {
      billableHoursByRateType.shopTime += sourceHours;
    }
  };

  if (serviceTicketHours && serviceTicketHours.length > 0) {
    for (const ticket of serviceTicketHours) {
      if (ticket.user_id !== userId) continue;
      const hasNoSavedHours = Number(ticket.total_hours) === 0 && (!ticket.is_edited || !ticket.edited_hours);
      if (hasNoSavedHours && !isDraftRejectedOrResubmitted(ticket)) continue;

      const matchingEntries = entriesMatchingServiceTicket(entries, ticket, sharedMapsByProject);

      if (ticket.is_edited && ticket.edited_hours) {
        Object.keys(ticket.edited_hours).forEach((rateTypeKey) => {
          const hours = ticket.edited_hours![rateTypeKey];
          let totalHoursForRate = 0;
          if (Array.isArray(hours)) {
            totalHoursForRate = hours.reduce((sum: number, h: number) => sum + (h || 0), 0);
          } else {
            totalHoursForRate = hours as number;
          }
          if (totalHoursForRate > 0) {
            const rateType = rateTypeKey.toLowerCase();
            if (rateType.includes('shop') && rateType.includes('overtime')) {
              billableHoursByRateType.shopOvertime += totalHoursForRate;
            } else if (rateType.includes('field') && rateType.includes('overtime')) {
              billableHoursByRateType.fieldOvertime += totalHoursForRate;
            } else if (rateType.includes('field')) {
              billableHoursByRateType.fieldTime += totalHoursForRate;
            } else if (rateType.includes('travel')) {
              billableHoursByRateType.travelTime += totalHoursForRate;
            } else {
              billableHoursByRateType.shopTime += totalHoursForRate;
            }
          }
        });
        continue;
      }

      const totalTicketHours = Number(ticket.total_hours) || 0;
      const totalEntryHours = matchingEntries.reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
      const effectiveHours =
        totalTicketHours > 0
          ? totalTicketHours
          : isDraftRejectedOrResubmitted(ticket) && totalEntryHours > 0
            ? totalEntryHours
            : 0;

      if (effectiveHours <= 0) continue;

      if (matchingEntries.length > 0 && totalEntryHours > 0) {
        const sourceHours = totalTicketHours > 0 ? totalTicketHours : totalEntryHours;
        addProportionalHours(matchingEntries, sourceHours);
      } else {
        billableHoursByRateType.shopTime += effectiveHours;
      }
    }
  }

  // NOTE: Billable time entries without matching service tickets are NOT counted as billable hours.

  console.log('[RateTypeBreakdown] Final billableHoursByRateType:', billableHoursByRateType);
  console.log('[RateTypeBreakdown] Final payrollCostsByRateType:', payrollCostsByRateType);

  // Now combine: hours from time entries (or edited tickets), revenue calculated from hours × rate, cost from payroll
  // Shop Time
  const shopTimeHours = billableHoursByRateType.shopTime;
  const shopTimeRevenue = shopTimeHours * getBillableRate('shop time');
  breakdown.shopTime.hours = shopTimeHours;
  breakdown.shopTime.revenue = shopTimeRevenue;
  breakdown.shopTime.cost = payrollCostsByRateType.shopTime;
  breakdown.shopTime.profit = shopTimeRevenue - payrollCostsByRateType.shopTime;

  // Field Time
  const fieldTimeHours = billableHoursByRateType.fieldTime;
  const fieldTimeRevenue = fieldTimeHours * getBillableRate('field time');
  breakdown.fieldTime.hours = fieldTimeHours;
  breakdown.fieldTime.revenue = fieldTimeRevenue;
  breakdown.fieldTime.cost = payrollCostsByRateType.fieldTime;
  breakdown.fieldTime.profit = fieldTimeRevenue - payrollCostsByRateType.fieldTime;

  // Travel Time
  const travelTimeHours = billableHoursByRateType.travelTime;
  const travelTimeRevenue = travelTimeHours * getBillableRate('travel time');
  breakdown.travelTime.hours = travelTimeHours;
  breakdown.travelTime.revenue = travelTimeRevenue;
  breakdown.travelTime.cost = payrollCostsByRateType.travelTime;
  breakdown.travelTime.profit = travelTimeRevenue - payrollCostsByRateType.travelTime;

  // Shop Overtime
  const shopOvertimeHours = billableHoursByRateType.shopOvertime;
  const shopOvertimeRevenue = shopOvertimeHours * getBillableRate('shop overtime');
  breakdown.shopOvertime.hours = shopOvertimeHours;
  breakdown.shopOvertime.revenue = shopOvertimeRevenue;
  breakdown.shopOvertime.cost = payrollCostsByRateType.shopOvertime;
  breakdown.shopOvertime.profit = shopOvertimeRevenue - payrollCostsByRateType.shopOvertime;

  // Field Overtime
  const fieldOvertimeHours = billableHoursByRateType.fieldOvertime;
  const fieldOvertimeRevenue = fieldOvertimeHours * getBillableRate('field overtime');
  breakdown.fieldOvertime.hours = fieldOvertimeHours;
  breakdown.fieldOvertime.revenue = fieldOvertimeRevenue;
  breakdown.fieldOvertime.cost = payrollCostsByRateType.fieldOvertime;
  breakdown.fieldOvertime.profit = fieldOvertimeRevenue - payrollCostsByRateType.fieldOvertime;

  return breakdown;
}

// Calculate breakdown by project
// Hours: billable = service ticket hours
// Revenue: total_amount from approved/exported tickets (matching Profitability)
// Expenses: allocated to project via ticket.project_id (billed + reimbursement cost)
export function calculateProjectBreakdown(
  entries: TimeEntry[],
  employee?: EmployeeWithRates,
  serviceTicketHours?: ServiceTicketHours[],
  ticketExpenses?: TicketExpense[],
  includeGst: boolean = true
): ProjectBreakdown[] {
  const projectMap = new Map<string, { billableHours: number; nonBillableHours: number; revenue: number; expenseBilled: number; expenseCost: number }>();
  const userId = entries[0]?.user_id || employee?.user_id || '';

  // Create a map of service ticket hours and revenue by project
  // Revenue: use total_amount for approved/exported tickets (matching Profitability)
  const ticketHoursByProject = new Map<string, number>();
  const ticketRevenueByProject = new Map<string, number>();
  const NON_REVENUE_STATUSES_P = new Set(['draft', 'submitted', 'rejected']);
  const sharedMapsForProjectBreakdown = buildSharedMapsByProject(entries);

  if (serviceTicketHours) {
    serviceTicketHours.forEach(ticket => {
      if (ticket.user_id === userId && ticket.project_id) {
        let ticketHours = 0;
        const isNonRevenue = NON_REVENUE_STATUSES_P.has(ticket.workflow_status || 'draft');
        
        if (ticket.is_edited && ticket.edited_hours) {
          Object.entries(ticket.edited_hours).forEach(([rateType, hours]) => {
            let hoursForRate = 0;
            if (Array.isArray(hours)) {
              hoursForRate = hours.reduce((sum, h) => sum + (h || 0), 0);
            } else {
              hoursForRate = hours as number;
            }
            ticketHours += hoursForRate;
          });
        } else {
          const matchingEntries = entriesMatchingServiceTicket(entries, ticket, sharedMapsForProjectBreakdown);
          const totalEntryHours = matchingEntries.reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
          const isDraftRejectedOrResubmitted = (t: ServiceTicketHours) => {
            const w = (t.workflow_status || 'draft').toLowerCase();
            if (w === 'draft' || w === 'rejected') return true;
            return !!(t.rejected_at != null && t.rejected_at !== '');
          };
          ticketHours = Number(ticket.total_hours) || 0;
          if (ticketHours === 0 && isDraftRejectedOrResubmitted(ticket) && totalEntryHours > 0) ticketHours = totalEntryHours;
        }

        const ticketRevenue = isNonRevenue ? 0 : (Number(ticket.total_amount) || 0);
        
        const existingHours = ticketHoursByProject.get(ticket.project_id) || 0;
        ticketHoursByProject.set(ticket.project_id, existingHours + ticketHours);
        
        const existingRevenue = ticketRevenueByProject.get(ticket.project_id) || 0;
        ticketRevenueByProject.set(ticket.project_id, existingRevenue + ticketRevenue);
      }
    });
  }

  // First pass: sum non-billable hours per project (billable hours come from service tickets only)
  // Skip entries without a project or with Internal rate type - they don't belong in project breakdown
  entries.forEach(entry => {
    if (!entry.project_id || !entry.project) {
      return; // Skip entries without a project
    }
    if (entry.rate_type === 'Internal' || !isBillable(entry)) {
      return; // Skip internal time entries - they don't count toward project totals
    }
    
    const projectId = entry.project_id;
    const rawHours = Number(entry.hours) || 0;

    if (!projectMap.has(projectId)) {
      projectMap.set(projectId, {
        billableHours: 0,
        nonBillableHours: 0,
        revenue: 0,
        expenseBilled: 0,
        expenseCost: 0,
      });
    }

    // Just ensure the project is in the map - billable hours come from service tickets
    projectMap.get(projectId);
  });

  // Allocate expenses to projects (via ticket.project_id)
  if (ticketExpenses) {
    ticketExpenses.forEach(exp => {
      if (exp.service_tickets?.user_id !== userId) return;
      const projectId = exp.service_tickets?.project_id;
      if (!projectId) return;

      const billed = ticketExpenseBilledAmount(exp);
      const expType = (exp.expense_type || '').toLowerCase();
      const desc = (exp.description || '').toLowerCase();

      let reimbRate = 0;
      if (desc.includes('per diem')) {
        reimbRate = Number(employee?.per_diem_reimb_rate) || 1.00;
      } else if (expType === 'travel') {
        reimbRate =
          exp.needs_reimbursement === false
            ? 0
            : Number(employee?.mileage_reimb_rate) || 0.90;
      } else if (expType === 'hotel' || desc.includes('hotel')) {
        reimbRate =
          exp.needs_reimbursement === false
            ? 0
            : Number(employee?.hotel_reimb_rate) || 1.00;
      } else {
        reimbRate = 1.00;
      }

      if (!projectMap.has(projectId)) {
        projectMap.set(projectId, {
          billableHours: 0,
          nonBillableHours: 0,
          revenue: 0,
          expenseBilled: 0,
          expenseCost: 0,
        });
      }
      const data = projectMap.get(projectId)!;
      data.expenseBilled += billed;
      data.expenseCost += ticketExpenseCostForMargin(exp, reimbRate);
    });
  }

  // Second pass: set billable hours from service tickets and calculate revenue (billable only)
  projectMap.forEach((data, projectId) => {
    // Set billable hours from service tickets (only use service ticket hours, not entry hours)
    const ticketHours = ticketHoursByProject.get(projectId) || 0;
    data.billableHours = ticketHours;
    
    // Revenue: billable revenue only (from service tickets)
    const ticketRevenue = ticketRevenueByProject.get(projectId) || 0;
    data.revenue = ticketRevenue;
  });

  // Build project name lookup: from entries first, then from ticketExpenses (service_tickets.projects)
  const projectNameById = new Map<string, string>();
  entries.forEach(e => {
    if (e.project_id && e.project && !projectNameById.has(e.project_id)) {
      const p = e.project as any;
      projectNameById.set(e.project_id, p.project_number ? `${p.project_number} - ${p.name || ''}` : (p.name || '(Unknown Project)'));
    }
  });
  if (ticketExpenses) {
    ticketExpenses.forEach(exp => {
      const tid = exp.service_tickets?.project_id;
      if (tid && !projectNameById.has(tid)) {
        const proj = (exp.service_tickets as any)?.project;
        if (proj) {
          projectNameById.set(tid, proj.project_number ? `${proj.project_number} - ${proj.name || ''}` : (proj.name || '(Unknown Project)'));
        } else {
          projectNameById.set(tid, '(Unknown Project)');
        }
      }
    });
  }

  // Convert to ProjectBreakdown format - include projects with hours or expenses
  // Apply GST to billable amounts when includeGst is true
  const result: ProjectBreakdown[] = Array.from(projectMap.entries())
    .filter(([_, data]) => data.billableHours > 0 || data.nonBillableHours > 0 || data.expenseBilled > 0) // Include projects with activity or expenses
    .map(([projectId, data]) => {
      const projectName = projectNameById.get(projectId) || '(Unknown Project)';
      return {
        projectId,
        projectName,
        hours: data.billableHours,
        revenue: maybeApplyGst(data.revenue, includeGst),
        billableHours: data.billableHours,
        expenseBilled: maybeApplyGst(data.expenseBilled, includeGst),
        expenseCost: data.expenseCost,
      };
    });

  return result.sort((a, b) => b.hours - a.hours);
}

// Calculate breakdown by customer
// Hours: billable = service ticket hours
// Revenue: total_amount from approved/exported tickets (matching Profitability)
export function calculateCustomerBreakdown(entries: TimeEntry[], employee?: EmployeeWithRates, serviceTicketHours?: ServiceTicketHours[], includeGst: boolean = true): CustomerBreakdown[] {
  const customerMap = new Map<string, { billableHours: number; nonBillableHours: number; revenue: number }>();
  const userId = entries[0]?.user_id || '';

  // Create a map of service ticket hours and revenue by customer
  // Revenue: use total_amount for approved/exported tickets (matching Profitability)
  const ticketHoursByCustomer = new Map<string, number>();
  const ticketRevenueByCustomer = new Map<string, number>();
  const NON_REVENUE_STATUSES_C = new Set(['draft', 'submitted', 'rejected']);
  const sharedMapsForCustomerBreakdown = buildSharedMapsByProject(entries);

  if (serviceTicketHours) {
    serviceTicketHours.forEach(ticket => {
      if (ticket.user_id === userId && ticket.customer_id) {
        let ticketHours = 0;
        const isNonRevenue = NON_REVENUE_STATUSES_C.has(ticket.workflow_status || 'draft');
        
        if (ticket.is_edited && ticket.edited_hours) {
          Object.entries(ticket.edited_hours).forEach(([rateType, hours]) => {
            let hoursForRate = 0;
            if (Array.isArray(hours)) {
              hoursForRate = hours.reduce((sum, h) => sum + (h || 0), 0);
            } else {
              hoursForRate = hours as number;
            }
            ticketHours += hoursForRate;
          });
        } else {
          const matchingEntries = entriesMatchingServiceTicket(entries, ticket, sharedMapsForCustomerBreakdown);
          const totalEntryHours = matchingEntries.reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
          const isDraftRejectedOrResubmitted = (t: ServiceTicketHours) => {
            const w = (t.workflow_status || 'draft').toLowerCase();
            if (w === 'draft' || w === 'rejected') return true;
            return !!(t.rejected_at != null && t.rejected_at !== '');
          };
          ticketHours = Number(ticket.total_hours) || 0;
          if (ticketHours === 0 && isDraftRejectedOrResubmitted(ticket) && totalEntryHours > 0) ticketHours = totalEntryHours;
        }

        const ticketRevenue = isNonRevenue ? 0 : (Number(ticket.total_amount) || 0);
        
        const existingHours = ticketHoursByCustomer.get(ticket.customer_id) || 0;
        ticketHoursByCustomer.set(ticket.customer_id, existingHours + ticketHours);
        
        const existingRevenue = ticketRevenueByCustomer.get(ticket.customer_id) || 0;
        ticketRevenueByCustomer.set(ticket.customer_id, existingRevenue + ticketRevenue);
      }
    });
  }

  // First pass: initialize customer map (billable hours come from service tickets only)
  // Skip entries without a customer or with Internal rate type
  entries.forEach(entry => {
    if (!entry.project?.customer?.id) {
      return; // Skip entries without a customer
    }
    if (entry.rate_type === 'Internal' || !isBillable(entry)) {
      return; // Skip internal time entries - they don't count toward customer totals
    }
    
    const customerId = entry.project.customer.id;

    if (!customerMap.has(customerId)) {
      customerMap.set(customerId, {
        billableHours: 0,
        nonBillableHours: 0,
        revenue: 0,
      });
    }

    // Just ensure the customer is in the map - billable hours come from service tickets
    customerMap.get(customerId);
  });

  // Second pass: set billable hours from service tickets and calculate revenue (billable only)
  customerMap.forEach((data, customerId) => {
    // Set billable hours from service tickets (only use service ticket hours, not entry hours)
    const ticketHours = ticketHoursByCustomer.get(customerId) || 0;
    data.billableHours = ticketHours;
    
    // Revenue: billable revenue only (from service tickets)
    const ticketRevenue = ticketRevenueByCustomer.get(customerId) || 0;
    data.revenue = ticketRevenue;
  });

  // Convert to CustomerBreakdown format - only include customers with hours
  // Apply GST to billable revenue when includeGst is true
  const result: CustomerBreakdown[] = Array.from(customerMap.entries())
    .filter(([_, data]) => data.billableHours > 0 || data.nonBillableHours > 0) // Only include customers with activity
    .map(([customerId, data]) => {
      const customerName = entries.find(e => e.project?.customer?.id === customerId)?.project?.customer?.name || '(Unknown Customer)';
      // Hours displayed = billable hours from service tickets only
      return {
        customerId,
        customerName,
        hours: data.billableHours,
        revenue: maybeApplyGst(data.revenue, includeGst),
        billableHours: data.billableHours,
      };
    });

  return result.sort((a, b) => b.hours - a.hours);
}

// Calculate trends over time (daily aggregation)
export function calculateTrends(entries: TimeEntry[], includeGst: boolean = true): TrendData[] {
  const trendMap = new Map<string, TrendData>();

  entries.forEach(entry => {
    const date = entry.date;
    const hours = Number(entry.hours) || 0;
    const rate = Number(entry.rate) || 0;
    // Note: Trends function doesn't have employee context, so internal rate won't be used here
    // This is okay as trends are typically for billable work visualization
    const revenue = isBillable(entry) ? hours * rate : 0;
    const billableHours = isBillable(entry) ? hours : 0;

    if (!trendMap.has(date)) {
      trendMap.set(date, {
        date,
        hours: 0,
        billableHours: 0,
        revenue: 0,
      });
    }

    const trend = trendMap.get(date)!;
    trend.hours += hours;
    trend.billableHours += billableHours;
    trend.revenue += maybeApplyGst(revenue, includeGst);
  });

  return Array.from(trendMap.values()).sort((a, b) => 
    new Date(a.date).getTime() - new Date(b.date).getTime()
  );
}

// Calculate efficiency metrics
export function calculateEfficiency(entries: TimeEntry[]): {
  billableRatio: number;
  averageRate: number;
  hoursPerDay: number;
  revenuePerHour: number;
} {
  if (!entries || entries.length === 0) {
    return {
      billableRatio: 0,
      averageRate: 0,
      hoursPerDay: 0,
      revenuePerHour: 0,
    };
  }

  let totalHours = 0;
  let billableHours = 0;
  let totalRevenue = 0;
  const uniqueDates = new Set<string>();

  entries.forEach(entry => {
    const hours = Number(entry.hours) || 0;
    const rate = Number(entry.rate) || 0;
    totalHours += hours;
    uniqueDates.add(entry.date);
    if (isBillable(entry)) {
      billableHours += hours;
      totalRevenue += hours * rate;
    }
  });

  const workDays = uniqueDates.size || 1;

  return {
    billableRatio: totalHours > 0 ? (billableHours / totalHours) * 100 : 0,
    averageRate: billableHours > 0 ? totalRevenue / billableHours : 0,
    hoursPerDay: totalHours / workDays,
    revenuePerHour: totalHours > 0 ? totalRevenue / totalHours : 0,
  };
}

// Aggregate all employees from a set of entries
export function aggregateAllEmployees(
  entries: TimeEntry[],
  employees: EmployeeWithRates[],
  serviceTicketHours?: ServiceTicketHours[],
  rateHistory?: PayRateHistory[],
  ticketExpenses?: TicketExpense[],
  includeGst: boolean = true
): EmployeeMetrics[] {
  console.log('aggregateAllEmployees called:', { 
    entriesCount: entries?.length || 0, 
    employeesCount: employees?.length || 0 
  });
  
  if (!employees || employees.length === 0) {
    console.log('No employees provided, returning empty array');
    return [];
  }
  
  // If no entries, return all employees with zero metrics
  if (!entries || entries.length === 0) {
    console.log('No entries provided, returning metrics for all employees with zero hours');
    return employees.map(employee => aggregateEmployeeMetrics([], employee, serviceTicketHours || [], rateHistory, ticketExpenses, includeGst));
  }
  
  // Group entries by user_id
  const entriesByUser = new Map<string, TimeEntry[]>();
  
  entries.forEach(entry => {
    const userId = entry.user_id;
    if (!userId) {
      console.warn('Entry missing user_id:', entry.id, entry);
      return;
    }
    if (!entriesByUser.has(userId)) {
      entriesByUser.set(userId, []);
    }
    entriesByUser.get(userId)!.push(entry);
  });

  console.log('Entries grouped by user_id:', Array.from(entriesByUser.keys()));
  console.log('Employee user_ids:', employees.map(e => e.user_id));
  console.log('Sample entry user_id:', entries[0]?.user_id);
  console.log('Sample entry:', entries[0]);

  // Create metrics for each employee
  const employeeMetrics: EmployeeMetrics[] = [];
  
  // Process employees with entries
  entriesByUser.forEach((userEntries, userId) => {
    const employee = employees.find(e => e.user_id === userId);
    console.log(`Processing entries for userId ${userId}, found employee:`, !!employee, 'entries count:', userEntries.length);
    if (employee) {
      // Filter service ticket hours for this user
      const userTicketHours = serviceTicketHours?.filter(t => t.user_id === userId) || [];
      const metrics = aggregateEmployeeMetrics(userEntries, employee, userTicketHours, rateHistory, ticketExpenses, includeGst);
      employeeMetrics.push(metrics);
    } else {
      console.warn(`No employee found for userId ${userId}, but has ${userEntries.length} entries`);
    }
  });

  // Add employees with no entries (with zero metrics)
  employees.forEach(employee => {
    if (!entriesByUser.has(employee.user_id)) {
      console.log(`Adding employee with no entries: ${employee.user_id} (${employee.user?.first_name} ${employee.user?.last_name})`);
      const userTicketHours = serviceTicketHours?.filter(t => t.user_id === employee.user_id) || [];
      employeeMetrics.push(aggregateEmployeeMetrics([], employee, userTicketHours, rateHistory, ticketExpenses, includeGst));
    }
  });

  console.log('Final employee metrics count:', employeeMetrics.length);
  return employeeMetrics.sort((a, b) => b.totalHours - a.totalHours);
}

// Get time period presets
export function getTimePeriodPresets(): { label: string; getValue: () => { startDate: string; endDate: string } }[] {
  return [
    {
      label: 'All-Time',
      getValue: () => {
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        return { startDate: '2020-01-01', endDate: todayStr };
      },
    },
    {
      label: 'Today',
      getValue: () => {
        const today = new Date();
        const dateStr = today.toISOString().split('T')[0];
        return { startDate: dateStr, endDate: dateStr };
      },
    },
    {
      label: 'This Week',
      getValue: () => {
        const today = new Date();
        const day = today.getDay();
        const diff = today.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(today);
        monday.setDate(diff);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        return {
          startDate: monday.toISOString().split('T')[0],
          endDate: sunday.toISOString().split('T')[0],
        };
      },
    },
    {
      label: 'This Month',
      getValue: () => {
        const today = new Date();
        const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
        const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        return {
          startDate: firstDay.toISOString().split('T')[0],
          endDate: lastDay.toISOString().split('T')[0],
        };
      },
    },
    {
      label: 'Last Month',
      getValue: () => {
        const today = new Date();
        const firstDay = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const lastDay = new Date(today.getFullYear(), today.getMonth(), 0);
        return {
          startDate: firstDay.toISOString().split('T')[0],
          endDate: lastDay.toISOString().split('T')[0],
        };
      },
    },
    {
      label: '2 Months Ago',
      getValue: () => {
        const today = new Date();
        const firstDay = new Date(today.getFullYear(), today.getMonth() - 2, 1);
        const lastDay = new Date(today.getFullYear(), today.getMonth() - 1, 0);
        return {
          startDate: firstDay.toISOString().split('T')[0],
          endDate: lastDay.toISOString().split('T')[0],
        };
      },
    },
    {
      label: '3 Months Ago',
      getValue: () => {
        const today = new Date();
        const firstDay = new Date(today.getFullYear(), today.getMonth() - 3, 1);
        const lastDay = new Date(today.getFullYear(), today.getMonth() - 2, 0);
        return {
          startDate: firstDay.toISOString().split('T')[0],
          endDate: lastDay.toISOString().split('T')[0],
        };
      },
    },
    {
      label: 'This Quarter',
      getValue: () => {
        const today = new Date();
        const quarter = Math.floor(today.getMonth() / 3);
        const firstDay = new Date(today.getFullYear(), quarter * 3, 1);
        const lastDay = new Date(today.getFullYear(), quarter * 3 + 3, 0);
        return {
          startDate: firstDay.toISOString().split('T')[0],
          endDate: lastDay.toISOString().split('T')[0],
        };
      },
    },
    {
      label: 'Last Quarter',
      getValue: () => {
        const today = new Date();
        const quarter = Math.floor(today.getMonth() / 3);
        const prevQuarter = quarter === 0 ? 3 : quarter - 1;
        const prevQuarterYear = quarter === 0 ? today.getFullYear() - 1 : today.getFullYear();
        const firstDay = new Date(prevQuarterYear, prevQuarter * 3, 1);
        const lastDay = new Date(prevQuarterYear, prevQuarter * 3 + 3, 0);
        return {
          startDate: firstDay.toISOString().split('T')[0],
          endDate: lastDay.toISOString().split('T')[0],
        };
      },
    },
    {
      label: 'This Year',
      getValue: () => {
        const today = new Date();
        const firstDay = new Date(today.getFullYear(), 0, 1);
        const lastDay = new Date(today.getFullYear(), 11, 31);
        return {
          startDate: firstDay.toISOString().split('T')[0],
          endDate: lastDay.toISOString().split('T')[0],
        };
      },
    },
    {
      label: 'Last Year',
      getValue: () => {
        const today = new Date();
        const firstDay = new Date(today.getFullYear() - 1, 0, 1);
        const lastDay = new Date(today.getFullYear() - 1, 11, 31);
        return {
          startDate: firstDay.toISOString().split('T')[0],
          endDate: lastDay.toISOString().split('T')[0],
        };
      },
    },
    {
      label: 'Custom Range',
      getValue: () => {
        // This will be handled by the component
        const today = new Date();
        const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
        const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        return {
          startDate: firstDay.toISOString().split('T')[0],
          endDate: lastDay.toISOString().split('T')[0],
        };
      },
    },
  ];
}

// Format currency
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

// Format hours
export function formatHours(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}:${m.toString().padStart(2, '0')}`;
}

// Format percentage
export function formatPercentage(value: number): string {
  return `${value.toFixed(1)}%`;
}

