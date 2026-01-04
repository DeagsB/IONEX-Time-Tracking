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
  rt_rate?: number;
  tt_rate?: number;
  ft_rate?: number;
  shop_ot_rate?: number;
  field_ot_rate?: number;
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
  averageRate: number;
  serviceTicketCount: number;
  efficiency: number;
  rateTypeBreakdown: RateTypeBreakdown;
  projectBreakdown: ProjectBreakdown[];
  customerBreakdown: CustomerBreakdown[];
  trends: TrendData[];
}

export interface RateTypeBreakdown {
  shopTime: { hours: number; revenue: number };
  fieldTime: { hours: number; revenue: number };
  travelTime: { hours: number; revenue: number };
  shopOvertime: { hours: number; revenue: number };
  fieldOvertime: { hours: number; revenue: number };
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
      averageRate: 0,
      serviceTicketCount: 0,
      efficiency: 0,
      rateTypeBreakdown: {
        shopTime: { hours: 0, revenue: 0 },
        fieldTime: { hours: 0, revenue: 0 },
        travelTime: { hours: 0, revenue: 0 },
        shopOvertime: { hours: 0, revenue: 0 },
        fieldOvertime: { hours: 0, revenue: 0 },
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
    const rate = Number(entry.rate) || 0;
    totalHours += hours;
    if (entry.billable) {
      billableHours += hours;
      totalRevenue += hours * rate;
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

  // Rate type breakdown
  const rateTypeBreakdown = calculateRateTypeBreakdown(entries);

  // Project breakdown
  const projectBreakdown = calculateProjectBreakdown(entries);

  // Customer breakdown
  const customerBreakdown = calculateCustomerBreakdown(entries);

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
    averageRate,
    serviceTicketCount,
    efficiency,
    rateTypeBreakdown,
    projectBreakdown,
    customerBreakdown,
    trends,
  };
}

// Calculate breakdown by rate type
export function calculateRateTypeBreakdown(entries: TimeEntry[]): RateTypeBreakdown {
  const breakdown: RateTypeBreakdown = {
    shopTime: { hours: 0, revenue: 0 },
    fieldTime: { hours: 0, revenue: 0 },
    travelTime: { hours: 0, revenue: 0 },
    shopOvertime: { hours: 0, revenue: 0 },
    fieldOvertime: { hours: 0, revenue: 0 },
  };

  entries.forEach(entry => {
    const hours = Number(entry.hours) || 0;
    const rate = Number(entry.rate) || 0;
    const revenue = entry.billable ? hours * rate : 0;
    const rateType = (entry.rate_type || 'Shop Time').toLowerCase();

    if (rateType.includes('shop') && rateType.includes('overtime')) {
      breakdown.shopOvertime.hours += hours;
      breakdown.shopOvertime.revenue += revenue;
    } else if (rateType.includes('field') && rateType.includes('overtime')) {
      breakdown.fieldOvertime.hours += hours;
      breakdown.fieldOvertime.revenue += revenue;
    } else if (rateType.includes('field')) {
      breakdown.fieldTime.hours += hours;
      breakdown.fieldTime.revenue += revenue;
    } else if (rateType.includes('travel')) {
      breakdown.travelTime.hours += hours;
      breakdown.travelTime.revenue += revenue;
    } else {
      // Default to shop time
      breakdown.shopTime.hours += hours;
      breakdown.shopTime.revenue += revenue;
    }
  });

  return breakdown;
}

// Calculate breakdown by project
export function calculateProjectBreakdown(entries: TimeEntry[]): ProjectBreakdown[] {
  const projectMap = new Map<string, ProjectBreakdown>();

  entries.forEach(entry => {
    const projectId = entry.project_id || 'no-project';
    const projectName = entry.project?.name || '(No Project)';
    const hours = Number(entry.hours) || 0;
    const rate = Number(entry.rate) || 0;
    const revenue = entry.billable ? hours * rate : 0;
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
export function calculateCustomerBreakdown(entries: TimeEntry[]): CustomerBreakdown[] {
  const customerMap = new Map<string, CustomerBreakdown>();

  entries.forEach(entry => {
    const customerId = entry.project?.customer?.id || 'no-customer';
    const customerName = entry.project?.customer?.name || '(No Customer)';
    const hours = Number(entry.hours) || 0;
    const rate = Number(entry.rate) || 0;
    const revenue = entry.billable ? hours * rate : 0;
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
  
  if (!entries || entries.length === 0) {
    console.log('No entries provided, returning metrics for all employees with zero hours');
    // Return all employees with zero metrics
    return employees.map(employee => aggregateEmployeeMetrics([], employee));
  }
  
  if (!employees || employees.length === 0) {
    console.log('No employees provided, returning empty array');
    return [];
  }
  
  // Group entries by user_id
  const entriesByUser = new Map<string, TimeEntry[]>();
  
  entries.forEach(entry => {
    const userId = entry.user_id;
    if (!userId) {
      console.warn('Entry missing user_id:', entry);
      return;
    }
    if (!entriesByUser.has(userId)) {
      entriesByUser.set(userId, []);
    }
    entriesByUser.get(userId)!.push(entry);
  });

  console.log('Entries grouped by user_id:', Array.from(entriesByUser.keys()));
  console.log('Employee user_ids:', employees.map(e => e.user_id));

  // Create metrics for each employee
  const employeeMetrics: EmployeeMetrics[] = [];
  
  // Process employees with entries
  entriesByUser.forEach((userEntries, userId) => {
    const employee = employees.find(e => e.user_id === userId);
    console.log(`Processing entries for userId ${userId}, found employee:`, !!employee);
    const metrics = aggregateEmployeeMetrics(userEntries, employee);
    employeeMetrics.push(metrics);
  });

  // Add employees with no entries (with zero metrics)
  employees.forEach(employee => {
    if (!entriesByUser.has(employee.user_id)) {
      console.log(`Adding employee with no entries: ${employee.user_id}`);
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

