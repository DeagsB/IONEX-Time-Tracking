// Service Tickets utility functions for grouping and aggregating billable time entries

export interface ServiceTicket {
  id: string; // Composite key: date-customerId-userId
  date: string;
  customerId: string;
  customerName: string;
  customerInfo: {
    name: string;
    email?: string;
    phone?: string;
    address?: string;
    city?: string;
    state?: string;
    zip_code?: string;
    country?: string;
    tax_id?: string;
    po_number?: string;
    approver_name?: string;
    location_code?: string;
    service_location?: string;
  };
  userId: string;
  userName: string;
  userInitials: string;
  userEmail?: string;
  projectId?: string;
  projectName?: string;
  projectNumber?: string;
  ticketNumber?: string; // Format: {initials}_{YY}{sequence} e.g., "DB_25001"
  totalHours: number;
  entries: TimeEntryWithRelations[];
  hoursByRateType: {
    'Shop Time': number;
    'Shop Overtime': number;
    'Travel Time': number;
    'Field Time': number;
    'Field Overtime': number;
  };
  // Employee-specific billable rates
  rates: {
    rt: number; // Regular Time / Shop Time rate
    tt: number; // Travel Time rate
    ft: number; // Field Time rate
    shop_ot: number; // Shop Overtime rate
    field_ot: number; // Field Overtime rate
  };
}

export interface TimeEntryWithRelations {
  id: string;
  date: string;
  hours: number;
  description?: string;
  rate_type?: string;
  start_time?: string;
  end_time?: string;
  is_demo?: boolean;
  user?: {
    id: string;
    email: string;
    first_name?: string;
    last_name?: string;
  };
  project?: {
    id: string;
    name: string;
    project_number?: string;
    // Project-specific rate overrides (per Junior/Senior employee status)
    shop_junior_rate?: number;
    shop_senior_rate?: number;
    ft_junior_rate?: number;
    ft_senior_rate?: number;
    travel_rate?: number;
    customer?: {
      id: string;
      name: string;
      email?: string;
      phone?: string;
      address?: string;
      city?: string;
      state?: string;
      zip_code?: string;
      country?: string;
      tax_id?: string;
      po_number?: string;
      approver_name?: string;
      location_code?: string;
      service_location?: string;
    };
  };
  user_id: string;
  project_id?: string;
}

// Employee type for rate lookup
export interface EmployeeWithRates {
  id: string;
  user_id: string;
  department?: string;
  position?: string; // 'Junior' or 'Senior' - used for project rate overrides
  rt_rate?: number;
  tt_rate?: number;
  ft_rate?: number;
  shop_ot_rate?: number;
  field_ot_rate?: number;
}

// Default rates if employee doesn't have custom rates
const DEFAULT_RATES = {
  rt: 110,
  tt: 85,
  ft: 140,
  shop_ot: 165,
  field_ot: 165,
};

/**
 * Groups billable time entries into service tickets
 * One ticket per (date, customer, employee) combination
 * @param entries - Time entries to group
 * @param employees - Optional employee data for rate lookup
 */
