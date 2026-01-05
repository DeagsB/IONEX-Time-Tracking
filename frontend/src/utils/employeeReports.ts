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

// Aggregate metrics for a single employee from their time entries
export function aggregateEmployeeMetrics(
  entries: TimeEntry[],
  employee?: EmployeeWithRates
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
  let totalHours = 0;
  let billableHours = 0;
  let totalRevenue = 0;

  entries.forEach(entry => {
    const hours = Number(entry.hours) || 0;
    totalHours += hours;
    
    if (entry.billable) {
      billableHours += hours;
      // For billable entries, use employee's billable rates based on rate_type
      const rateType = (entry.rate_type || 'Shop Time').toLowerCase();
      let billableRate = 0;
      
      if (employee) {
        if (rateType.includes('shop') && rateType.includes('overtime')) {
          billableRate = Number(employee.shop_ot_rate) || 0;
        } else if (rateType.includes('field') && rateType.includes('overtime')) {
          billableRate = Number(employee.field_ot_rate) || 0;
        } else if (rateType.includes('field')) {
          billableRate = Number(employee.ft_rate) || 0;
        } else if (rateType.includes('travel')) {
          billableRate = Number(employee.tt_rate) || 0;
        } else {
          // Default to shop time rate (rt_rate)
          billableRate = Number(employee.rt_rate) || 0;
        }
      }
      
      // Fallback to entry.rate if employee rates are not available
      if (billableRate === 0) {
        billableRate = Number(entry.rate) || 0;
      }
      
      totalRevenue += hours * billableRate;
    } else {
      // Use internal rate for non-billable entries
      const internalRate = Number(employee?.internal_rate) || 0;
      totalRevenue += hours * internalRate;
    }
  });

  const nonBillableHours = totalHours - billableHours;
  const billableRatio = totalHours > 0 ? (billableHours / totalHours) * 100 : 0;
  const averageRate = billableHours > 0 ? totalRevenue / billableHours : 0;
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

  // Rate type breakdown (includes cost and profit calculations)
  const rateTypeBreakdown = calculateRateTypeBreakdown(entries, employee);

  // Calculate total cost based on pay rates
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
  
  entries.forEach(entry => {
    const hours = Number(entry.hours) || 0;
    const rateType = (entry.rate_type || 'Shop Time').toLowerCase();
    
    // Determine pay rate based on rate type
    // Panel Shop employees use shop_pay_rate for all rate types
    const isPanelShop = employee?.department === 'Panel Shop';
    let payRate = 0;
    if (isPanelShop) {
      payRate = Number(employee?.shop_pay_rate) || 0;
    } else if (rateType.includes('shop') && rateType.includes('overtime')) {
      payRate = Number(employee?.shop_ot_pay_rate) || 0;
    } else if (rateType.includes('field') && rateType.includes('overtime')) {
      payRate = Number(employee?.field_ot_pay_rate) || 0;
    } else if (rateType.includes('field')) {
      payRate = Number(employee?.field_pay_rate) || 0;
    } else if (rateType.includes('travel')) {
      // Travel time is paid at shop rate
      payRate = Number(employee?.shop_pay_rate) || 0;
    } else {
      // Default to shop time
      payRate = Number(employee?.shop_pay_rate) || 0;
    }
    
    const entryCost = hours * payRate;
    totalCost += entryCost;
    
    // Debug: Log cost calculation for first entry
    if (totalCost === entryCost) {
      console.log('First entry cost calculation:', {
        rateType: entry.rate_type,
        rateTypeLower: rateType,
        hours,
        payRate,
        entryCost,
        totalCost,
      });
    }
  });
  
  console.log('Final totalCost:', totalCost, 'for userId:', userId, 'entries count:', entries.length);

  // Calculate profit metrics
  const netProfit = totalRevenue - totalCost;
  const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;
  const averageCostPerHour = totalHours > 0 ? totalCost / totalHours : 0;
  const revenuePerHour = totalHours > 0 ? totalRevenue / totalHours : 0;
  const profitPerHour = totalHours > 0 ? netProfit / totalHours : 0;

  // Project breakdown
  const projectBreakdown = calculateProjectBreakdown(entries, employee);

  // Customer breakdown
  const customerBreakdown = calculateCustomerBreakdown(entries, employee);

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
  employee?: EmployeeWithRates
): RateTypeBreakdown {
  const breakdown: RateTypeBreakdown = {
    internalTime: { hours: 0, revenue: 0, cost: 0, profit: 0 },
    shopTime: { hours: 0, revenue: 0, cost: 0, profit: 0 },
    fieldTime: { hours: 0, revenue: 0, cost: 0, profit: 0 },
    travelTime: { hours: 0, revenue: 0, cost: 0, profit: 0 },
    shopOvertime: { hours: 0, revenue: 0, cost: 0, profit: 0 },
    fieldOvertime: { hours: 0, revenue: 0, cost: 0, profit: 0 },
  };

  entries.forEach(entry => {
    const hours = Number(entry.hours) || 0;
    const rate = Number(entry.rate) || 0;
    // Use internal rate for non-billable entries, otherwise use the entry rate
    const internalRate = Number(employee?.internal_rate) || 0;
    const revenue = entry.billable ? hours * rate : hours * internalRate;
    const rateType = (entry.rate_type || 'Shop Time').toLowerCase();
    const isInternal = !entry.billable;

    // Determine pay rate based on rate type
    // Panel Shop employees use shop_pay_rate for all rate types
    const isPanelShop = employee?.department === 'Panel Shop';
    let payRate = 0;
    if (isPanelShop) {
      payRate = employee?.shop_pay_rate || 0;
    } else if (rateType.includes('shop') && rateType.includes('overtime')) {
      payRate = employee?.shop_ot_pay_rate || 0;
    } else if (rateType.includes('field') && rateType.includes('overtime')) {
      payRate = employee?.field_ot_pay_rate || 0;
    } else if (rateType.includes('field')) {
      payRate = employee?.field_pay_rate || 0;
    } else if (rateType.includes('travel')) {
      // Travel time is paid at shop rate
      payRate = employee?.shop_pay_rate || 0;
    } else {
      // Default to shop time
      payRate = employee?.shop_pay_rate || 0;
    }

    const cost = hours * payRate;
    const profit = revenue - cost;

    // If internal (non-billable), add to internalTime breakdown
    if (isInternal) {
      breakdown.internalTime.hours += hours;
      breakdown.internalTime.revenue += revenue;
      breakdown.internalTime.cost += cost;
      breakdown.internalTime.profit += profit;
    } else {
      // Billable entries go to their respective rate types
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
        // Default to shop time
        breakdown.shopTime.hours += hours;
        breakdown.shopTime.revenue += revenue;
        breakdown.shopTime.cost += cost;
        breakdown.shopTime.profit += profit;
      }
    }
  });

  return breakdown;
}

