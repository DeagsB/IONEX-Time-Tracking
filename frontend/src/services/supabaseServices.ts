import { supabase } from '../lib/supabaseClient';

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
};

export const customersService = {
  async getAll(userId?: string) {
    // Get current user from auth
    const { data: { user: authUser } = { user: null } } = await supabase.auth.getUser();
    const currentUserId = userId || authUser?.id;

    if (!currentUserId) {
      const { data, error } = await supabase
        .from('customers')
        .select('*, projects(*), created_by')
        .eq('is_private', false)
        .order('name');
      if (error) throw error;
      return data;
    }

    // Get user role to determine filtering
    let userRole: string | undefined;
    const { data: userData } = await supabase
      .from('users')
      .select('role')
      .eq('id', currentUserId)
      .single();
    userRole = userData?.role;

    // If user is ADMIN, show all customers
    if (userRole === 'ADMIN') {
      const { data, error } = await supabase
        .from('customers')
        .select('*, projects(*), created_by')
        .order('name');
      if (error) throw error;
      return data;
    }

    // For regular users, show their own customers + assigned customers
    // Get assigned customer IDs
    const { data: assignments, error: assignmentsError } = await supabase
      .from('customer_user_assignments')
      .select('customer_id')
      .eq('user_id', currentUserId);

    if (assignmentsError) throw assignmentsError;

    // Get customer IDs: own (created_by = currentUserId) + assigned
    const assignedCustomerIds = assignments?.map(a => a.customer_id) || [];
    
    // Build query: own customers OR assigned customers
    let query = supabase
      .from('customers')
      .select('*, projects(*), created_by');

    if (assignedCustomerIds.length > 0) {
      // Use OR to get own customers OR assigned customers
      query = query.or(`created_by.eq.${currentUserId},id.in.(${assignedCustomerIds.join(',')})`);
    } else {
      // Only own customers if no assignments
      query = query.eq('created_by', currentUserId);
    }

    const { data, error } = await query.order('name');

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
    
    const customerData = {
      ...customer,
      created_by: authUser?.id || null, // Set created_by to current user
      is_private: false, // Always set to false (private option removed)
    };

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
    const finalUpdates = {
      ...updateData,
      is_private: false, // Always set to false (private option removed)
    };
    
    const { data, error } = await supabase
      .from('customers')
      .update(finalUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async delete(id: string) {
    const { error } = await supabase
      .from('customers')
      .delete()
      .eq('id', id);

    if (error) throw error;
  },
};

export const projectsService = {
  async getAll(userId?: string) {
    // Get current user from auth
    const { data: { user: authUser } } = await supabase.auth.getUser();
    const currentUserId = userId || authUser?.id;

    // Get user role to determine filtering
    let userRole: string | undefined;
    if (currentUserId) {
      const { data: userData } = await supabase
        .from('users')
        .select('role')
        .eq('id', currentUserId)
        .single();
      userRole = userData?.role;
    }

    // If user is ADMIN, show all projects
    if (userRole === 'ADMIN') {
      let query = supabase
        .from('projects')
        .select(`
          *,
          customer:customers(*)
        `)
        .order('name');

      const { data, error } = await query;
      if (error) throw error;
      return data;
    }

    // For regular users, show their own projects + assigned projects
    // Get assigned project IDs
    const { data: assignments, error: assignmentsError } = await supabase
      .from('project_user_assignments')
      .select('project_id')
      .eq('user_id', currentUserId);

    if (assignmentsError) throw assignmentsError;

    // Get project IDs: own (created_by = currentUserId) + assigned
    const assignedProjectIds = assignments?.map(a => a.project_id) || [];
    
    // Build query: own projects OR assigned projects
    let query = supabase
      .from('projects')
      .select(`
        *,
        customer:customers(*)
      `);

    if (assignedProjectIds.length > 0) {
      // Use OR to get own projects OR assigned projects
      query = query.or(`created_by.eq.${currentUserId},id.in.(${assignedProjectIds.join(',')})`);
    } else {
      // Only own projects if no assignments
      query = query.eq('created_by', currentUserId);
    }

    const { data, error } = await query.order('name');

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

  async delete(id: string) {
    const { error } = await supabase
      .from('projects')
      .delete()
      .eq('id', id);

    if (error) throw error;
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
          approver_po_afe,
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
    
    // Get all used sequence numbers for this employee this year (excluding nulls from unassigned tickets)
    const { data, error } = await supabase
      .from(tableName)
      .select('sequence_number')
      .eq('employee_initials', userInitials.toUpperCase())
      .eq('year', year)
      .not('sequence_number', 'is', null)
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
    totalHours: number;
    totalAmount: number;
    isDemo?: boolean;
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
        const { data, error } = await supabase
          .from(tableName)
          .insert({
            ticket_number: ticketNumber,
            employee_initials: ticket.employeeInitials,
            year: ticket.year,
            sequence_number: ticket.sequenceNumber,
            date: ticket.date,
            customer_id: ticket.customerId,
            user_id: ticket.userId,
            project_id: ticket.projectId,
            total_hours: ticket.totalHours,
            total_amount: ticket.totalAmount,
            status: 'draft',
          })
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
   * Update ticket number for an existing service ticket record
   * @param ticketId - The ID of the ticket record to update
   * @param ticketNumber - The new ticket number (or null to unassign)
   * @param isDemo - If true, updates the demo table; otherwise updates the regular table
   */
  async updateTicketNumber(ticketId: string, ticketNumber: string | null, isDemo: boolean = false): Promise<void> {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    
    const updateData: any = {};
    
    if (ticketNumber === null) {
      // Unassign ticket number
      updateData.ticket_number = null;
      updateData.sequence_number = null;
      updateData.year = null;
    } else {
      // Assign ticket number
      updateData.ticket_number = ticketNumber;
      const year = new Date().getFullYear() % 100;
      const sequenceMatch = ticketNumber.match(/\d{3}$/);
      const sequenceNumber = sequenceMatch ? parseInt(sequenceMatch[0]) : null;
      updateData.year = year;
      updateData.sequence_number = sequenceNumber;
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
   * Update workflow status for a service ticket
   * @param ticketId - The ID of the ticket record to update
   * @param workflowStatus - The new workflow status
   * @param isDemo - If true, updates the demo table
   */
  async updateWorkflowStatus(ticketId: string, workflowStatus: string, isDemo: boolean = false): Promise<void> {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    
    const { error } = await supabase
      .from(tableName)
      .update({ workflow_status: workflowStatus })
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