export function groupEntriesIntoTickets(
  entries: TimeEntryWithRelations[],
  employees?: EmployeeWithRates[]
): ServiceTicket[] {
  const ticketMap = new Map<string, ServiceTicket>();
  
  // Create a map of user_id to employee rates for quick lookup
  const employeeRatesMap = new Map<string, { rt: number; tt: number; ft: number; shop_ot: number; field_ot: number }>();
  const employeeDepartmentMap = new Map<string, string>();
  const employeePositionMap = new Map<string, string>();
  if (employees) {
    for (const emp of employees) {
      employeeRatesMap.set(emp.user_id, {
        rt: emp.rt_rate ?? DEFAULT_RATES.rt,
        tt: emp.tt_rate ?? DEFAULT_RATES.tt,
        ft: emp.ft_rate ?? DEFAULT_RATES.ft,
        shop_ot: emp.shop_ot_rate ?? DEFAULT_RATES.shop_ot,
        field_ot: emp.field_ot_rate ?? DEFAULT_RATES.field_ot,
      });
      if (emp.department) {
        employeeDepartmentMap.set(emp.user_id, emp.department);
      }
      if (emp.position) {
        employeePositionMap.set(emp.user_id, emp.position);
      }
    }
  }

  for (const entry of entries) {
    // Skip entries from Panel Shop employees - they don't create service tickets
    const employeeDepartment = employeeDepartmentMap.get(entry.user_id);
    if (employeeDepartment === 'Panel Shop') {
      continue;
    }
    // Handle entries without project/customer as "Unassigned Client"
    let customerId: string;
    let customerName: string;
    let customerInfo: ServiceTicket['customerInfo'];
    
    if (!entry.project || !entry.project.customer) {
      // Create unassigned bucket
      customerId = 'unassigned';
      customerName = 'Unassigned Client';
      customerInfo = {
        name: 'Unassigned Client',
        email: undefined,
        phone: undefined,
        address: undefined,
        city: undefined,
        state: undefined,
        zip_code: undefined,
        country: undefined,
        tax_id: undefined,
        po_number: undefined,
        approver_name: undefined,
        location_code: undefined,
        service_location: undefined,
      };
    } else {
      customerId = entry.project.customer.id;
      customerName = entry.project.customer.name;
      customerInfo = {
        name: entry.project.customer.name,
        email: entry.project.customer.email,
        phone: entry.project.customer.phone,
        address: entry.project.customer.address,
        city: entry.project.customer.city,
        state: entry.project.customer.state,
        zip_code: entry.project.customer.zip_code,
        country: entry.project.customer.country,
        tax_id: entry.project.customer.tax_id,
        po_number: entry.project.customer.po_number,
        approver_name: entry.project.customer.approver_name,
        location_code: entry.project.customer.location_code,
        service_location: entry.project.customer.service_location,
      };
    }

    const date = entry.date;
    const userId = entry.user_id;

    // Create composite key
    const ticketKey = `${date}-${customerId}-${userId}`;

    // Get or create ticket
    let ticket = ticketMap.get(ticketKey);
    if (!ticket) {
      // Generate user initials from first and last name
      const firstName = entry.user?.first_name || '';
      const lastName = entry.user?.last_name || '';
      const initials = (firstName.charAt(0) + lastName.charAt(0)).toUpperCase() || 'XX';
      
      // Get employee-specific rates or use defaults
      let employeeRates = employeeRatesMap.get(userId) || { ...DEFAULT_RATES };
      
      // Check for project-specific rate overrides
      // These override employee rates based on Junior/Senior status
      if (entry.project) {
        const employeePosition = employeePositionMap.get(userId) || 'Junior'; // Default to Junior if not specified
        const isSenior = employeePosition.toLowerCase() === 'senior';
        
        // Apply project rates if they exist
        const project = entry.project;
        const projectRates = { ...employeeRates };
        
        if (isSenior) {
          // Senior employee rates
          if (project.shop_senior_rate != null) projectRates.rt = project.shop_senior_rate;
          if (project.ft_senior_rate != null) projectRates.ft = project.ft_senior_rate;
        } else {
          // Junior employee rates
          if (project.shop_junior_rate != null) projectRates.rt = project.shop_junior_rate;
          if (project.ft_junior_rate != null) projectRates.ft = project.ft_junior_rate;
        }
        
        // Travel rate is the same regardless of Junior/Senior
        if (project.travel_rate != null) projectRates.tt = project.travel_rate;
        
        employeeRates = projectRates;
      }
      
      ticket = {
        id: ticketKey,
        date,
        customerId,
        customerName,
        customerInfo,
        userId,
        userName: entry.user
          ? `${firstName} ${lastName}`.trim() || entry.user.email
          : 'Unknown',
        userInitials: initials,
        userEmail: entry.user?.email,
        projectId: entry.project?.id,
        projectName: entry.project?.name,
        projectNumber: entry.project?.project_number,
        totalHours: 0,
        entries: [],
        hoursByRateType: {
          'Shop Time': 0,
          'Shop Overtime': 0,
          'Travel Time': 0,
          'Field Time': 0,
          'Field Overtime': 0,
        },
        rates: employeeRates,
      };
      ticketMap.set(ticketKey, ticket);
    }

    // Add entry to ticket
    ticket.entries.push(entry);
    ticket.totalHours += entry.hours || 0;

    // Aggregate by rate type
    // Convert overtime to regular time for service tickets - overtime must be manually added
    // This allows billing overtime hours as regular time to hide OT from clients
    let rateType = (entry.rate_type || 'Shop Time') as keyof typeof ticket.hoursByRateType;
    if (rateType === 'Shop Overtime') {
      rateType = 'Shop Time';
    } else if (rateType === 'Field Overtime') {
      rateType = 'Field Time';
    }
    
    if (ticket.hoursByRateType.hasOwnProperty(rateType)) {
      ticket.hoursByRateType[rateType] += entry.hours || 0;
    } else {
      // Default to Shop Time if unknown rate type
      ticket.hoursByRateType['Shop Time'] += entry.hours || 0;
    }
  }

  // Convert map to array and sort by date (most recent first)
  return Array.from(ticketMap.values()).sort((a, b) => {
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });
}

/**
 * Format date for display in service tickets
 */
export function formatTicketDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Generate a display ID for a service ticket
 */
export function generateTicketDisplayId(ticket: ServiceTicket): string {
  const datePart = new Date(ticket.date).toISOString().split('T')[0].replace(/-/g, '');
  const customerPart = ticket.customerName.substring(0, 3).toUpperCase();
  return `${datePart}-${customerPart}`;
}

/**
 * Get the sort order for rate types
 * Order: Shop Time, Field Time, Travel Time, then Overtime (Shop/Field)
 */
export function getRateTypeSortOrder(rateType: string): number {
  const order: { [key: string]: number } = {
    'Shop Time': 1,
    'Field Time': 2,
    'Travel Time': 3,
    'Shop Overtime': 4,
    'Field Overtime': 4,
  };
  return order[rateType] || 99;
}

