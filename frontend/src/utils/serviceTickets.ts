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
  };
  userId: string;
  userName: string;
  userEmail?: string;
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
    // Skip entries without project/customer (or handle as "Unassigned")
    if (!entry.project?.customer) {
      continue; // Skip unassigned entries for now
    }

    const date = entry.date;
    const customerId = entry.project.customer.id;
    const userId = entry.user_id;

    // Create composite key
    const ticketKey = `${date}-${customerId}-${userId}`;

    // Get or create ticket
    let ticket = ticketMap.get(ticketKey);
    if (!ticket) {
      ticket = {
        id: ticketKey,
        date,
        customerId,
        customerName: entry.project.customer.name,
        customerInfo: {
          name: entry.project.customer.name,
          email: entry.project.customer.email,
          phone: entry.project.customer.phone,
          address: entry.project.customer.address,
          city: entry.project.customer.city,
          state: entry.project.customer.state,
          zip_code: entry.project.customer.zip_code,
          country: entry.project.customer.country,
          tax_id: entry.project.customer.tax_id,
        },
        userId,
        userName: entry.user
          ? `${entry.user.first_name || ''} ${entry.user.last_name || ''}`.trim() || entry.user.email
          : 'Unknown',
        userEmail: entry.user?.email,
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

