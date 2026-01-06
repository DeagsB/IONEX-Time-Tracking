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
  let totalHours = 0;
  let billableHours = 0;
  let totalRevenue = 0;

  // Calculate total hours and billable hours from time entries (for cost calculation)
  entries.forEach(entry => {
    const hours = Number(entry.hours) || 0;
    totalHours += hours;
    
    if (entry.billable) {
      billableHours += hours;
    }
  });

  // Calculate revenue from service ticket hours (not time entry hours)
  // Match service tickets to time entries to determine rate type distribution
  if (serviceTicketHours && serviceTicketHours.length > 0) {
    // Group service tickets by date-customer-user key
    const ticketMap = new Map<string, { hours: number; customerId?: string; projectId?: string }>();
    serviceTicketHours.forEach(ticket => {
      if (ticket.user_id === userId) {
        const key = `${ticket.date}-${ticket.customer_id || 'unassigned'}-${ticket.user_id}`;
        const existing = ticketMap.get(key);
        if (existing) {
          existing.hours += Number(ticket.total_hours) || 0;
        } else {
          ticketMap.set(key, {
            hours: Number(ticket.total_hours) || 0,
            customerId: ticket.customer_id || undefined,
            projectId: ticket.project_id || undefined,
          });
        }
      }
    });

    // For each service ticket, calculate revenue based on ticket hours
    ticketMap.forEach((ticketData, ticketKey) => {
      const [ticketDate] = ticketKey.split('-');
      const ticketHours = ticketData.hours;
      
      // Find matching billable time entries for this ticket
      const matchingEntries = entries.filter(entry => {
        if (entry.date !== ticketDate) return false;
        if (!entry.billable) return false;
        if (ticketData.customerId && entry.project?.customer?.id !== ticketData.customerId) return false;
        if (ticketData.projectId && entry.project_id !== ticketData.projectId) return false;
        return true;
      });

      if (matchingEntries.length > 0) {
        // Calculate total hours from matching entries to get proportions
        const totalEntryHours = matchingEntries.reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
        
        if (totalEntryHours > 0) {
          // Distribute ticket hours proportionally by rate type from entries
          matchingEntries.forEach(entry => {
            const entryHours = Number(entry.hours) || 0;
            const proportion = entryHours / totalEntryHours;
            const ticketHoursForThisRate = ticketHours * proportion;
            
            // Get billable rate for this rate type
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
                billableRate = Number(employee.rt_rate) || 0;
              }
            }
            
            if (billableRate === 0) {
              billableRate = Number(entry.rate) || 0;
            }
            
            totalRevenue += ticketHoursForThisRate * billableRate;
          });
        }
      } else {
        // No matching entries found, use default shop time rate
        const billableRate = Number(employee?.rt_rate) || 110;
        totalRevenue += ticketHours * billableRate;
      }
    });
  } else {
    // Fallback to time entry hours if no service tickets exist
    entries.forEach(entry => {
      if (entry.billable) {
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
            billableRate = Number(employee.rt_rate) || 0;
          }
        }
        
        if (billableRate === 0) {
          billableRate = Number(entry.rate) || 0;
        }
        
        totalRevenue += Number(entry.hours) * billableRate;
      } else {
        const internalRate = Number(employee?.internal_rate) || 0;
        totalRevenue += Number(entry.hours) * internalRate;
      }
    });
  }

  const nonBillableHours = totalHours - billableHours;
  const billableRatio = totalHours > 0 ? (billableHours / totalHours) * 100 : 0;
  
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

  // Rate type breakdown (includes cost and profit calculations)
  const rateTypeBreakdown = calculateRateTypeBreakdown(entries, employee, serviceTicketHours);

  // Calculate total cost based on payroll hours (time entry hours grouped by rate type)
  // This matches the Payroll page calculation logic
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
  const isPanelShop = employee?.department === 'Panel Shop';
  
  // Shop Time cost
  if (hoursByRateType['Shop Time'] > 0) {
    const payRate = Number(employee?.shop_pay_rate) || 0;
    totalCost += hoursByRateType['Shop Time'] * payRate;
  }
  
  // Shop Overtime cost
  if (hoursByRateType['Shop Overtime'] > 0) {
    const payRate = isPanelShop 
      ? (Number(employee?.shop_ot_pay_rate) || Number(employee?.shop_pay_rate) || 0)
      : (Number(employee?.shop_ot_pay_rate) || 0);
    totalCost += hoursByRateType['Shop Overtime'] * payRate;
  }
  
  // Travel Time cost (paid at shop rate)
  if (hoursByRateType['Travel Time'] > 0) {
    const payRate = Number(employee?.shop_pay_rate) || 0;
    totalCost += hoursByRateType['Travel Time'] * payRate;
  }
  
  // Field Time cost
  if (hoursByRateType['Field Time'] > 0) {
    const payRate = isPanelShop
      ? (Number(employee?.field_pay_rate) || Number(employee?.shop_pay_rate) || 0)
      : (Number(employee?.field_pay_rate) || 0);
    totalCost += hoursByRateType['Field Time'] * payRate;
  }
  
  // Field Overtime cost
  if (hoursByRateType['Field Overtime'] > 0) {
    const payRate = isPanelShop
      ? (Number(employee?.field_ot_pay_rate) || Number(employee?.shop_pay_rate) || 0)
      : (Number(employee?.field_ot_pay_rate) || 0);
    totalCost += hoursByRateType['Field Overtime'] * payRate;
  }
  
  // Internal time cost (non-billable work)
  if (hoursByRateType['Internal'] > 0) {
    // Internal time is paid at shop rate (or use internal rate if different logic is needed)
    const payRate = Number(employee?.shop_pay_rate) || 0;
    totalCost += hoursByRateType['Internal'] * payRate;
  }
  
  console.log('Final totalCost (using payroll hours):', totalCost, 'for userId:', userId, 'entries count:', entries.length, 'hoursByRateType:', hoursByRateType);

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

  // Calculate Internal Time from time entries (payroll hours)
  entries.forEach(entry => {
    if (!entry.billable) {
      const hours = Number(entry.hours) || 0;
      const rate = Number(entry.rate) || 0;
      const internalRate = Number(employee?.internal_rate) || 0;
      const revenue = hours * internalRate;
      const rateType = (entry.rate_type || 'Shop Time').toLowerCase();
      
      // Determine pay rate based on rate type
      const isPanelShop = employee?.department === 'Panel Shop';
      let payRate = 0;
      if (isPanelShop) {
        if (rateType.includes('shop') && rateType.includes('overtime')) {
          payRate = employee?.shop_ot_pay_rate || employee?.shop_pay_rate || 0;
        } else if (rateType.includes('field') && rateType.includes('overtime')) {
          payRate = employee?.field_ot_pay_rate || employee?.shop_pay_rate || 0;
        } else if (rateType.includes('field')) {
          payRate = employee?.field_pay_rate || employee?.shop_pay_rate || 0;
        } else if (rateType.includes('travel')) {
          payRate = employee?.shop_pay_rate || 0;
        } else {
          payRate = employee?.shop_pay_rate || 0;
        }
      } else if (rateType.includes('shop') && rateType.includes('overtime')) {
        payRate = employee?.shop_ot_pay_rate || 0;
      } else if (rateType.includes('field') && rateType.includes('overtime')) {
        payRate = employee?.field_ot_pay_rate || 0;
      } else if (rateType.includes('field')) {
        payRate = employee?.field_pay_rate || 0;
      } else if (rateType.includes('travel')) {
        payRate = employee?.shop_pay_rate || 0;
      } else {
        payRate = employee?.shop_pay_rate || 0;
      }

      const cost = hours * payRate;
      const profit = revenue - cost;

      breakdown.internalTime.hours += hours;
      breakdown.internalTime.revenue += revenue;
      breakdown.internalTime.cost += cost;
      breakdown.internalTime.profit += profit;
    }
  });

  // Calculate billable rate types from service ticket hours
  if (serviceTicketHours && serviceTicketHours.length > 0) {
    // Process each service ticket
    serviceTicketHours.forEach(ticket => {
      if (ticket.user_id !== userId) return;
      
      // If ticket has been edited, use edited_hours directly
      if (ticket.is_edited && ticket.edited_hours) {
        const editedHours = ticket.edited_hours;
        
        // Process each rate type from edited hours
        Object.keys(editedHours).forEach(rateTypeKey => {
          const hours = editedHours[rateTypeKey];
          let totalHoursForRate = 0;
          
          // Sum hours if it's an array, otherwise use the number directly
          if (Array.isArray(hours)) {
            totalHoursForRate = hours.reduce((sum, h) => sum + (h || 0), 0);
          } else {
            totalHoursForRate = hours as number;
          }
          
          if (totalHoursForRate > 0) {
            const rateType = rateTypeKey.toLowerCase();
            
            // Get billable rate for this rate type
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
                billableRate = Number(employee.rt_rate) || 0;
              }
            }
            
            // Determine pay rate based on rate type
            const isPanelShop = employee?.department === 'Panel Shop';
            let payRate = 0;
            if (isPanelShop) {
              if (rateType.includes('shop') && rateType.includes('overtime')) {
                payRate = employee?.shop_ot_pay_rate || employee?.shop_pay_rate || 0;
              } else if (rateType.includes('field') && rateType.includes('overtime')) {
                payRate = employee?.field_ot_pay_rate || employee?.shop_pay_rate || 0;
              } else if (rateType.includes('field')) {
                payRate = employee?.field_pay_rate || employee?.shop_pay_rate || 0;
              } else if (rateType.includes('travel')) {
                payRate = employee?.shop_pay_rate || 0;
              } else {
                payRate = employee?.shop_pay_rate || 0;
              }
            } else if (rateType.includes('shop') && rateType.includes('overtime')) {
              payRate = employee?.shop_ot_pay_rate || 0;
            } else if (rateType.includes('field') && rateType.includes('overtime')) {
              payRate = employee?.field_ot_pay_rate || 0;
            } else if (rateType.includes('field')) {
              payRate = employee?.field_pay_rate || 0;
            } else if (rateType.includes('travel')) {
              payRate = employee?.shop_pay_rate || 0;
            } else {
              payRate = employee?.shop_pay_rate || 0;
            }

            const revenue = totalHoursForRate * billableRate;
            const cost = totalHoursForRate * payRate;
            const profit = revenue - cost;

            // Add to appropriate rate type breakdown
            if (rateType.includes('shop') && rateType.includes('overtime')) {
              breakdown.shopOvertime.hours += totalHoursForRate;
              breakdown.shopOvertime.revenue += revenue;
              breakdown.shopOvertime.cost += cost;
              breakdown.shopOvertime.profit += profit;
            } else if (rateType.includes('field') && rateType.includes('overtime')) {
              breakdown.fieldOvertime.hours += totalHoursForRate;
              breakdown.fieldOvertime.revenue += revenue;
              breakdown.fieldOvertime.cost += cost;
              breakdown.fieldOvertime.profit += profit;
            } else if (rateType.includes('field')) {
              breakdown.fieldTime.hours += totalHoursForRate;
              breakdown.fieldTime.revenue += revenue;
              breakdown.fieldTime.cost += cost;
              breakdown.fieldTime.profit += profit;
            } else if (rateType.includes('travel')) {
              breakdown.travelTime.hours += totalHoursForRate;
              breakdown.travelTime.revenue += revenue;
              breakdown.travelTime.cost += cost;
              breakdown.travelTime.profit += profit;
            } else {
              breakdown.shopTime.hours += totalHoursForRate;
              breakdown.shopTime.revenue += revenue;
              breakdown.shopTime.cost += cost;
              breakdown.shopTime.profit += profit;
            }
          }
        });
      } else {
        // Ticket not edited, distribute total_hours proportionally by rate type from matching entries
        const ticketDate = ticket.date;
        const ticketHours = Number(ticket.total_hours) || 0;
        
        // Find matching billable time entries for this ticket
        const matchingEntries = entries.filter(entry => {
          if (entry.date !== ticketDate) return false;
          if (!entry.billable) return false;
          if (ticket.customer_id && entry.project?.customer?.id !== ticket.customer_id) return false;
          if (ticket.project_id && entry.project_id !== ticket.project_id) return false;
          return true;
        });

        if (matchingEntries.length > 0) {
          // Calculate total hours from matching entries to get proportions
          const totalEntryHours = matchingEntries.reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
          
          if (totalEntryHours > 0) {
            // Distribute ticket hours proportionally by rate type from entries
            matchingEntries.forEach(entry => {
              const entryHours = Number(entry.hours) || 0;
              const proportion = entryHours / totalEntryHours;
              const ticketHoursForThisRate = ticketHours * proportion;
              
              const rateType = (entry.rate_type || 'Shop Time').toLowerCase();
              
              // Get billable rate for this rate type
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
                  billableRate = Number(employee.rt_rate) || 0;
                }
              }
              
              if (billableRate === 0) {
                billableRate = Number(entry.rate) || 0;
              }
              
              // Determine pay rate based on rate type
              const isPanelShop = employee?.department === 'Panel Shop';
              let payRate = 0;
              if (isPanelShop) {
                if (rateType.includes('shop') && rateType.includes('overtime')) {
                  payRate = employee?.shop_ot_pay_rate || employee?.shop_pay_rate || 0;
                } else if (rateType.includes('field') && rateType.includes('overtime')) {
                  payRate = employee?.field_ot_pay_rate || employee?.shop_pay_rate || 0;
                } else if (rateType.includes('field')) {
                  payRate = employee?.field_pay_rate || employee?.shop_pay_rate || 0;
                } else if (rateType.includes('travel')) {
                  payRate = employee?.shop_pay_rate || 0;
                } else {
                  payRate = employee?.shop_pay_rate || 0;
                }
              } else if (rateType.includes('shop') && rateType.includes('overtime')) {
                payRate = employee?.shop_ot_pay_rate || 0;
              } else if (rateType.includes('field') && rateType.includes('overtime')) {
                payRate = employee?.field_ot_pay_rate || 0;
              } else if (rateType.includes('field')) {
                payRate = employee?.field_pay_rate || 0;
              } else if (rateType.includes('travel')) {
                payRate = employee?.shop_pay_rate || 0;
              } else {
                payRate = employee?.shop_pay_rate || 0;
              }

              const revenue = ticketHoursForThisRate * billableRate;
              const cost = ticketHoursForThisRate * payRate;
              const profit = revenue - cost;

              // Add to appropriate rate type breakdown
              if (rateType.includes('shop') && rateType.includes('overtime')) {
                breakdown.shopOvertime.hours += ticketHoursForThisRate;
                breakdown.shopOvertime.revenue += revenue;
                breakdown.shopOvertime.cost += cost;
                breakdown.shopOvertime.profit += profit;
              } else if (rateType.includes('field') && rateType.includes('overtime')) {
                breakdown.fieldOvertime.hours += ticketHoursForThisRate;
                breakdown.fieldOvertime.revenue += revenue;
                breakdown.fieldOvertime.cost += cost;
                breakdown.fieldOvertime.profit += profit;
              } else if (rateType.includes('field')) {
                breakdown.fieldTime.hours += ticketHoursForThisRate;
                breakdown.fieldTime.revenue += revenue;
                breakdown.fieldTime.cost += cost;
                breakdown.fieldTime.profit += profit;
              } else if (rateType.includes('travel')) {
                breakdown.travelTime.hours += ticketHoursForThisRate;
                breakdown.travelTime.revenue += revenue;
                breakdown.travelTime.cost += cost;
                breakdown.travelTime.profit += profit;
              } else {
                breakdown.shopTime.hours += ticketHoursForThisRate;
                breakdown.shopTime.revenue += revenue;
                breakdown.shopTime.cost += cost;
                breakdown.shopTime.profit += profit;
              }
            });
          }
        } else {
          // No matching entries found, use default shop time rate
          const billableRate = Number(employee?.rt_rate) || 110;
          const payRate = Number(employee?.shop_pay_rate) || 0;
          const revenue = ticketHours * billableRate;
          const cost = ticketHours * payRate;
          const profit = revenue - cost;
          
          breakdown.shopTime.hours += ticketHours;
          breakdown.shopTime.revenue += revenue;
          breakdown.shopTime.cost += cost;
          breakdown.shopTime.profit += profit;
        }
      }
    });
  } else {
    // Fallback to time entry hours if no service tickets exist (for billable entries only)
    entries.forEach(entry => {
      if (entry.billable) {
        const hours = Number(entry.hours) || 0;
        const rate = Number(entry.rate) || 0;
        const revenue = hours * rate;
        const rateType = (entry.rate_type || 'Shop Time').toLowerCase();

        // Determine pay rate based on rate type
        const isPanelShop = employee?.department === 'Panel Shop';
        let payRate = 0;
        if (isPanelShop) {
          if (rateType.includes('shop') && rateType.includes('overtime')) {
            payRate = employee?.shop_ot_pay_rate || employee?.shop_pay_rate || 0;
          } else if (rateType.includes('field') && rateType.includes('overtime')) {
            payRate = employee?.field_ot_pay_rate || employee?.shop_pay_rate || 0;
          } else if (rateType.includes('field')) {
            payRate = employee?.field_pay_rate || employee?.shop_pay_rate || 0;
          } else if (rateType.includes('travel')) {
            payRate = employee?.shop_pay_rate || 0;
          } else {
            payRate = employee?.shop_pay_rate || 0;
          }
        } else if (rateType.includes('shop') && rateType.includes('overtime')) {
          payRate = employee?.shop_ot_pay_rate || 0;
        } else if (rateType.includes('field') && rateType.includes('overtime')) {
          payRate = employee?.field_ot_pay_rate || 0;
        } else if (rateType.includes('field')) {
          payRate = employee?.field_pay_rate || 0;
        } else if (rateType.includes('travel')) {
          payRate = employee?.shop_pay_rate || 0;
        } else {
          payRate = employee?.shop_pay_rate || 0;
        }

        const cost = hours * payRate;
        const profit = revenue - cost;

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
          breakdown.shopTime.hours += hours;
          breakdown.shopTime.revenue += revenue;
          breakdown.shopTime.cost += cost;
          breakdown.shopTime.profit += profit;
        }
      }
    });
  }

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