// Calculate breakdown by project
export function calculateProjectBreakdown(entries: TimeEntry[], employee?: EmployeeWithRates): ProjectBreakdown[] {
  const projectMap = new Map<string, ProjectBreakdown>();

  entries.forEach(entry => {
    const projectId = entry.project_id || 'no-project';
    const projectName = entry.project?.name || '(No Project)';
    const hours = Number(entry.hours) || 0;
    const rate = Number(entry.rate) || 0;
    // Use internal rate for non-billable entries
    const internalRate = Number(employee?.internal_rate) || 0;
    const revenue = entry.billable ? hours * rate : hours * internalRate;
    const billableHours = entry.billable ? hours : 0;

    if (!projectMap.has(projectId)) {
      projectMap.set(projectId, {
        projectId,
        projectName,
        hours: 0,
        revenue: 0,
        billableHours: 0,
      });
    }

    const project = projectMap.get(projectId)!;
    project.hours += hours;
    project.revenue += revenue;
    project.billableHours += billableHours;
  });

  return Array.from(projectMap.values()).sort((a, b) => b.hours - a.hours);
}

// Calculate breakdown by customer
export function calculateCustomerBreakdown(entries: TimeEntry[], employee?: EmployeeWithRates): CustomerBreakdown[] {
  const customerMap = new Map<string, CustomerBreakdown>();

  entries.forEach(entry => {
    const customerId = entry.project?.customer?.id || 'no-customer';
    const customerName = entry.project?.customer?.name || '(No Customer)';
    const hours = Number(entry.hours) || 0;
    const rate = Number(entry.rate) || 0;
    // Use internal rate for non-billable entries
    const internalRate = Number(employee?.internal_rate) || 0;
    const revenue = entry.billable ? hours * rate : hours * internalRate;
    const billableHours = entry.billable ? hours : 0;

    if (!customerMap.has(customerId)) {
      customerMap.set(customerId, {
        customerId,
        customerName,
        hours: 0,
        revenue: 0,
        billableHours: 0,
      });
    }

    const customer = customerMap.get(customerId)!;
    customer.hours += hours;
    customer.revenue += revenue;
    customer.billableHours += billableHours;
  });

  return Array.from(customerMap.values()).sort((a, b) => b.hours - a.hours);
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
  employees: EmployeeWithRates[]
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
    return employees.map(employee => aggregateEmployeeMetrics([], employee));
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
      const metrics = aggregateEmployeeMetrics(userEntries, employee);
      employeeMetrics.push(metrics);
    } else {
      console.warn(`No employee found for userId ${userId}, but has ${userEntries.length} entries`);
    }
  });

  // Add employees with no entries (with zero metrics)
  employees.forEach(employee => {
    if (!entriesByUser.has(employee.user_id)) {
      console.log(`Adding employee with no entries: ${employee.user_id} (${employee.user?.first_name} ${employee.user?.last_name})`);
      employeeMetrics.push(aggregateEmployeeMetrics([], employee));
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

