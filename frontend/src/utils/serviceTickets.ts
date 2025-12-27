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
}

export interface TimeEntryWithRelations {
  id: string;
  date: string;
  hours: number;
  description?: string;
  rate_type?: string;
  start_time?: string;
  end_time?: string;
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

/**
 * Groups billable time entries into service tickets
 * One ticket per (date, customer, employee) combination
 */
export function groupEntriesIntoTickets(
  entries: TimeEntryWithRelations[]
): ServiceTicket[] {
  const ticketMap = new Map<string, ServiceTicket>();

  for (const entry of entries) {
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
      };
      ticketMap.set(ticketKey, ticket);
    }

    // Add entry to ticket
    ticket.entries.push(entry);
    ticket.totalHours += entry.hours || 0;

    // Aggregate by rate type
    const rateType = (entry.rate_type || 'Shop Time') as keyof typeof ticket.hoursByRateType;
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

