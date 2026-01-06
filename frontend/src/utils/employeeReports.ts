// Employee Reports utility functions for data aggregation and analysis

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
  user?: {
    id: string;
    first_name?: string;
    last_name?: string;
    email?: string;
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
  nonBillableHours: number;
  billableRatio: number;
  totalRevenue: number;
  totalCost: number; // Total internal cost (pay rates * hours)
  netProfit: number; // Revenue - Cost
  profitMargin: number; // (Net Profit / Revenue) * 100
  averageRate: number;
  averageCostPerHour: number; // Average pay rate
  revenuePerHour: number; // Revenue / Total Hours
  profitPerHour: number; // Net Profit / Total Hours
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
  is_edited?: boolean;
  edited_hours?: Record<string, number | number[]>;
}

// Aggregate metrics for a single employee from their time entries
export function aggregateEmployeeMetrics(
  entries: TimeEntry[],
  employee?: EmployeeWithRates,
  serviceTicketHours?: ServiceTicketHours[]
): EmployeeMetrics {
  console.log('aggregateEmployeeMetrics called:', { entriesCount: entries?.length || 0, employee: employee?.user_id });
  
  if (!entries || entries.length === 0) {
    const userId = employee?.user_id || '';
    const employeeName = employee?.user 
      ? `${employee.user.first_name || ''} ${employee.user.last_name || ''}`.trim() || 'Unknown'
      : employee?.user_id || 'Unknown';
    
    console.log('No entries for employee:', { userId, employeeName, employee });
    
    return {
      userId,
      employeeName,
      employeeEmail: employee?.user?.email,
      department: employee?.department,
      position: employee?.position,
      totalHours: 0,
      billableHours: 0,
      nonBillableHours: 0,
      billableRatio: 0,
      totalRevenue: 0,
      totalCost: 0,
      netProfit: 0,
      profitMargin: 0,
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
      projectBreakdown: [],
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
  const rateTypeBreakdown = calculateRateTypeBreakdown(entries, employee, serviceTicketHours);

  // Billable hours should come from service ticket hours (via rateTypeBreakdown), not time entries
  // This ensures billable hours match what's on the service tickets
  billableHours = rateTypeBreakdown.shopTime.hours + 
                  rateTypeBreakdown.fieldTime.hours + 
                  rateTypeBreakdown.travelTime.hours + 
                  rateTypeBreakdown.shopOvertime.hours + 
                  rateTypeBreakdown.fieldOvertime.hours;

  // Revenue is the sum of all billable rate type revenues (hours × rate)
  totalRevenue = rateTypeBreakdown.shopTime.revenue + 
                 rateTypeBreakdown.fieldTime.revenue + 
                 rateTypeBreakdown.travelTime.revenue + 
                 rateTypeBreakdown.shopOvertime.revenue + 
                 rateTypeBreakdown.fieldOvertime.revenue +
                 rateTypeBreakdown.internalTime.revenue;

  // Helper function to round up to nearest 0.10 (for payroll hours calculation)
  const roundToQuarterHourForPayroll = (hours: number): number => {
    return Math.ceil(hours * 10) / 10;
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
    const isInternal = !entry.billable;
    
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
  // 1. Start with actual internal time entries (non-billable work)
  // 2. For each billable rate type, if payroll hours > service ticket hours, 
  //    the difference is unbilled work that moves to non-billable
  // 3. EXCEPTION: If service ticket hours > payroll hours (e.g., 4-hour minimum for 2-hour work),
  //    DON'T deduct from non-billable - this is minimum billing, not actual work transfer
  const internalTimeEntryHours = payrollHoursByRateType.internal;
  
  // Calculate unbilled work for each billable rate type
  // Only add positive differences (work done but not billed)
  // Negative differences (billed more than worked, like minimums) don't affect non-billable
  const unbilledShopTime = Math.max(0, payrollHoursByRateType.shopTime - rateTypeBreakdown.shopTime.hours);
  const unbilledFieldTime = Math.max(0, payrollHoursByRateType.fieldTime - rateTypeBreakdown.fieldTime.hours);
  const unbilledTravelTime = Math.max(0, payrollHoursByRateType.travelTime - rateTypeBreakdown.travelTime.hours);
  const unbilledShopOT = Math.max(0, payrollHoursByRateType.shopOvertime - rateTypeBreakdown.shopOvertime.hours);
  const unbilledFieldOT = Math.max(0, payrollHoursByRateType.fieldOvertime - rateTypeBreakdown.fieldOvertime.hours);
  
  const totalUnbilledWork = unbilledShopTime + unbilledFieldTime + unbilledTravelTime + unbilledShopOT + unbilledFieldOT;
  
  // Non-billable hours = internal time entries + unbilled work from billable rate types
  const nonBillableHours = internalTimeEntryHours + totalUnbilledWork;
  
  console.log('[Non-Billable Calculation]:', {
    internalTimeEntryHours,
    payrollHours: payrollHoursByRateType,
    serviceTicketHours: {
      shopTime: rateTypeBreakdown.shopTime.hours,
      fieldTime: rateTypeBreakdown.fieldTime.hours,
      travelTime: rateTypeBreakdown.travelTime.hours,
      shopOvertime: rateTypeBreakdown.shopOvertime.hours,
      fieldOvertime: rateTypeBreakdown.fieldOvertime.hours,
    },
    unbilled: {
      shopTime: unbilledShopTime,
      fieldTime: unbilledFieldTime,
      travelTime: unbilledTravelTime,
      shopOT: unbilledShopOT,
      fieldOT: unbilledFieldOT,
    },
    totalUnbilledWork,
    nonBillableHours,
  });

  // Update the rate type breakdown to reflect the non-billable hours (for display)
  rateTypeBreakdown.internalTime.hours = nonBillableHours;

  // Total hours = billable + non-billable (for consistency)
  totalHours = billableHours + nonBillableHours;

  // Total hours for ratio calculation should use total payroll hours (sum of all rate types)
  const totalPayrollHours = payrollHoursByRateType.shopTime + 
                            payrollHoursByRateType.fieldTime + 
                            payrollHoursByRateType.travelTime + 
                            payrollHoursByRateType.shopOvertime + 
                            payrollHoursByRateType.fieldOvertime + 
                            payrollHoursByRateType.internal;
  const billableRatio = totalPayrollHours > 0 ? (billableHours / totalPayrollHours) * 100 : 0;
  
  // Calculate total service ticket hours for average rate calculation
  const totalServiceTicketHours = serviceTicketHours && serviceTicketHours.length > 0
    ? serviceTicketHours
        .filter(t => t.user_id === userId)
        .reduce((sum, t) => sum + (Number(t.total_hours) || 0), 0)
    : billableHours; // Fallback to billable hours if no service tickets
  
  const averageRate = totalServiceTicketHours > 0 ? totalRevenue / totalServiceTicketHours : 0;
  const efficiency = billableRatio; // Efficiency is same as billable ratio

  // Calculate service ticket count (unique date+customer combinations for billable entries)
  const ticketKeys = new Set<string>();
  entries.forEach(entry => {
    if (entry.billable && entry.project?.customer) {
      const key = `${entry.date}-${entry.project.customer.id}`;
      ticketKeys.add(key);
    }
  });
  const serviceTicketCount = ticketKeys.size;

  // Helper function to round up to nearest 0.10 (matching Payroll page logic)
  const roundToQuarterHour = (hours: number): number => {
    return Math.ceil(hours * 10) / 10;
  };

  // Calculate total cost based on payroll hours (time entry hours grouped by rate type)
  // Hours are rounded up to nearest 0.10 to match Payroll page
  let totalCost = 0;
  
  // Debug: Log employee pay rates
  if (employee) {
    console.log('Employee pay rates for cost calculation:', {
      userId: employee.user_id,
      employee_id: employee.employee_id,
      shop_pay_rate: employee.shop_pay_rate,
      field_pay_rate: employee.field_pay_rate,
      shop_ot_pay_rate: employee.shop_ot_pay_rate,
      field_ot_pay_rate: employee.field_ot_pay_rate,
      hasPayRates: !!(employee.shop_pay_rate || employee.field_pay_rate || employee.shop_ot_pay_rate || employee.field_ot_pay_rate),
    });
  } else {
    console.warn('No employee object provided for cost calculation, userId:', userId);
  }
  
  // Group hours by rate type (matching Payroll page logic)
  const hoursByRateType = {
    'Shop Time': 0,
    'Shop Overtime': 0,
    'Travel Time': 0,
    'Field Time': 0,
    'Field Overtime': 0,
    'Internal': 0,
  };
  
  entries.forEach(entry => {
    const hours = Number(entry.hours) || 0;
    const rateType = entry.rate_type || 'Shop Time';
    const isInternal = !entry.billable;
    
    // Group hours by rate type (matching Payroll page grouping)
    switch (rateType) {
      case 'Shop Time':
        if (isInternal) {
          hoursByRateType['Internal'] += hours;
    } else {
          hoursByRateType['Shop Time'] += hours;
        }
        break;
      case 'Shop Overtime':
        if (isInternal) {
          hoursByRateType['Internal'] += hours;
        } else {
          hoursByRateType['Shop Overtime'] += hours;
        }
        break;
      case 'Travel Time':
        if (isInternal) {
          hoursByRateType['Internal'] += hours;
        } else {
          hoursByRateType['Travel Time'] += hours;
        }
        break;
      case 'Field Time':
        if (isInternal) {
          hoursByRateType['Internal'] += hours;
        } else {
          hoursByRateType['Field Time'] += hours;
        }
        break;
      case 'Field Overtime':
        if (isInternal) {
          hoursByRateType['Internal'] += hours;
        } else {
          hoursByRateType['Field Overtime'] += hours;
        }
        break;
      default:
        if (isInternal) {
          hoursByRateType['Internal'] += hours;
        } else {
          hoursByRateType['Shop Time'] += hours;
        }
    }
  });
  
  // Calculate cost using payroll hours grouped by rate type
  // Round each rate type's hours UP to nearest 0.10 (matching Payroll page logic)
  const isPanelShop = employee?.department === 'Panel Shop';
  
  // Shop Time cost (rounded)
  if (hoursByRateType['Shop Time'] > 0) {
    const payRate = Number(employee?.shop_pay_rate) || 0;
    const roundedHours = roundToQuarterHour(hoursByRateType['Shop Time']);
    totalCost += roundedHours * payRate;
  }
  
  // Shop Overtime cost (rounded)
  if (hoursByRateType['Shop Overtime'] > 0) {
    const payRate = isPanelShop 
      ? (Number(employee?.shop_ot_pay_rate) || Number(employee?.shop_pay_rate) || 0)
      : (Number(employee?.shop_ot_pay_rate) || 0);
    const roundedHours = roundToQuarterHour(hoursByRateType['Shop Overtime']);
    totalCost += roundedHours * payRate;
  }
  
  // Travel Time cost (rounded, paid at shop rate)
  if (hoursByRateType['Travel Time'] > 0) {
    const payRate = Number(employee?.shop_pay_rate) || 0;
    const roundedHours = roundToQuarterHour(hoursByRateType['Travel Time']);
    totalCost += roundedHours * payRate;
  }
  
  // Field Time cost (rounded)
  if (hoursByRateType['Field Time'] > 0) {
    const payRate = isPanelShop
      ? (Number(employee?.field_pay_rate) || Number(employee?.shop_pay_rate) || 0)
      : (Number(employee?.field_pay_rate) || 0);
    const roundedHours = roundToQuarterHour(hoursByRateType['Field Time']);
    totalCost += roundedHours * payRate;
  }
  
  // Field Overtime cost (rounded)
  if (hoursByRateType['Field Overtime'] > 0) {
    const payRate = isPanelShop
      ? (Number(employee?.field_ot_pay_rate) || Number(employee?.shop_pay_rate) || 0)
      : (Number(employee?.field_ot_pay_rate) || 0);
    const roundedHours = roundToQuarterHour(hoursByRateType['Field Overtime']);
    totalCost += roundedHours * payRate;
  }
  
  // Internal time cost (rounded, paid at shop rate)
  if (hoursByRateType['Internal'] > 0) {
    const payRate = Number(employee?.shop_pay_rate) || 0;
    const roundedHours = roundToQuarterHour(hoursByRateType['Internal']);
    totalCost += roundedHours * payRate;
  }
  
  console.log('Final totalCost (using rounded payroll hours):', totalCost, 'for userId:', userId, 'hoursByRateType:', hoursByRateType);

  // Calculate profit metrics
  const netProfit = totalRevenue - totalCost;
  const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;
  const averageCostPerHour = totalHours > 0 ? totalCost / totalHours : 0;
  const revenuePerHour = totalHours > 0 ? totalRevenue / totalHours : 0;
  const profitPerHour = totalHours > 0 ? netProfit / totalHours : 0;

  // Project breakdown
  const projectBreakdown = calculateProjectBreakdown(entries, employee, serviceTicketHours);

  // Customer breakdown
  const customerBreakdown = calculateCustomerBreakdown(entries, employee, serviceTicketHours);

  // Trends
  const trends = calculateTrends(entries);

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
    nonBillableHours,
    billableRatio,
    totalRevenue,
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
  serviceTicketHours?: ServiceTicketHours[]
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

  // Helper function to get pay rate for a rate type
  const getPayRate = (rateType: string): number => {
    if (isPanelShop) {
    if (rateType.includes('shop') && rateType.includes('overtime')) {
        return employee?.shop_ot_pay_rate || employee?.shop_pay_rate || 0;
    } else if (rateType.includes('field') && rateType.includes('overtime')) {
        return employee?.field_ot_pay_rate || employee?.shop_pay_rate || 0;
    } else if (rateType.includes('field')) {
        return employee?.field_pay_rate || employee?.shop_pay_rate || 0;
    } else if (rateType.includes('travel')) {
        return employee?.shop_pay_rate || 0;
    } else {
        return employee?.shop_pay_rate || 0;
      }
    } else if (rateType.includes('shop') && rateType.includes('overtime')) {
      return employee?.shop_ot_pay_rate || 0;
    } else if (rateType.includes('field') && rateType.includes('overtime')) {
      return employee?.field_ot_pay_rate || 0;
    } else if (rateType.includes('field')) {
      return employee?.field_pay_rate || 0;
    } else if (rateType.includes('travel')) {
      return employee?.shop_pay_rate || 0;
    } else {
      return employee?.shop_pay_rate || 0;
    }
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
  // Internal time uses payroll hours for both hours and cost
  entries.forEach(entry => {
    if (!entry.billable) {
      const hours = Number(entry.hours) || 0;
      const internalRate = Number(employee?.internal_rate) || 0;
      const revenue = hours * internalRate;
      const rateType = (entry.rate_type || 'Shop Time').toLowerCase();
      const payRate = getPayRate(rateType);
      const cost = hours * payRate;
      const profit = revenue - cost;

      breakdown.internalTime.hours += hours;
      breakdown.internalTime.revenue += revenue;
      breakdown.internalTime.cost += cost;
      breakdown.internalTime.profit += profit;
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
    if (entry.billable) {
      const hours = Number(entry.hours) || 0;
      const rateType = (entry.rate_type || 'Shop Time').toLowerCase();
      const payRate = getPayRate(rateType);
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

  // STEP 3: Calculate HOURS and REVENUE from service tickets
  // Hours displayed and revenue are based on service ticket hours
  console.log('[RateTypeBreakdown] Service tickets received:', serviceTicketHours?.length || 0, 'userId:', userId);
  
  if (serviceTicketHours && serviceTicketHours.length > 0) {
    // Track service ticket hours by rate type for revenue calculation
    const serviceHoursByRateType: Record<string, number> = {
      shopTime: 0,
      fieldTime: 0,
      travelTime: 0,
      shopOvertime: 0,
      fieldOvertime: 0,
    };

    // Deduplicate service tickets by date + user_id + customer_id
    // Multiple records can exist for the same ticket (e.g., from multiple exports)
    // We only want to count each unique ticket once
    const uniqueTicketMap = new Map<string, typeof serviceTicketHours[0]>();
    serviceTicketHours.forEach(ticket => {
      const key = `${ticket.date}-${ticket.user_id}-${ticket.customer_id || 'unassigned'}`;
      // Keep the one with is_edited=true if available, otherwise keep the first one
      const existing = uniqueTicketMap.get(key);
      if (!existing || (ticket.is_edited && !existing.is_edited)) {
        uniqueTicketMap.set(key, ticket);
      }
    });
    const dedupedTickets = Array.from(uniqueTicketMap.values());
    
    console.log('[RateTypeBreakdown] After deduplication:', dedupedTickets.length, 'unique tickets (was', serviceTicketHours.length, ')');

    // Process each service ticket
    dedupedTickets.forEach((ticket, index) => {
      console.log(`[RateTypeBreakdown] Processing ticket ${index + 1}/${dedupedTickets.length}:`, {
        id: ticket.id,
        ticket_user_id: ticket.user_id,
        userId,
        total_hours: ticket.total_hours,
        is_edited: ticket.is_edited,
        edited_hours: ticket.edited_hours,
        date: ticket.date
      });
      
      if (ticket.user_id !== userId) {
        console.log('[RateTypeBreakdown] Skipping ticket - user_id mismatch');
        return;
      }
      
      // If ticket has been edited, use edited_hours directly
      if (ticket.is_edited && ticket.edited_hours) {
        console.log('[RateTypeBreakdown] Using edited_hours:', ticket.edited_hours);
        const editedHours = ticket.edited_hours;
        
        // Process each rate type from edited hours
        Object.keys(editedHours).forEach(rateTypeKey => {
          const hours = editedHours[rateTypeKey];
          let totalHoursForRate = 0;
          
          // Sum hours if it's an array, otherwise use the number directly
          if (Array.isArray(hours)) {
            totalHoursForRate = hours.reduce((sum: number, h: number) => sum + (h || 0), 0);
          } else {
            totalHoursForRate = hours as number;
          }
          
          console.log(`[RateTypeBreakdown] Rate type "${rateTypeKey}" has totalHoursForRate: ${totalHoursForRate}`);
          
          if (totalHoursForRate > 0) {
            const rateType = rateTypeKey.toLowerCase();
            
            if (rateType.includes('shop') && rateType.includes('overtime')) {
              serviceHoursByRateType.shopOvertime += totalHoursForRate;
            } else if (rateType.includes('field') && rateType.includes('overtime')) {
              serviceHoursByRateType.fieldOvertime += totalHoursForRate;
            } else if (rateType.includes('field')) {
              serviceHoursByRateType.fieldTime += totalHoursForRate;
            } else if (rateType.includes('travel')) {
              serviceHoursByRateType.travelTime += totalHoursForRate;
            } else {
              serviceHoursByRateType.shopTime += totalHoursForRate;
            }
          }
        });
        console.log('[RateTypeBreakdown] After this ticket, serviceHoursByRateType:', { ...serviceHoursByRateType });
      } else {
        // Ticket not edited - use service ticket total_hours and distribute by rate type from matching entries
        console.log('[RateTypeBreakdown] Ticket not edited, using total_hours:', ticket.total_hours);
        const ticketDate = ticket.date;
        const ticketHours = Number(ticket.total_hours) || 0;
        
        // Find matching billable time entries for this ticket to determine rate type distribution
        const matchingEntries = entries.filter(entry => {
          if (entry.date !== ticketDate) return false;
          if (!entry.billable) return false;
          if (ticket.customer_id && entry.project?.customer?.id !== ticket.customer_id) return false;
          if (ticket.project_id && entry.project_id !== ticket.project_id) return false;
          return true;
        });

        console.log('[RateTypeBreakdown] Matching entries for ticket:', matchingEntries.length, 'ticketHours:', ticketHours);

        if (matchingEntries.length > 0 && ticketHours > 0) {
          // Calculate total hours from matching entries to get proportions
          const totalEntryHours = matchingEntries.reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
          console.log('[RateTypeBreakdown] totalEntryHours from matching entries:', totalEntryHours);
          
          if (totalEntryHours > 0) {
            // Distribute ticket hours proportionally by rate type from entries
            matchingEntries.forEach(entry => {
              const entryHours = Number(entry.hours) || 0;
              const proportion = entryHours / totalEntryHours;
              const ticketHoursForThisRate = ticketHours * proportion;
              const rateType = (entry.rate_type || 'Shop Time').toLowerCase();
              console.log('[RateTypeBreakdown] Entry proportion:', { entryHours, proportion, ticketHoursForThisRate, rateType });

              if (rateType.includes('shop') && rateType.includes('overtime')) {
                serviceHoursByRateType.shopOvertime += ticketHoursForThisRate;
              } else if (rateType.includes('field') && rateType.includes('overtime')) {
                serviceHoursByRateType.fieldOvertime += ticketHoursForThisRate;
              } else if (rateType.includes('field')) {
                serviceHoursByRateType.fieldTime += ticketHoursForThisRate;
              } else if (rateType.includes('travel')) {
                serviceHoursByRateType.travelTime += ticketHoursForThisRate;
              } else {
                serviceHoursByRateType.shopTime += ticketHoursForThisRate;
              }
            });
          }
        } else if (ticketHours > 0) {
          // No matching entries but ticket has hours - default to shop time
          serviceHoursByRateType.shopTime += ticketHours;
        }
      }
    });

    console.log('[RateTypeBreakdown] Final serviceHoursByRateType:', serviceHoursByRateType);
    console.log('[RateTypeBreakdown] Final payrollCostsByRateType:', payrollCostsByRateType);

    // Now combine: hours and revenue from service tickets, cost from payroll
    // Shop Time
    const shopTimeHours = serviceHoursByRateType.shopTime;
    const shopTimeRevenue = shopTimeHours * getBillableRate('shop time');
    breakdown.shopTime.hours = shopTimeHours;
    breakdown.shopTime.revenue = shopTimeRevenue;
    breakdown.shopTime.cost = payrollCostsByRateType.shopTime;
    breakdown.shopTime.profit = shopTimeRevenue - payrollCostsByRateType.shopTime;

    // Field Time
    const fieldTimeHours = serviceHoursByRateType.fieldTime;
    const fieldTimeRevenue = fieldTimeHours * getBillableRate('field time');
    breakdown.fieldTime.hours = fieldTimeHours;
    breakdown.fieldTime.revenue = fieldTimeRevenue;
    breakdown.fieldTime.cost = payrollCostsByRateType.fieldTime;
    breakdown.fieldTime.profit = fieldTimeRevenue - payrollCostsByRateType.fieldTime;

    // Travel Time
    const travelTimeHours = serviceHoursByRateType.travelTime;
    const travelTimeRevenue = travelTimeHours * getBillableRate('travel time');
    breakdown.travelTime.hours = travelTimeHours;
    breakdown.travelTime.revenue = travelTimeRevenue;
    breakdown.travelTime.cost = payrollCostsByRateType.travelTime;
    breakdown.travelTime.profit = travelTimeRevenue - payrollCostsByRateType.travelTime;

    // Shop Overtime
    const shopOvertimeHours = serviceHoursByRateType.shopOvertime;
    const shopOvertimeRevenue = shopOvertimeHours * getBillableRate('shop overtime');
    breakdown.shopOvertime.hours = shopOvertimeHours;
    breakdown.shopOvertime.revenue = shopOvertimeRevenue;
    breakdown.shopOvertime.cost = payrollCostsByRateType.shopOvertime;
    breakdown.shopOvertime.profit = shopOvertimeRevenue - payrollCostsByRateType.shopOvertime;

    // Field Overtime
    const fieldOvertimeHours = serviceHoursByRateType.fieldOvertime;
    const fieldOvertimeRevenue = fieldOvertimeHours * getBillableRate('field overtime');
    breakdown.fieldOvertime.hours = fieldOvertimeHours;
    breakdown.fieldOvertime.revenue = fieldOvertimeRevenue;
    breakdown.fieldOvertime.cost = payrollCostsByRateType.fieldOvertime;
    breakdown.fieldOvertime.profit = fieldOvertimeRevenue - payrollCostsByRateType.fieldOvertime;

  } else {
    // Fallback to time entry hours if no service tickets exist (for billable entries only)
    // In this case, both hours/revenue AND cost come from time entries
    entries.forEach(entry => {
      if (entry.billable) {
        const hours = Number(entry.hours) || 0;
        const rateType = (entry.rate_type || 'Shop Time').toLowerCase();
        const billableRate = getBillableRate(rateType) || Number(entry.rate) || 0;
        const revenue = hours * billableRate;
        const payRate = getPayRate(rateType);
        const cost = hours * payRate;

        addToBreakdown(rateType, hours, revenue, cost);
      }
    });
  }

  return breakdown;
}

// Calculate breakdown by project
// Hours: billable = service ticket hours, non-billable = payroll hours (rounded)
// Total = billable + non-billable
// Revenue = billable hours × rate (calculated, not from total_amount)
export function calculateProjectBreakdown(entries: TimeEntry[], employee?: EmployeeWithRates, serviceTicketHours?: ServiceTicketHours[]): ProjectBreakdown[] {
  const projectMap = new Map<string, { billableHours: number; nonBillableHours: number; revenue: number }>();
  const roundToQuarterHour = (hours: number): number => Math.ceil(hours * 10) / 10;
  const userId = entries[0]?.user_id || '';

  // Helper function to get billable rate for a rate type
  const getBillableRate = (rateType: string): number => {
    if (employee) {
      const rt = rateType.toLowerCase();
      if (rt.includes('shop') && rt.includes('overtime')) {
        return Number(employee.shop_ot_rate) || 0;
      } else if (rt.includes('field') && rt.includes('overtime')) {
        return Number(employee.field_ot_rate) || 0;
      } else if (rt.includes('field')) {
        return Number(employee.ft_rate) || 0;
      } else if (rt.includes('travel')) {
        return Number(employee.tt_rate) || 0;
      } else {
        return Number(employee.rt_rate) || 0;
      }
    }
    return 0;
  };

  // Create a map of service ticket hours by project, broken down by rate type
  // Use edited_hours if available, otherwise use total_hours and distribute by entry rate types
  const ticketHoursByProject = new Map<string, number>();
  const ticketRevenueByProject = new Map<string, number>();
  
  if (serviceTicketHours) {
    serviceTicketHours.forEach(ticket => {
      if (ticket.user_id === userId && ticket.project_id) {
        let ticketHours = 0;
        let ticketRevenue = 0;
        
        // If ticket has been edited, sum the edited_hours and calculate revenue per rate type
        if (ticket.is_edited && ticket.edited_hours) {
          Object.entries(ticket.edited_hours).forEach(([rateType, hours]) => {
            let hoursForRate = 0;
            if (Array.isArray(hours)) {
              hoursForRate = hours.reduce((sum, h) => sum + (h || 0), 0);
            } else {
              hoursForRate = hours as number;
            }
            ticketHours += hoursForRate;
            // Calculate revenue as hours × rate for this rate type
            ticketRevenue += hoursForRate * getBillableRate(rateType);
          });
        } else {
          // Use total_hours if not edited - need to find rate type from matching entries
          ticketHours = Number(ticket.total_hours) || 0;
          // Find matching entries to determine rate type distribution
          const matchingEntries = entries.filter(e => 
            e.billable && 
            e.project_id === ticket.project_id && 
            e.date === ticket.date
          );
          const totalEntryHours = matchingEntries.reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
          
          if (totalEntryHours > 0) {
            matchingEntries.forEach(entry => {
              const proportion = (Number(entry.hours) || 0) / totalEntryHours;
              const proportionalHours = ticketHours * proportion;
              const rateType = entry.rate_type || 'Shop Time';
              ticketRevenue += proportionalHours * getBillableRate(rateType);
            });
          } else {
            // Default to shop rate if no matching entries
            ticketRevenue = ticketHours * getBillableRate('Shop Time');
          }
        }
        
        const existingHours = ticketHoursByProject.get(ticket.project_id) || 0;
        ticketHoursByProject.set(ticket.project_id, existingHours + ticketHours);
        
        const existingRevenue = ticketRevenueByProject.get(ticket.project_id) || 0;
        ticketRevenueByProject.set(ticket.project_id, existingRevenue + ticketRevenue);
      }
    });
  }

  // First pass: sum non-billable hours per project (billable hours come from service tickets only)
  entries.forEach(entry => {
    const projectId = entry.project_id || 'no-project';
    const rawHours = Number(entry.hours) || 0;

    if (!projectMap.has(projectId)) {
      projectMap.set(projectId, {
        billableHours: 0,
        nonBillableHours: 0,
        revenue: 0,
      });
    }

    const project = projectMap.get(projectId)!;
    
    if (!entry.billable) {
      // For non-billable entries, sum actual hours (will be rounded later)
      project.nonBillableHours += rawHours;
    }
    // Billable hours are NOT added from entries - they come from service tickets only
  });

  // Second pass: set billable hours from service tickets, round non-billable, and calculate revenue
  projectMap.forEach((data, projectId) => {
    // Set billable hours from service tickets (only use service ticket hours, not entry hours)
    const ticketHours = ticketHoursByProject.get(projectId) || 0;
    data.billableHours = ticketHours;
    
    // Round non-billable hours
    data.nonBillableHours = roundToQuarterHour(data.nonBillableHours);
    
    // Revenue: billable revenue = hours × rate (from service tickets), non-billable = hours × internal rate
    const ticketRevenue = ticketRevenueByProject.get(projectId) || 0;
    const internalRate = Number(employee?.internal_rate) || 0;
    
    // Billable revenue comes from calculated hours × rate
    // Non-billable revenue is calculated from rounded hours × internal rate
    data.revenue = ticketRevenue + (data.nonBillableHours * internalRate);
  });

  // Convert to ProjectBreakdown format
  const result: ProjectBreakdown[] = Array.from(projectMap.entries()).map(([projectId, data]) => {
    const projectName = entries.find(e => (e.project_id || 'no-project') === projectId)?.project?.name || '(No Project)';
    // Hours displayed = billable hours from service tickets only
    return {
      projectId,
      projectName,
      hours: data.billableHours,
      revenue: data.revenue,
      billableHours: data.billableHours,
    };
  });

  return result.sort((a, b) => b.hours - a.hours);
}

// Calculate breakdown by customer
// Hours: billable = service ticket hours, non-billable = payroll hours (rounded)
// Total = billable + non-billable
// Revenue = billable hours × rate (calculated, not from total_amount)
export function calculateCustomerBreakdown(entries: TimeEntry[], employee?: EmployeeWithRates, serviceTicketHours?: ServiceTicketHours[]): CustomerBreakdown[] {
  const customerMap = new Map<string, { billableHours: number; nonBillableHours: number; revenue: number }>();
  const roundToQuarterHour = (hours: number): number => Math.ceil(hours * 10) / 10;
  const userId = entries[0]?.user_id || '';

  // Helper function to get billable rate for a rate type
  const getBillableRate = (rateType: string): number => {
    if (employee) {
      const rt = rateType.toLowerCase();
      if (rt.includes('shop') && rt.includes('overtime')) {
        return Number(employee.shop_ot_rate) || 0;
      } else if (rt.includes('field') && rt.includes('overtime')) {
        return Number(employee.field_ot_rate) || 0;
      } else if (rt.includes('field')) {
        return Number(employee.ft_rate) || 0;
      } else if (rt.includes('travel')) {
        return Number(employee.tt_rate) || 0;
      } else {
        return Number(employee.rt_rate) || 0;
      }
    }
    return 0;
  };

  // Create a map of service ticket hours by customer, calculating revenue from hours × rate
  const ticketHoursByCustomer = new Map<string, number>();
  const ticketRevenueByCustomer = new Map<string, number>();
  
  if (serviceTicketHours) {
    serviceTicketHours.forEach(ticket => {
      if (ticket.user_id === userId && ticket.customer_id) {
        let ticketHours = 0;
        let ticketRevenue = 0;
        
        // If ticket has been edited, sum the edited_hours and calculate revenue per rate type
        if (ticket.is_edited && ticket.edited_hours) {
          Object.entries(ticket.edited_hours).forEach(([rateType, hours]) => {
            let hoursForRate = 0;
            if (Array.isArray(hours)) {
              hoursForRate = hours.reduce((sum, h) => sum + (h || 0), 0);
            } else {
              hoursForRate = hours as number;
            }
            ticketHours += hoursForRate;
            // Calculate revenue as hours × rate for this rate type
            ticketRevenue += hoursForRate * getBillableRate(rateType);
          });
        } else {
          // Use total_hours if not edited - need to find rate type from matching entries
          ticketHours = Number(ticket.total_hours) || 0;
          // Find matching entries to determine rate type distribution
          const matchingEntries = entries.filter(e => 
            e.billable && 
            e.project?.customer?.id === ticket.customer_id && 
            e.date === ticket.date
          );
          const totalEntryHours = matchingEntries.reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
          
          if (totalEntryHours > 0) {
            matchingEntries.forEach(entry => {
              const proportion = (Number(entry.hours) || 0) / totalEntryHours;
              const proportionalHours = ticketHours * proportion;
              const rateType = entry.rate_type || 'Shop Time';
              ticketRevenue += proportionalHours * getBillableRate(rateType);
            });
          } else {
            // Default to shop rate if no matching entries
            ticketRevenue = ticketHours * getBillableRate('Shop Time');
          }
        }
        
        const existingHours = ticketHoursByCustomer.get(ticket.customer_id) || 0;
        ticketHoursByCustomer.set(ticket.customer_id, existingHours + ticketHours);
        
        const existingRevenue = ticketRevenueByCustomer.get(ticket.customer_id) || 0;
        ticketRevenueByCustomer.set(ticket.customer_id, existingRevenue + ticketRevenue);
      }
    });
  }

  // First pass: sum non-billable hours per customer (billable hours come from service tickets only)
  entries.forEach(entry => {
    const customerId = entry.project?.customer?.id || 'no-customer';
    const rawHours = Number(entry.hours) || 0;

    if (!customerMap.has(customerId)) {
      customerMap.set(customerId, {
        billableHours: 0,
        nonBillableHours: 0,
        revenue: 0,
      });
    }

    const customer = customerMap.get(customerId)!;
    
    if (!entry.billable) {
      // For non-billable entries, sum actual hours (will be rounded later)
      customer.nonBillableHours += rawHours;
    }
    // Billable hours are NOT added from entries - they come from service tickets only
  });

  // Second pass: set billable hours from service tickets, round non-billable, and calculate revenue
  customerMap.forEach((data, customerId) => {
    // Set billable hours from service tickets (only use service ticket hours, not entry hours)
    const ticketHours = ticketHoursByCustomer.get(customerId) || 0;
    data.billableHours = ticketHours;
    
    // Round non-billable hours
    data.nonBillableHours = roundToQuarterHour(data.nonBillableHours);
    
    // Revenue: billable revenue = hours × rate (from service tickets), non-billable = hours × internal rate
    const ticketRevenue = ticketRevenueByCustomer.get(customerId) || 0;
    const internalRate = Number(employee?.internal_rate) || 0;
    
    // Billable revenue comes from calculated hours × rate
    // Non-billable revenue is calculated from rounded hours × internal rate
    data.revenue = ticketRevenue + (data.nonBillableHours * internalRate);
  });

  // Convert to CustomerBreakdown format
  const result: CustomerBreakdown[] = Array.from(customerMap.entries()).map(([customerId, data]) => {
    const customerName = entries.find(e => (e.project?.customer?.id || 'no-customer') === customerId)?.project?.customer?.name || '(No Customer)';
    // Hours displayed = billable hours from service tickets only
    return {
      customerId,
      customerName,
      hours: data.billableHours,
      revenue: data.revenue,
      billableHours: data.billableHours,
    };
  });

  return result.sort((a, b) => b.hours - a.hours);
}

// Calculate trends over time (daily aggregation)
export function calculateTrends(entries: TimeEntry[]): TrendData[] {
  const trendMap = new Map<string, TrendData>();

  entries.forEach(entry => {
    const date = entry.date;
    const hours = Number(entry.hours) || 0;
    const rate = Number(entry.rate) || 0;
    // Note: Trends function doesn't have employee context, so internal rate won't be used here
    // This is okay as trends are typically for billable work visualization
    const revenue = entry.billable ? hours * rate : 0;
    const billableHours = entry.billable ? hours : 0;

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
    trend.revenue += revenue;
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
    if (entry.billable) {
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
  serviceTicketHours?: ServiceTicketHours[]
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
    return employees.map(employee => aggregateEmployeeMetrics([], employee, serviceTicketHours || []));
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
      const metrics = aggregateEmployeeMetrics(userEntries, employee, userTicketHours);
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
      employeeMetrics.push(aggregateEmployeeMetrics([], employee, userTicketHours));
    }
  });

  console.log('Final employee metrics count:', employeeMetrics.length);
  return employeeMetrics.sort((a, b) => b.totalHours - a.totalHours);
}

// Get time period presets
export function getTimePeriodPresets(): { label: string; getValue: () => { startDate: string; endDate: string } }[] {
  return [
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

