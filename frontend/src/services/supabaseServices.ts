import { supabase } from '../lib/supabaseClient';
import { buildApproverPoAfe, extractApproverCode, buildBillingKey } from '../utils/serviceTickets';

// Service functions for interacting with Supabase tables

export const timeEntriesService = {
  async getAll(isDemoMode?: boolean, userId?: string) {
    // RLS policies automatically filter time entries:
    // - Regular users can only see their own entries (user_id = auth.uid())
    // - Admins can see all entries (but we filter by userId in frontend for privacy)
    let query = supabase
      .from('time_entries')
      .select(`
        *,
        project:projects!time_entries_project_id_fkey(
          id,
          name,
          project_number,
          color,
          customer:customers!projects_customer_id_fkey(
            id,
            name
          )
        )
      `)
      .order('date', { ascending: false });
    
    // Filter by demo mode if specified
    if (isDemoMode !== undefined) {
      query = query.eq('is_demo', isDemoMode);
    }
    
    // Explicitly filter by user_id if provided (for privacy - even admins only see their own in calendar views)
    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query;

    if (error) throw error;
    return data;
  },

  async getById(id: string) {
    const { data, error } = await supabase
      .from('time_entries')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    return data;
  },

  async create(entry: any) {
    const { data, error } = await supabase
      .from('time_entries')
      .insert(entry)
      .select('*')
      .single();

    if (error) throw error;
    return data;
  },

  async update(id: string, updates: any) {
    const { data, error } = await supabase
      .from('time_entries')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async delete(id: string) {
    const { error } = await supabase
      .from('time_entries')
      .delete()
      .eq('id', id);

    if (error) throw error;
  },

  async approve(id: string, approvedBy: string) {
    const { data, error } = await supabase
      .from('time_entries')
      .update({
        approved: true,
        approved_by: approvedBy,
        approved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async getLastLocation(userId: string, projectId: string): Promise<string | null> {
    // Get the most recent time entry with a location for this user and project
    const { data, error } = await supabase
      .from('time_entries')
      .select('location')
      .eq('user_id', userId)
      .eq('project_id', projectId)
      .not('location', 'is', null)
      .neq('location', '')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      // No matching entry found is not an error for our purposes
      if (error.code === 'PGRST116') return null;
      console.error('Error fetching last location:', error);
      return null;
    }
    return data?.location || null;
  },
};

export const customersService = {
  async getAll(includeInactive: boolean = false) {
    let query = supabase
      .from('customers')
      .select('*, projects(*), created_by')
      .order('name');
    if (!includeInactive) {
      query = query.or('active.eq.true,active.is.null');
    }
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  async getById(id: string) {
    const { data, error } = await supabase
      .from('customers')
      .select('*, projects(*)')
      .eq('id', id)
      .single();

    if (error) throw error;
    return data;
  },

  async create(customer: any) {
    // Get current user from auth
    const { data: { user: authUser } } = await supabase.auth.getUser();
    
    const numericRateFields = ['rate_shop_junior', 'rate_shop_senior', 'rate_field_junior', 'rate_field_senior', 'rate_travel'];
    const customerData: any = {
      ...customer,
      created_by: authUser?.id || null, // Set created_by to current user
      is_private: false, // Always set to false (private option removed)
    };
    for (const key of numericRateFields) {
      if (key in customerData && (customerData[key] === '' || customerData[key] === undefined)) {
        customerData[key] = null;
      } else if (key in customerData && customerData[key] !== null) {
        const num = parseFloat(customerData[key]);
        customerData[key] = Number.isNaN(num) ? null : num;
      }
    }

    const { data, error } = await supabase
      .from('customers')
      .insert(customerData)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async update(id: string, updates: any) {
    // Get current user from auth
    const { data: { user: authUser } } = await supabase.auth.getUser();
    
    // Don't allow changing created_by or is_private fields
    const { created_by, is_private, ...updateData } = updates;
    const numericRateFields = ['rate_shop_junior', 'rate_shop_senior', 'rate_field_junior', 'rate_field_senior', 'rate_travel'];
    const finalUpdates: any = {
      ...updateData,
      is_private: false, // Always set to false (private option removed)
    };
    // Convert empty string rate fields to null so PostgreSQL numeric columns accept them
    for (const key of numericRateFields) {
      if (key in finalUpdates && (finalUpdates[key] === '' || finalUpdates[key] === undefined)) {
        finalUpdates[key] = null;
      } else if (key in finalUpdates && finalUpdates[key] !== null) {
        const num = parseFloat(finalUpdates[key]);
        finalUpdates[key] = Number.isNaN(num) ? null : num;
      }
    }
    
    const { data, error } = await supabase
      .from('customers')
      .update(finalUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // Sync draft and rejected service tickets with updated customer info (address, billing rates context, etc.)
    if (data) {
      serviceTicketsService.updateDraftRejectedTicketsWithCustomerInfo(id, {
        name: data.name,
        contact_name: data.contact_name,
        email: data.email,
        phone: data.phone,
        address: data.address,
        city: data.city,
        state: data.state,
        zip_code: data.zip_code,
        service_location: data.service_location,
        location_code: data.location_code,
        po_number: data.po_number,
        approver_name: data.approver_name,
      }).catch((err) => console.warn('Failed to sync service tickets with customer update:', err));
    }

    return data;
  },
};

export const projectsService = {
  async getAll(includeInactive: boolean = false) {
    let query = supabase
      .from('projects')
      .select(`
        *,
        customer:customers(*)
      `)
      .order('name');
    if (!includeInactive) {
      query = query.or('active.eq.true,active.is.null');
    }
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  async getById(id: string) {
    const { data, error } = await supabase
      .from('projects')
      .select(`
        *,
        customer:customers(*)
      `)
      .eq('id', id)
      .single();

    if (error) throw error;
    return data;
  },

  async create(project: any, currentUserId: string) {
    const projectData = {
      ...project,
      created_by: currentUserId, // Set created_by
      is_private: false, // Always set to false (private option removed)
    };

    const { data, error } = await supabase
      .from('projects')
      .insert(projectData)
      .select(`
        *,
        customer:customers(*)
      `)
      .single();

    if (error) throw error;
    return data;
  },

  async update(id: string, updates: any) {
    const { data, error } = await supabase
      .from('projects')
      .update(updates)
      .eq('id', id)
      .select(`
        *,
        customer:customers(*)
      `)
      .single();

    if (error) throw error;
    return data;
  },
};

export const employeesService = {
  async getAll(includeArchived: boolean = false) {
    let query = supabase
      .from('employees')
      .select(`
        *,
        user:users!employees_user_id_fkey(id, email, first_name, last_name, archived)
      `)
      .order('employee_id');

    // Filter out archived users if not including them
    // Note: We filter in the application layer if needed, as Supabase filtering on joined tables can be tricky
    const { data, error } = await query;

    if (error) {
      console.error('Error fetching employees:', error);
      throw error;
    }

    // Filter out archived users in application layer if not including them
    if (!includeArchived && data) {
      return data.filter((emp: any) => !emp.user || !emp.user.archived);
    }

    return data;
  },

  async getById(id: string) {
    const { data, error } = await supabase
      .from('employees')
      .select(`
        *,
        user:users(id, email, first_name, last_name)
      `)
      .eq('id', id)
      .single();

    if (error) throw error;
    return data;
  },

  async create(employee: any) {
    const { data, error } = await supabase
      .from('employees')
      .insert(employee)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async update(id: string, updates: any) {
    const { data, error } = await supabase
      .from('employees')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async delete(id: string) {
    const { error } = await supabase
      .from('employees')
      .delete()
      .eq('id', id);

    if (error) throw error;
  },
};

export const formsService = {
  async getAll() {
    const { data, error } = await supabase
      .from('forms')
      .select(`
        *,
        employee:employees(
          id,
          user:users(first_name, last_name)
        )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  },

  async getById(id: string) {
    const { data, error } = await supabase
      .from('forms')
      .select(`
        *,
        employee:employees(
          id,
          user:users(first_name, last_name)
        )
      `)
      .eq('id', id)
      .single();

    if (error) throw error;
    return data;
  },

  async create(form: any) {
    const { data, error } = await supabase
      .from('forms')
      .insert(form)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async update(id: string, updates: any) {
    const { data, error } = await supabase
      .from('forms')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async delete(id: string) {
    const { error } = await supabase
      .from('forms')
      .delete()
      .eq('id', id);

    if (error) throw error;
  },
};

export const usersService = {
  async getUserProfile(userId: string) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) throw error;
    return data;
  },

  async getAll(includeArchived: boolean = false) {
    let query = supabase
      .from('users')
      .select('*')
      .order('created_at', { ascending: false });

    if (!includeArchived) {
      query = query.eq('archived', false);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data;
  },

  async archiveUser(userId: string) {
    const { data, error } = await supabase
      .from('users')
      .update({
        archived: true,
        archived_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async unarchiveUser(userId: string) {
    const { data, error } = await supabase
      .from('users')
      .update({
        archived: false,
        archived_at: null,
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async updateProfile(userId: string, updates: {
    first_name?: string;
    last_name?: string;
    email?: string;
    timezone?: string;
    date_format?: string;
    time_format?: string;
  }) {
    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async updateEmail(newEmail: string) {
    const { data, error } = await supabase.auth.updateUser({
      email: newEmail,
    });

    if (error) throw error;
    return data;
  },

  async updatePassword(newPassword: string) {
    const { data, error } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (error) throw error;
    return data;
  },

  async verifyCurrentPassword(email: string, currentPassword: string) {
    // Try to sign in with the current password to verify it
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password: currentPassword,
    });

    if (error) {
      return false;
    }
    return true;
  },

  async updateUserRole(userId: string, role: 'ADMIN' | 'USER' | 'DEVELOPER') {
    const { data, error } = await supabase
      .from('users')
      .update({ role })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async deleteUser(userId: string) {
    // Call the database function to delete the user
    // This will delete from auth.users (cascades to public.users)
    // Employee records will be preserved with user_id set to NULL
    const { error } = await supabase.rpc('delete_user', { user_uuid: userId });

    if (error) throw error;
  },
};

export const reportsService = {
  async getEmployeeReport(startDate: string, endDate: string) {
    const { data, error } = await supabase
      .from('time_entries')
      .select(`
        *,
        user:users(first_name, last_name),
        project:projects(name, customer:customers(name))
      `)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date');

    if (error) throw error;
    return data;
  },

  // Get comprehensive employee analytics for all or specific employee
  async getEmployeeAnalytics(startDate: string, endDate: string, userId?: string, includeArchived: boolean = false) {
    console.log('getEmployeeAnalytics called:', { startDate, endDate, userId, includeArchived });
    
    let query = supabase
      .from('time_entries')
      .select(`
        *,
        user:users!time_entries_user_id_fkey(id, first_name, last_name, email, archived),
        project:projects!time_entries_project_id_fkey(id, name, project_number, customer:customers!projects_customer_id_fkey(id, name))
      `)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date');

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query;
    
    if (error) {
      console.error('Error fetching employee analytics:', error);
      throw error;
    }
    
    // Filter out archived users if not including them
    let filteredData = data || [];
    if (!includeArchived && data) {
      filteredData = data.filter((entry: any) => {
        // Include entries where user is null (deleted user) or not archived
        return !entry.user || !entry.user.archived;
      });
    }
    
    console.log('getEmployeeAnalytics result:', { 
      total: data?.length || 0, 
      filtered: filteredData.length,
      includeArchived 
    });
    return filteredData;
  },

  // Get all employees with their rates (excluding archived users by default)
  async getEmployeesWithRates(includeArchived: boolean = false) {
    const query = supabase
      .from('employees')
      .select(`
        *,
        user:users!employees_user_id_fkey(id, first_name, last_name, email, archived)
      `)
      .order('employee_id');

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching employees:', error);
      throw error;
    }
    
    console.log('Fetched employees (before filtering):', data?.length || 0);
    
    // Filter out archived users in application layer if not including them
    let filteredData = data || [];
    if (!includeArchived && data) {
      filteredData = data.filter((emp: any) => !emp.user || !emp.user.archived);
    }
    
    console.log('Fetched employees (after filtering):', filteredData.length);
    
    // Debug: Log first employee to check pay rates
    if (filteredData && filteredData.length > 0) {
      console.log('Sample employee data:', {
        id: filteredData[0].id,
        user_id: filteredData[0].user_id,
        employee_id: filteredData[0].employee_id,
        shop_pay_rate: filteredData[0].shop_pay_rate,
        field_pay_rate: filteredData[0].field_pay_rate,
        shop_ot_pay_rate: filteredData[0].shop_ot_pay_rate,
        field_ot_pay_rate: filteredData[0].field_ot_pay_rate,
        hasUser: !!filteredData[0].user,
        userArchived: filteredData[0].user?.archived,
        allKeys: Object.keys(filteredData[0]),
      });
    }
    
    return filteredData;
  },

  // Get time entries grouped by rate type for an employee
  async getEmployeeTimeBreakdown(userId: string, startDate: string, endDate: string) {
    const { data, error } = await supabase
      .from('time_entries')
      .select(`
        rate_type,
        hours,
        rate,
        billable
      `)
      .eq('user_id', userId)
      .gte('date', startDate)
      .lte('date', endDate);

    if (error) throw error;
    return data;
  },

  // Get service tickets for an employee (only entries with project/customer)
  async getEmployeeServiceTickets(userId: string, startDate: string, endDate: string) {
    const { data, error } = await supabase
      .from('time_entries')
      .select(`
        *,
        project:projects(id, name, customer:customers(id, name))
      `)
      .eq('user_id', userId)
      .eq('billable', true)
      .not('project_id', 'is', null) // Only entries with a project can be service tickets
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date');

    if (error) throw error;
    return data;
  },

  // Get service ticket hours for employees (for revenue calculation)
  async getServiceTicketHours(startDate: string, endDate: string, userId?: string) {
    let query = supabase
      .from('service_tickets')
      .select('id, user_id, date, total_hours, total_amount, customer_id, project_id, is_edited, edited_hours')
      .gte('date', startDate)
      .lte('date', endDate);

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching service ticket hours:', error);
      throw error;
    }

    return data || [];
  },

  // Get project breakdown for an employee
  async getEmployeeProjectBreakdown(userId: string, startDate: string, endDate: string) {
    const { data, error } = await supabase
      .from('time_entries')
      .select(`
        project_id,
        hours,
        rate,
        billable,
        project:projects(id, name)
      `)
      .eq('user_id', userId)
      .gte('date', startDate)
      .lte('date', endDate);

    if (error) throw error;
    return data;
  },

  // Get customer breakdown for an employee (via projects)
  async getEmployeeCustomerBreakdown(userId: string, startDate: string, endDate: string) {
    const { data, error } = await supabase
      .from('time_entries')
      .select(`
        hours,
        rate,
        billable,
        project:projects(id, name, customer:customers(id, name))
      `)
      .eq('user_id', userId)
      .gte('date', startDate)
      .lte('date', endDate);

    if (error) throw error;
    return data;
  },

  // Get time entries for trends analysis
  async getEmployeeTrends(userId: string, startDate: string, endDate: string) {
    const { data, error } = await supabase
      .from('time_entries')
      .select(`
        date,
        hours,
        rate,
        billable,
        rate_type
      `)
      .eq('user_id', userId)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date');

    if (error) throw error;
    return data;
  },
};

export const serviceTicketsService = {
  async getBillableEntries(filters?: {
    startDate?: string;
    endDate?: string;
    customerId?: string;
    userId?: string;
    isDemoMode?: boolean;
  }) {
    let query = supabase
      .from('time_entries')
      .select(`
        *,
        user:users!time_entries_user_id_fkey(id, email, first_name, last_name),
        project:projects!time_entries_project_id_fkey(
          id,
          name,
          project_number,
          shop_junior_rate,
          shop_senior_rate,
          ft_junior_rate,
          ft_senior_rate,
          travel_rate,
          location,
          approver,
          po_afe,
          cc,
          other,
          customer:customers!projects_customer_id_fkey(*)
        )
      `)
      .eq('billable', true)
      .not('project_id', 'is', null) // Only entries with a project can be service tickets
      .order('date', { ascending: false });

    if (filters?.startDate) {
      query = query.gte('date', filters.startDate);
    }
    if (filters?.endDate) {
      query = query.lte('date', filters.endDate);
    }
    if (filters?.userId) {
      query = query.eq('user_id', filters.userId);
    }
    // Filter by demo mode - only show demo entries in demo mode, only real entries outside
    if (filters?.isDemoMode !== undefined) {
      query = query.eq('is_demo', filters.isDemoMode);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }
    
    return data;
  },

  /**
   * Get the next available ticket number for an employee
   * Format: {initials}_{YY}{sequence} e.g., "DB_25001"
   * This function finds the first available sequence number, including gaps from unassigned tickets
   * @param userInitials - Employee initials
   * @param isDemo - If true, queries the demo table; otherwise queries the regular table
   */
  async getNextTicketNumber(userInitials: string, isDemo: boolean = false): Promise<string> {
    const year = new Date().getFullYear() % 100; // Get last 2 digits of year
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    
    // Get all used sequence numbers for this employee this year
    // Exclude: null sequence (unassigned), trashed tickets (their numbers are freed for reuse)
    const { data, error } = await supabase
      .from(tableName)
      .select('sequence_number')
      .eq('employee_initials', userInitials.toUpperCase())
      .eq('year', year)
      .not('sequence_number', 'is', null)
      .or('is_discarded.eq.false,is_discarded.is.null')
      .order('sequence_number', { ascending: true });

    if (error) {
      console.error(`[getNextTicketNumber] Error querying ${tableName}:`, error);
      throw error;
    }

    let nextSequence = 1;
    
    if (data && data.length > 0) {
      // Build a set of used sequence numbers
      const usedSequences = new Set(data.map(d => d.sequence_number));
      
      // Find the first available sequence number (fill gaps from unassigned tickets)
      nextSequence = 1;
      while (usedSequences.has(nextSequence)) {
        nextSequence++;
      }
      
      console.log(`[getNextTicketNumber] ${isDemo ? 'DEMO' : 'REGULAR'} - Table: ${tableName}, Used sequences: [${Array.from(usedSequences).sort((a, b) => a - b).join(', ')}], Next available: ${nextSequence}`);
    } else {
      console.log(`[getNextTicketNumber] ${isDemo ? 'DEMO' : 'REGULAR'} - Table: ${tableName}, No existing tickets, starting at 1`);
    }
    
    const paddedSequence = String(nextSequence).padStart(3, '0');
    const ticketNumber = `${userInitials.toUpperCase()}_${year}${paddedSequence}`;
    
    // For demo mode, if we found tickets but they shouldn't exist (table should be wiped),
    // log a warning but still proceed
    if (isDemo && data && data.length > 0) {
      console.warn(`[getNextTicketNumber] WARNING: Found ${data.length} existing demo ticket(s). Expected empty table after demo mode enable.`);
    }
    
    return ticketNumber;
  },

  /**
   * Create a service ticket record in the database
   * If the ticket number already exists, finds the next available ticket number
   */
  async createTicketRecord(ticket: {
    ticketNumber: string;
    employeeInitials: string;
    year: number;
    sequenceNumber: number;
    date: string;
    customerId?: string;
    userId: string;
    projectId?: string;
    location?: string;
    totalHours: number;
    totalAmount: number;
    isDemo?: boolean;
    approvedByAdminId?: string;
    headerOverrides?: Record<string, string | number>;
  }) {
    const isDemo = ticket.isDemo || false;
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    let ticketNumber = ticket.ticketNumber;
    let attempts = 0;
    const maxAttempts = 100; // Prevent infinite loops

    while (attempts < maxAttempts) {
      // Check if a ticket with this number already exists
      const { data: existing, error: checkError } = await supabase
        .from(tableName)
        .select('*')
        .eq('ticket_number', ticketNumber)
        .maybeSingle();

      // If it doesn't exist, we can use this number
      if (!existing && !checkError) {
        // Create the ticket with this number
        const insertData: any = {
          ticket_number: ticketNumber,
          employee_initials: ticket.employeeInitials,
          year: ticket.year,
          sequence_number: ticket.sequenceNumber,
          date: ticket.date,
          customer_id: ticket.customerId,
          user_id: ticket.userId,
          project_id: ticket.projectId,
          location: ticket.location || '',
          total_hours: ticket.totalHours,
          total_amount: ticket.totalAmount,
          status: 'draft',
        };
        if (ticket.approvedByAdminId) {
          insertData.approved_by_admin_id = ticket.approvedByAdminId;
        }
        if (ticket.headerOverrides && Object.keys(ticket.headerOverrides).length > 0) {
          insertData.header_overrides = ticket.headerOverrides;
        }
        const { data, error } = await supabase
          .from(tableName)
          .insert(insertData)
          .select()
          .single();

        // If we get a duplicate key error (race condition), find next available number
        if (error && error.code === '23505') {
          attempts++;
          // Get all used sequence numbers and find first gap
          const year = new Date().getFullYear() % 100;
          const retryTableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
          const { data: seqData } = await supabase
            .from(retryTableName)
            .select('sequence_number')
            .eq('employee_initials', ticket.employeeInitials.toUpperCase())
            .eq('year', year)
            .not('sequence_number', 'is', null)
            .or('is_discarded.eq.false,is_discarded.is.null')
            .order('sequence_number', { ascending: true });
          
          // Find first available gap
          let nextSequence = 1;
          if (seqData && seqData.length > 0) {
            const usedSequences = new Set(seqData.map(d => d.sequence_number));
            while (usedSequences.has(nextSequence)) {
              nextSequence++;
            }
          }
          
          ticket.sequenceNumber = nextSequence;
          const paddedSequence = String(nextSequence).padStart(3, '0');
          ticketNumber = `${ticket.employeeInitials.toUpperCase()}_${year}${paddedSequence}`;
          continue; // Try again with the new number
        }

        if (error) {
          throw error;
        }
        
        return data;
      } else if (existing) {
        // Ticket number exists, find the next available one
        attempts++;
        // Get all used sequence numbers and find first gap
        const year = new Date().getFullYear() % 100;
        const retryTableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
        const { data: seqData } = await supabase
          .from(retryTableName)
          .select('sequence_number')
          .eq('employee_initials', ticket.employeeInitials.toUpperCase())
          .eq('year', year)
          .not('sequence_number', 'is', null)
          .or('is_discarded.eq.false,is_discarded.is.null')
          .order('sequence_number', { ascending: true });
        
        // Find first available gap
        let nextSequence = 1;
        if (seqData && seqData.length > 0) {
          const usedSequences = new Set(seqData.map(d => d.sequence_number));
          while (usedSequences.has(nextSequence)) {
            nextSequence++;
          }
        }
        
        ticket.sequenceNumber = nextSequence;
        const paddedSequence = String(nextSequence).padStart(3, '0');
        ticketNumber = `${ticket.employeeInitials.toUpperCase()}_${year}${paddedSequence}`;
        continue; // Try again with the new number
      } else {
        // Check error occurred
        throw checkError;
      }
    }

    throw new Error(`Failed to create ticket record after ${maxAttempts} attempts. Unable to find available ticket number.`);
  },

  /**
   * Update header_overrides for a service ticket (snapshot of customer info + rates to freeze approved tickets)
   */
  async updateHeaderOverrides(
    ticketId: string,
    overrides: Record<string, string | number>,
    isDemo: boolean = false
  ): Promise<void> {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    const { error } = await supabase.from(tableName).update({ header_overrides: overrides }).eq('id', ticketId);
    if (error) {
      console.warn('Failed to save header overrides:', error);
    }
  },

  /**
   * Update ticket number for an existing service ticket record
   * @param ticketId - The ID of the ticket record to update
   * @param ticketNumber - The new ticket number (or null to unassign)
   * @param isDemo - If true, updates the demo table; otherwise updates the regular table
   * @param approvedByAdminId - Optional admin user ID who approved the ticket
   * @param headerOverrides - When approving, snapshot to freeze ticket (saved in same update; DB trigger protects afterward)
   */
  async updateTicketNumber(
    ticketId: string,
    ticketNumber: string | null,
    isDemo: boolean = false,
    approvedByAdminId?: string,
    headerOverrides?: Record<string, string | number>
  ): Promise<void> {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';

    const updateData: any = {};

    if (ticketNumber === null) {
      // Unassign ticket number - keep employee_initials for tracking
      updateData.ticket_number = null;
      updateData.sequence_number = null;
      updateData.year = null;
      updateData.approved_by_admin_id = null;
    } else {
      // Assign ticket number - extract employee_initials from ticket number (format: XX_YYNNN)
      updateData.ticket_number = ticketNumber;
      updateData.rejected_at = null; // Clear so ticket no longer shows as resubmitted
      updateData.rejection_notes = null; // Clear rejection note when admin approves
      const year = new Date().getFullYear() % 100;
      const sequenceMatch = ticketNumber.match(/\d{3}$/);
      const sequenceNumber = sequenceMatch ? parseInt(sequenceMatch[0]) : null;
      
      // Extract employee initials from ticket number (e.g., "DB_25001" -> "DB")
      const initialsMatch = ticketNumber.match(/^([A-Z]+)_/);
      const employeeInitials = initialsMatch ? initialsMatch[1] : null;
      
      updateData.year = year;
      updateData.sequence_number = sequenceNumber;
      updateData.employee_initials = employeeInitials;
      updateData.workflow_status = 'approved'; // Admin approval clears rejected/draft
      if (approvedByAdminId) {
        updateData.approved_by_admin_id = approvedByAdminId;
      }
      if (headerOverrides && Object.keys(headerOverrides).length > 0) {
        updateData.header_overrides = headerOverrides;
      }
    }

    const { error } = await supabase
      .from(tableName)
      .update(updateData)
      .eq('id', ticketId);

    if (error) {
      console.error('Error updating ticket number:', error);
      throw error;
    }
  },

  /**
   * Get or create a service ticket record for a given date/user/customer/project/location combination.
   * Hierarchy: Project > Location > PO/AFE/CC (Cost Center). Different at any level = new ticket.
   * When billingKey is provided (approver::poAfe::cc), matches by all three so different
   * approver, PO/AFE, or CC create separate tickets. Requires a valid customerId.
   */
  async getOrCreateTicket(params: {
    date: string;
    userId: string;
    customerId: string | null;
    projectId?: string | null;
    location?: string;
    billingKey?: string;
  }, isDemo: boolean = false): Promise<{ id: string }> {
    // Don't create tickets without a customer - they need a project/customer to be valid
    if (!params.customerId) {
      throw new Error('Cannot create service ticket without a customer. Please assign a project to the time entries first.');
    }
    
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    const ticketLocation = params.location || '';
    const targetBillingKey = params.billingKey ?? '_::_::_';
    
    // Find existing tickets matching date+user+customer+project+location (may be multiple with different billing keys)
    let query = supabase
      .from(tableName)
      .select('id, header_overrides')
      .eq('date', params.date)
      .eq('user_id', params.userId)
      .eq('customer_id', params.customerId)
      .eq('location', ticketLocation);
    if (params.projectId) {
      query = query.eq('project_id', params.projectId);
    }
    const { data: candidates, error: findError } = await query;
    
    if (findError) {
      console.error('Error finding ticket:', findError);
      throw findError;
    }
    
    const getRecordBillingKey = (et: { header_overrides?: unknown }): string => {
      const ov = (et.header_overrides as Record<string, string> | null) ?? {};
      return buildBillingKey(ov.approver ?? '', ov.po_afe ?? '', ov.cc ?? '');
    };
    const existing = candidates?.find(et => getRecordBillingKey(et) === targetBillingKey);
    if (existing) {
      return { id: existing.id };
    }
    
    // Look up user's initials for proper tracking
    let employeeInitials: string | null = null;
    const { data: userData } = await supabase
      .from('users')
      .select('first_name, last_name')
      .eq('id', params.userId)
      .single();
    
    if (userData?.first_name && userData?.last_name) {
      employeeInitials = `${userData.first_name[0]}${userData.last_name[0]}`.toUpperCase();
    }
    if (!employeeInitials) {
      employeeInitials = 'XX'; // fallback when user has no first/last name; DB requires NOT NULL
    }
    
    // Parse billingKey to set header_overrides (approver::poAfe::cc)
    const [approver, poAfe, cc] = targetBillingKey.split('::');
    const insertData: Record<string, unknown> = {
      date: params.date,
      user_id: params.userId,
      customer_id: params.customerId,
      project_id: params.projectId ?? null,
      location: ticketLocation,
      workflow_status: 'draft',
      employee_initials: employeeInitials,
    };
    if (targetBillingKey !== '_::_::_') {
      insertData.header_overrides = {
        approver: approver || '_',
        po_afe: poAfe || '_',
        cc: cc || '_',
      };
    }
    const { data: newTicket, error: createError } = await supabase
      .from(tableName)
      .insert(insertData)
      .select('id')
      .single();
    
    if (createError) {
      console.error('Error creating ticket:', createError);
      throw createError;
    }
    
    return { id: newTicket.id };
  },

  /**
   * When a time entry is saved, sync approver/po_afe/cc to the service ticket's header_overrides.
   * Only updates draft or rejected tickets - submitted/approved tickets are not modified.
   * Matches by project > location > billing key (hierarchy for ticket grouping).
   */
  async syncTicketHeaderFromTimeEntry(params: {
    date: string;
    userId: string;
    customerId: string | null;
    projectId?: string | null;
    location?: string | null;
    approver?: string | null;
    po_afe?: string | null;
    cc?: string | null;
    other?: string | null;
    isDemo?: boolean;
  }): Promise<void> {
    if (!params.customerId) return;
    const tableName = params.isDemo ? 'service_tickets_demo' : 'service_tickets';
    const ticketLocation = params.location ?? '';
    const targetBillingKey = buildBillingKey(params.approver ?? '', params.po_afe ?? '', params.cc ?? '');
    let query = supabase
      .from(tableName)
      .select('id, header_overrides, workflow_status')
      .eq('date', params.date)
      .eq('user_id', params.userId)
      .eq('customer_id', params.customerId)
      .eq('location', ticketLocation);
    if (params.projectId) {
      query = query.eq('project_id', params.projectId);
    }
    const { data: candidates, error: findError } = await query;
    if (findError || !candidates?.length) return;
    const getRecordBillingKey = (et: { header_overrides?: unknown }): string => {
      const ov = (et.header_overrides as Record<string, string> | null) ?? {};
      return buildBillingKey(ov.approver ?? '', ov.po_afe ?? '', ov.cc ?? '');
    };
    const ticket = candidates.find(et => getRecordBillingKey(et) === targetBillingKey);
    if (!ticket || ticket.workflow_status !== 'draft' && ticket.workflow_status !== 'rejected') return;
    const existing = (ticket.header_overrides as Record<string, unknown>) ?? {};
    const merged = {
      ...existing,
      approver: params.approver ?? '',
      po_afe: params.po_afe ?? '',
      cc: params.cc ?? '',
      other: params.other ?? '',
    };
    await supabase.from(tableName).update({ header_overrides: merged }).eq('id', ticket.id);
  },

  /**
   * After a time entry is removed, delete the service ticket if no billable entries remain
   * for that ticket (same project, location, billing key). Hierarchy: Project > Location > PO/AFE/CC.
   */
  async deleteTicketIfNoTimeEntriesFor(params: {
    date: string;
    userId: string;
    customerId: string | null;
    projectId?: string | null;
    location?: string | null;
    approver?: string | null;
    po_afe?: string | null;
    cc?: string | null;
  }, isDemo: boolean = false): Promise<void> {
    if (!params.customerId) return;

    const { date, userId, customerId, projectId, location, approver, po_afe, cc } = params;
    const ticketLocation = location ?? '';
    const targetBillingKey = buildBillingKey(approver ?? '', po_afe ?? '', cc ?? '');

    // Count remaining billable entries for this specific ticket (project + location + billing)
    if (!projectId) return; // Need projectId to identify the ticket
    const { count: entryCount, error: countError } = await supabase
      .from('time_entries')
      .select('*', { count: 'exact', head: true })
      .eq('date', date)
      .eq('user_id', userId)
      .eq('project_id', projectId)
      .eq('location', ticketLocation)
      .eq('approver', approver ?? '')
      .eq('po_afe', po_afe ?? '')
      .eq('cc', cc ?? '')
      .eq('billable', true)
      .eq('is_demo', isDemo);
    if (countError || (entryCount != null && entryCount > 0)) return;

    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    let findQuery = supabase
      .from(tableName)
      .select('id, header_overrides')
      .eq('date', date)
      .eq('user_id', userId)
      .eq('customer_id', customerId)
      .eq('location', ticketLocation);
    if (projectId) findQuery = findQuery.eq('project_id', projectId);
    const { data: tickets, error: findError } = await findQuery;

    if (findError || !tickets?.length) return;

    const getRecordBillingKey = (t: { header_overrides?: unknown }) => {
      const ov = (t.header_overrides as Record<string, string> | null) ?? {};
      return buildBillingKey(ov.approver ?? '', ov.po_afe ?? '', ov.cc ?? '');
    };
    const matching = tickets.filter(t => getRecordBillingKey(t) === targetBillingKey);
    const legacyKey = '_::_::_';
    const toDelete = matching.length > 0 ? matching : tickets.filter(t => getRecordBillingKey(t) === legacyKey);

    for (const ticket of toDelete) {
      await serviceTicketExpensesService.deleteByTicketId(ticket.id);
      const { error: delError } = await supabase.from(tableName).delete().eq('id', ticket.id);
      if (delError) console.error('Error deleting service ticket:', delError);
    }
  },

  /**
   * When customer info is updated, sync draft and rejected service tickets with the new customer data.
   * Submitted or approved tickets are not updated.
   * Updates header_overrides so draft/rejected tickets display the new address, contact info, etc.
   */
  async updateDraftRejectedTicketsWithCustomerInfo(
    customerId: string,
    customerData: {
      name?: string;
      contact_name?: string;
      email?: string;
      phone?: string;
      address?: string;
      city?: string;
      state?: string;
      zip_code?: string;
      service_location?: string;
      location_code?: string;
      po_number?: string;
      approver_name?: string;
    }
  ): Promise<void> {
    const customerOverrides: Record<string, string> = {};
    if (customerData.name != null) customerOverrides.customer_name = customerData.name;
    if (customerData.contact_name != null) customerOverrides.contact_name = customerData.contact_name;
    if (customerData.email != null) customerOverrides.email = customerData.email;
    if (customerData.phone != null) customerOverrides.phone = customerData.phone;
    if (customerData.address != null) customerOverrides.address = customerData.address;
    if (customerData.city != null || customerData.state != null) {
      customerOverrides.city_state = [customerData.city, customerData.state].filter(Boolean).join(', ');
    }
    if (customerData.zip_code != null) customerOverrides.zip_code = customerData.zip_code;
    if (customerData.service_location != null) customerOverrides.service_location = customerData.service_location;
    if (customerData.location_code != null) customerOverrides.location_code = customerData.location_code;
    if (customerData.po_number != null) customerOverrides.po_number = customerData.po_number;
    if (customerData.approver_name != null) customerOverrides.approver = customerData.approver_name;

    if (Object.keys(customerOverrides).length === 0) return;

    for (const isDemo of [false, true]) {
      const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
      const { data: tickets, error: fetchError } = await supabase
        .from(tableName)
        .select('id, header_overrides, ticket_number')
        .eq('customer_id', customerId)
        .in('workflow_status', ['draft', 'rejected'])
        .is('ticket_number', null);

      if (fetchError) {
        console.warn('Failed to fetch draft/rejected tickets for customer sync:', fetchError);
        continue;
      }

      for (const ticket of tickets || []) {
        if ((ticket as any).ticket_number) continue; // Never touch approved/exported tickets
        const existing = (ticket.header_overrides as Record<string, string> | null) ?? {};
        const merged = { ...existing, ...customerOverrides };
        const { error: updateError } = await supabase
          .from(tableName)
          .update({ header_overrides: merged })
          .eq('id', ticket.id);
        if (updateError) {
          console.warn(`Failed to update ticket ${ticket.id} with customer info:`, updateError);
        }
      }
    }
  },

  /**
   * Update workflow status for a service ticket
   * @param ticketId - The ID of the ticket record to update
   * @param workflowStatus - The new workflow status
   * @param isDemo - If true, updates the demo table
   * @param rejectionNotes - Optional reason for rejection (shown to user when they open the ticket in Drafts)
   */
  async updateWorkflowStatus(ticketId: string, workflowStatus: string, isDemo: boolean = false, rejectionNotes?: string | null): Promise<void> {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    const updatePayload: Record<string, unknown> = { workflow_status: workflowStatus };
    if (workflowStatus === 'rejected') {
      updatePayload.rejected_at = new Date().toISOString();
      updatePayload.rejection_notes = rejectionNotes ?? null;
    } else {
      updatePayload.rejection_notes = null;
    }
    const { error } = await supabase
      .from(tableName)
      .update(updatePayload)
      .eq('id', ticketId);

    if (error) {
      console.error('Error updating workflow status:', error);
      throw error;
    }
  },

  /**
   * Update service ticket with PDF export info
   */
  async markPdfExported(ticketId: string, pdfUrl: string | null, isDemo: boolean = false): Promise<void> {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    
    const { error } = await supabase
      .from(tableName)
      .update({ 
        workflow_status: 'pdf_exported',
        pdf_exported_at: new Date().toISOString(),
        pdf_url: pdfUrl 
      })
      .eq('id', ticketId);
    
    if (error) {
      console.error('Error marking PDF exported:', error);
      throw error;
    }
  },

  /**
   * Update service ticket with QuickBooks invoice info
   */
  async markQboCreated(ticketId: string, qboInvoiceId: string, qboInvoiceNumber: string, isDemo: boolean = false): Promise<void> {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    
    const { error } = await supabase
      .from(tableName)
      .update({ 
        workflow_status: 'qbo_created',
        qbo_invoice_id: qboInvoiceId,
        qbo_invoice_number: qboInvoiceNumber
      })
      .eq('id', ticketId);
    
    if (error) {
      console.error('Error marking QBO created:', error);
      throw error;
    }
  },

  /**
   * Mark ticket as sent to CNRL
   */
  async markSentToCnrl(ticketId: string, isDemo: boolean = false): Promise<void> {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    
    const { error } = await supabase
      .from(tableName)
      .update({ 
        workflow_status: 'sent_to_cnrl',
        sent_to_cnrl_at: new Date().toISOString()
      })
      .eq('id', ticketId);
    
    if (error) {
      console.error('Error marking sent to CNRL:', error);
      throw error;
    }
  },

  /**
   * Mark ticket as CNRL approved
   */
  async markCnrlApproved(ticketId: string, isDemo: boolean = false): Promise<void> {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    
    const { error } = await supabase
      .from(tableName)
      .update({ 
        workflow_status: 'cnrl_approved',
        cnrl_approved_at: new Date().toISOString()
      })
      .eq('id', ticketId);
    
    if (error) {
      console.error('Error marking CNRL approved:', error);
      throw error;
    }
  },

  /**
   * Mark ticket as submitted to CNRL invoicing
   */
  async markSubmittedToCnrl(ticketId: string, notes: string | null, isDemo: boolean = false): Promise<void> {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    
    const { error } = await supabase
      .from(tableName)
      .update({ 
        workflow_status: 'submitted_to_cnrl',
        submitted_to_cnrl_at: new Date().toISOString(),
        cnrl_notes: notes
      })
      .eq('id', ticketId);
    
    if (error) {
      console.error('Error marking submitted to CNRL:', error);
      throw error;
    }
  },

  /**
   * Get service ticket by ID with workflow data
   */
  async getById(ticketId: string, isDemo: boolean = false) {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    
    const { data, error } = await supabase
      .from(tableName)
      .select('*')
      .eq('id', ticketId)
      .single();
    
    if (error) {
      console.error('Error getting service ticket:', error);
      throw error;
    }
    
    return data;
  },

  /**
   * Get approved service tickets ready for PDF export (invoicing).
   * Criteria: workflow_status='approved', ticket_number not null, is_discarded=false.
   */
  async getTicketsReadyForExport(isDemo: boolean = false) {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    const { data, error } = await supabase
      .from(tableName)
      .select('id, ticket_number, date, user_id, customer_id, project_id, location, is_edited, edited_hours, header_overrides')
      .eq('workflow_status', 'approved')
      .eq('is_discarded', false)
      .not('ticket_number', 'is', null)
      .order('date', { ascending: false });

    if (error) {
      console.error('Error getting tickets ready for export:', error);
      throw error;
    }
    return data || [];
  },

  /**
   * Get all service tickets with workflow data
   */
  async getAllTickets(filters?: { 
    startDate?: string; 
    endDate?: string; 
    userId?: string;
    workflowStatus?: string;
  }, isDemo: boolean = false) {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    
    let query = supabase
      .from(tableName)
      .select('*')
      .not('ticket_number', 'is', null)
      .order('date', { ascending: false });
    
    if (filters?.startDate) {
      query = query.gte('date', filters.startDate);
    }
    if (filters?.endDate) {
      query = query.lte('date', filters.endDate);
    }
    if (filters?.userId) {
      query = query.eq('user_id', filters.userId);
    }
    if (filters?.workflowStatus) {
      query = query.eq('workflow_status', filters.workflowStatus);
    }
    
    const { data, error } = await query;
    
    if (error) {
      console.error('Error getting service tickets:', error);
      throw error;
    }
    
    return data;
  },

  /** Count rejected tickets for a user (for sidebar notification) - excludes trashed */
  async getRejectedCountForUser(userId: string, isDemo: boolean = false): Promise<number> {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    const { count, error } = await supabase
      .from(tableName)
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('workflow_status', 'rejected')
      .or('is_discarded.eq.false,is_discarded.is.null');
    if (error) return 0;
    return count ?? 0;
  },

  /** Count of tickets in Submitted tab that were resubmitted after rejection (admin only – for sidebar notification) - excludes trashed */
  async getResubmittedCountForAdmin(isDemo: boolean = false): Promise<number> {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    const { count, error } = await supabase
      .from(tableName)
      .select('*', { count: 'exact', head: true })
      .not('rejected_at', 'is', null)
      .not('workflow_status', 'in', '("draft","rejected")')
      .or('is_discarded.eq.false,is_discarded.is.null');
    if (error) return 0;
    return count ?? 0;
  },

  /**
   * Permanently delete a service ticket from the database (admin only, when in trash).
   * Deletes: expenses, ticket record, and the underlying time entries so the ticket doesn't reappear as "new".
   */
  async deletePermanently(ticketId: string, isDemo: boolean = false): Promise<void> {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    const { data: ticket, error: fetchError } = await supabase
      .from(tableName)
      .select('id, date, user_id, customer_id')
      .eq('id', ticketId)
      .single();

    if (fetchError || !ticket) {
      throw fetchError || new Error('Ticket not found');
    }

    const { date, user_id, customer_id } = ticket;

    await serviceTicketExpensesService.deleteByTicketId(ticketId);

    const { error: delError } = await supabase.from(tableName).delete().eq('id', ticketId);
    if (delError) throw delError;

    // Delete time entries that this ticket was built from so it doesn't reappear as "new"
    // Time entries use project_id; get projects for this customer first
    if (date && user_id && customer_id) {
      const { data: projs } = await supabase.from('projects').select('id').eq('customer_id', customer_id);
      const projectIds = (projs ?? []).map((p: { id: string }) => p.id);
      if (projectIds.length > 0) {
        const { error: entriesError } = await supabase
          .from('time_entries')
          .delete()
          .eq('date', date)
          .eq('user_id', user_id)
          .in('project_id', projectIds)
          .eq('billable', true)
          .eq('is_demo', isDemo);
        if (entriesError) console.warn('Failed to delete time entries for ticket:', entriesError);
      }
    }
  },
};

export const serviceTicketExpensesService = {
  async getByTicketId(ticketId: string) {
    const { data, error } = await supabase
      .from('service_ticket_expenses')
      .select('*')
      .eq('service_ticket_id', ticketId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data;
  },

  async create(expense: {
    service_ticket_id: string;
    expense_type: 'Travel' | 'Subsistence' | 'Expenses' | 'Equipment';
    description: string;
    quantity: number;
    rate: number;
    unit?: string;
  }) {
    const { data, error } = await supabase
      .from('service_ticket_expenses')
      .insert(expense)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async update(id: string, updates: {
    expense_type?: 'Travel' | 'Subsistence' | 'Expenses' | 'Equipment';
    description?: string;
    quantity?: number;
    rate?: number;
    unit?: string;
  }) {
    const { data, error } = await supabase
      .from('service_ticket_expenses')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async delete(id: string) {
    const { error } = await supabase
      .from('service_ticket_expenses')
      .delete()
      .eq('id', id);

    if (error) throw error;
  },

  async deleteByTicketId(ticketId: string) {
    const { error } = await supabase
      .from('service_ticket_expenses')
      .delete()
      .eq('service_ticket_id', ticketId);

    if (error) throw error;
  },
};

export const bugReportsService = {
  async create(report: {
    user_id?: string;
    user_email?: string;
    user_name?: string;
    title: string;
    description: string;
    priority?: 'low' | 'medium' | 'high' | 'critical';
  }) {
    const { data, error } = await supabase
      .from('bug_reports')
      .insert({
        user_id: report.user_id || null,
        user_email: report.user_email || null,
        user_name: report.user_name || null,
        title: report.title,
        description: report.description,
        priority: report.priority || 'medium',
        status: 'open',
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async getAll(userId?: string) {
    let query = supabase
      .from('bug_reports')
      .select('*')
      .order('created_at', { ascending: false });

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data;
  },

  async updateStatus(id: string, status: string) {
    const updateData: any = { status };
    if (status === 'resolved' || status === 'closed') {
      updateData.resolved_at = new Date().toISOString();
    }
    
    const { data, error } = await supabase
      .from('bug_reports')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return { data, error: null };
  },

  async update(id: string, updates: any) {
    const { data, error } = await supabase
      .from('bug_reports')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async delete(id: string) {
    const { error } = await supabase
      .from('bug_reports')
      .delete()
      .eq('id', id);

    if (error) throw error;
  },
};
