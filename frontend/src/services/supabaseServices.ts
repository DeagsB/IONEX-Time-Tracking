import { supabase } from '../lib/supabaseClient';
import { buildApproverPoAfe, buildBillingKey, buildGroupingKey } from '../utils/serviceTickets';

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
          location,
          po_afe,
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

  async bulkMove(ids: string[], newDate: string, dayOffset: number) {
    // Move multiple time entries to a new date, adjusting start_time and end_time by the day offset
    const results = [];
    for (const id of ids) {
      // First get the entry to calculate new times
      const { data: entry, error: fetchError } = await supabase
        .from('time_entries')
        .select('*')
        .eq('id', id)
        .single();
      
      if (fetchError) throw fetchError;
      
      const updates: any = { date: newDate };
      
      // Adjust start_time and end_time by the day offset if they exist
      if (entry.start_time) {
        const startDate = new Date(entry.start_time);
        startDate.setDate(startDate.getDate() + dayOffset);
        updates.start_time = startDate.toISOString();
      }
      if (entry.end_time) {
        const endDate = new Date(entry.end_time);
        endDate.setDate(endDate.getDate() + dayOffset);
        updates.end_time = endDate.toISOString();
      }
      
      const { data, error } = await supabase
        .from('time_entries')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
      
      if (error) throw error;
      results.push(data);
    }
    return results;
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
    const rateFields = ['shop_pay_rate', 'field_pay_rate', 'shop_ot_pay_rate', 'field_ot_pay_rate', 'internal_rate'];
    const hasRateChange = rateFields.some((f) => updates[f] !== undefined);

    const { data, error } = await supabase
      .from('employees')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    if (hasRateChange && data) {
      await supabase.from('pay_rate_history').upsert(
        {
          employee_id: id,
          effective_date: new Date().toISOString().split('T')[0],
          shop_pay_rate: data.shop_pay_rate ?? 0,
          field_pay_rate: data.field_pay_rate ?? 0,
          shop_ot_pay_rate: data.shop_ot_pay_rate ?? 0,
          field_ot_pay_rate: data.field_ot_pay_rate ?? 0,
          internal_rate: data.internal_rate ?? 0,
        },
        { onConflict: 'employee_id,effective_date' }
      );
    }

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

export const payRateHistoryService = {
  async getAll() {
    const { data, error } = await supabase
      .from('pay_rate_history')
      .select('*')
      .order('effective_date', { ascending: true });
    if (error) throw error;
    return data || [];
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
        project:projects!time_entries_project_id_fkey(id, name, project_number, location, po_afe, customer:customers!projects_customer_id_fkey(id, name))
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
      .select('id, user_id, date, total_hours, total_amount, customer_id, project_id, location, header_overrides, is_edited, edited_hours, workflow_status, rejected_at')
      .gte('date', startDate)
      .lte('date', endDate)
      .or('is_discarded.is.null,is_discarded.eq.false');

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
      .order('date', { ascending: false })
      .order('created_at', { ascending: true }); // Within same date: first-entered first (input order)

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
    
    // Reserved sequence ranges by initials and year - these numbers are blocked and cannot be assigned
    // Format: { 'INITIALS': { year: lastReservedSequence } }
    // New tickets will start AFTER the reserved range (e.g., HV in 2026 starts at 50)
    const RESERVED_SEQUENCES: Record<string, Record<number, number>> = {
      'HV': { 26: 49 },  // HV_26001 - HV_26049 are reserved, start at HV_26050
      'CG': { 26: 19 },  // CG_26001 - CG_26019 are reserved, start at CG_26020
    };
    
    // Get the minimum starting sequence for this initials/year (1 if no reservation)
    const initialsUpper = userInitials.toUpperCase();
    const reservedUpTo = RESERVED_SEQUENCES[initialsUpper]?.[year] ?? 0;
    const minStartSequence = reservedUpTo + 1; // Start after the reserved range
    
    // Get all used sequence numbers for this employee this year
    // Include discarded tickets since their sequence numbers are still reserved by unique constraints
    const { data, error } = await supabase
      .from(tableName)
      .select('sequence_number')
      .eq('employee_initials', initialsUpper)
      .eq('year', year)
      .not('sequence_number', 'is', null)
      .order('sequence_number', { ascending: true });

    if (error) {
      console.error(`[getNextTicketNumber] Error querying ${tableName}:`, error);
      throw error;
    }

    let nextSequence = minStartSequence;
    
    if (data && data.length > 0) {
      // Build a set of used sequence numbers
      const usedSequences = new Set(data.map(d => d.sequence_number));
      
      // Find the first available sequence number starting from minStartSequence
      nextSequence = minStartSequence;
      while (usedSequences.has(nextSequence)) {
        nextSequence++;
      }
      
      console.log(`[getNextTicketNumber] ${isDemo ? 'DEMO' : 'REGULAR'} - Table: ${tableName}, Reserved up to: ${reservedUpTo}, Min start: ${minStartSequence}, Used sequences: [${Array.from(usedSequences).sort((a, b) => a - b).join(', ')}], Next available: ${nextSequence}`);
    } else {
      console.log(`[getNextTicketNumber] ${isDemo ? 'DEMO' : 'REGULAR'} - Table: ${tableName}, Reserved up to: ${reservedUpTo}, No existing tickets, starting at ${minStartSequence}`);
    }
    
    const paddedSequence = String(nextSequence).padStart(3, '0');
    const ticketNumber = `${initialsUpper}_${year}${paddedSequence}`;
    
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
    headerOverrides?: Record<string, string | number | string[]>;
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
          // Get all used sequence numbers and find first gap (include discarded - unique constraints still apply)
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
        // Get all used sequence numbers and find first gap (include discarded - unique constraints still apply)
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
   * @param approvalHours - When approving, pass hours so they are persisted. Fixes approved tickets showing 0.00
   *   when the draft had no saved hours or when time entries are later deleted.
   */
  async updateTicketNumber(
    ticketId: string,
    ticketNumber: string | null,
    isDemo: boolean = false,
    approvedByAdminId?: string,
    headerOverrides?: Record<string, string | number | string[]>,
    approvalHours?: {
      totalHours: number;
      totalAmount: number;
      editedHours: Record<string, number | number[]>;
      editedDescriptions: Record<string, string[]>;
    }
  ): Promise<void> {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';

    const updateData: any = {};

    if (ticketNumber === null) {
      // Unassign ticket number only - keep workflow_status and approved_by_admin_id intact
      // The ticket stays approved, just without an assigned ID until one is reassigned
      updateData.ticket_number = null;
      updateData.sequence_number = null;
      updateData.year = null;
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
      // Persist hours at approval time so ticket retains them even if time entries are later deleted
      if (approvalHours && approvalHours.totalHours > 0) {
        updateData.total_hours = approvalHours.totalHours;
        updateData.total_amount = approvalHours.totalAmount;
        // Don't set is_edited=true - that's for manual edits only.
        // The presence of edited_hours/edited_descriptions is enough to load saved data.
        updateData.is_edited = false;
        updateData.edited_hours = approvalHours.editedHours;
        updateData.edited_descriptions = approvalHours.editedDescriptions;
        // Clear per-entry overrides - not needed once approved and can cause "manually edited" label
        updateData.edited_entry_overrides = null;
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

    // When assigning a ticket number, permanently delete any other draft/rejected records for the same logical ticket
    // so we don't leave a duplicate draft row (same date/user/customer/project/location). They are removed, not trashed.
    if (ticketNumber != null) {
      await this.deleteOtherDraftRecordsForTicket(ticketId, isDemo);
    }
  },

  /**
   * Permanently delete other draft/rejected records that match the same logical ticket (date, user, customer, project, location)
   * as the given approved record. Prevents duplicate draft row after admin approval; removed records do not show in trash.
   */
  async deleteOtherDraftRecordsForTicket(approvedTicketId: string, isDemo: boolean = false): Promise<void> {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    const { data: approved, error: fetchError } = await supabase
      .from(tableName)
      .select('date, user_id, customer_id, project_id, location, header_overrides')
      .eq('id', approvedTicketId)
      .single();
    if (fetchError || !approved) return;

    let query = supabase
      .from(tableName)
      .select('id, location, header_overrides')
      .neq('id', approvedTicketId)
      .eq('date', approved.date)
      .eq('user_id', approved.user_id)
      .eq('customer_id', approved.customer_id)
      .is('ticket_number', null)
      .or('is_discarded.eq.false,is_discarded.is.null');
      
    if (approved.project_id != null && approved.project_id !== '') {
      query = query.eq('project_id', approved.project_id);
    } else {
      query = query.is('project_id', null);
    }

    const { data: others, error: listError } = await query;
    if (listError) {
      console.warn('deleteOtherDraftRecordsForTicket list:', listError);
      return;
    }
    
    // Get PO/AFE for the approved ticket
    let approvedPo: string | undefined;
    if (approved.header_overrides) {
      const overrides = typeof approved.header_overrides === 'string' 
        ? JSON.parse(approved.header_overrides) 
        : approved.header_overrides;
      approvedPo = overrides?.po_afe?.trim().toLowerCase();
    }
    
    // Filter by location and PO/AFE in memory to avoid PostgREST empty string syntax issues
    const loc = approved.location ?? '';
    const ids = (others ?? [])
      .filter((r: { id: string, location?: string | null, header_overrides?: any }) => {
        const matchesLoc = (r.location ?? '') === loc;
        if (!matchesLoc) return false;
        
        // Also check PO/AFE match to avoid deleting intentionally split tickets
        let rPo: string | undefined;
        if (r.header_overrides) {
          const overrides = typeof r.header_overrides === 'string'
            ? JSON.parse(r.header_overrides)
            : r.header_overrides;
          rPo = overrides?.po_afe?.trim().toLowerCase();
        }
        
        return rPo === approvedPo;
      })
      .map((r: { id: string }) => r.id);
      
    for (const id of ids) {
      try {
        await this.deletePermanently(id, isDemo);
      } catch (e) {
        console.warn('deleteOtherDraftRecordsForTicket delete:', id, e);
      }
    }
  },

  /**
   * Get or create a service ticket record for a given date/user/customer/project/location combination.
   * Hierarchy: Project > Location > PO/AFE + Approver (CC excluded - different coding does NOT create new tickets).
   * When groupingKey is provided (approver::poAfe::_), matches by approver and poAfe only.
   * Requires a valid customerId.
   */
  async getOrCreateTicket(params: {
    date: string;
    userId: string;
    customerId: string | null;
    projectId?: string | null;
    location?: string;
    billingKey?: string;
    /** When creating a new record, use these values for header_overrides instead of parsing from billingKey (which only has po_afe) */
    headerOverrides?: Record<string, string | number | string[]>;
  }, isDemo: boolean = false): Promise<{ id: string }> {
    // Don't create tickets without a customer - they need a project/customer to be valid
    if (!params.customerId) {
      throw new Error('Cannot create service ticket without a customer. Please assign a project to the time entries first.');
    }
    
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    const ticketLocation = params.location || '';
    const targetBillingKey = params.billingKey ?? '_::_::_';
    
    // Find existing tickets matching date+user+customer+project+location (location is a grouping dimension)
    const getRecordGroupingKey = (et: { header_overrides?: unknown }): string => {
      const ov = (et.header_overrides as Record<string, string> | null) ?? {};
      return (ov._grouping_key as string) ?? buildGroupingKey(ov.po_afe ?? '');
    };
    
    // Build query with optional location and project filters (include workflow_status for draft reuse)
    const buildQuery = (includeLocation: boolean) => {
      let q = supabase
        .from(tableName)
        .select('id, header_overrides, location, workflow_status')
        .eq('date', params.date)
        .eq('user_id', params.userId)
        .eq('customer_id', params.customerId);
      if (params.projectId) {
        q = q.eq('project_id', params.projectId);
      }
      if (includeLocation && ticketLocation) {
        q = q.eq('location', ticketLocation);
      }
      return q;
    };
    
    // First: try with location filter for exact match
    if (ticketLocation) {
      const { data: locCandidates, error: locError } = await buildQuery(true);
      if (!locError && locCandidates?.length) {
        const match = locCandidates.find(et => getRecordGroupingKey(et) === targetBillingKey);
        if (match) return { id: match.id };
        // If billing key didn't match but we have candidates with right location, use first one
        if (locCandidates.length === 1) return { id: locCandidates[0].id };
      }
    }
    
    // Fallback: search without location filter (for legacy records with empty location)
    const { data: candidates, error: findError } = await buildQuery(false);
    
    if (findError) {
      console.error('Error finding ticket:', findError);
      throw findError;
    }
    
    const existing = candidates?.find(et => getRecordGroupingKey(et) === targetBillingKey);
    if (existing) {
      // Update the record's location to match the ticket if it was empty
      if (ticketLocation && !(existing as any).location) {
        await supabase.from(tableName).update({ location: ticketLocation }).eq('id', existing.id);
      }
      return { id: existing.id };
    }
    // Last resort: any matching candidate without a location (legacy)
    const legacyMatch = candidates?.find(et => !(et as any).location);
    if (legacyMatch) {
      if (ticketLocation) {
        await supabase.from(tableName).update({ location: ticketLocation }).eq('id', legacyMatch.id);
      }
      return { id: legacyMatch.id };
    }

    // Reuse draft/rejected record when billing key changed (e.g. user edited PO/AFE before approving).
    // Prevents duplicate rows: one approved, one orphan draft with old _grouping_key.
    const ws = (r: { workflow_status?: string | null }) => (r.workflow_status || 'draft') as string;
    const isDraftOrRejected = (et: { workflow_status?: string | null }) =>
      ws(et) === 'draft' || (et as any).workflow_status === 'rejected';
    const draftOrRejected =
      candidates?.find(et => isDraftOrRejected(et) && (!ticketLocation || ((et as any).location ?? '') === ticketLocation)) ??
      candidates?.find(isDraftOrRejected);
    if (draftOrRejected) {
      const ho = params.headerOverrides;
      const existingOv = (draftOrRejected.header_overrides as Record<string, any> | null) ?? {};
      const mergedOverrides: Record<string, any> = {
        ...existingOv,
        _grouping_key: targetBillingKey,
        _billing_key: ho
          ? buildBillingKey(String(ho.approver ?? ''), String(ho.po_afe ?? ''), String(ho.cc ?? ''))
          : targetBillingKey,
      };
      if (ho?.approver != null) mergedOverrides.approver = String(ho.approver ?? '').trim();
      if (ho?.po_afe != null) mergedOverrides.po_afe = String(ho.po_afe ?? '').trim();
      if (ho?.cc != null) mergedOverrides.cc = String(ho.cc ?? '').trim();
      if (ho?.other != null) mergedOverrides.other = String(ho.other ?? '').trim();
      if (ho?.service_location != null) mergedOverrides.service_location = String(ho.service_location ?? '').trim();
      const updatePayload: Record<string, unknown> = { header_overrides: mergedOverrides };
      if (ticketLocation) (updatePayload as any).location = ticketLocation;
      await supabase.from(tableName).update(updatePayload).eq('id', draftOrRejected.id);
      return { id: draftOrRejected.id };
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
    
    // Use provided headerOverrides (from time entries) when creating; otherwise parse from billingKey (grouping key only has po_afe)
    // Always set _grouping_key and _billing_key so record stays matched to ticket when user edits PO/AFE/CC
    const ho = params.headerOverrides;
    let headerOverridesToInsert: Record<string, any> | undefined;
    if (ho && (ho.approver != null || ho.po_afe != null || ho.cc != null || ho.other != null || ho.service_location != null)) {
      headerOverridesToInsert = {
        approver: String(ho.approver ?? '').trim(),
        po_afe: String(ho.po_afe ?? '').trim(),
        cc: String(ho.cc ?? '').trim(),
        ...(ho.other != null ? { other: String(ho.other ?? '').trim() } : {}),
        ...(ho.service_location != null ? { service_location: String(ho.service_location ?? '').trim() } : {}),
        _grouping_key: targetBillingKey,
        _billing_key: buildBillingKey(String(ho.approver ?? ''), String(ho.po_afe ?? ''), String(ho.cc ?? '')),
      };
    } else if (targetBillingKey !== '_::_::_') {
      const [approver, poAfe, cc] = targetBillingKey.split('::');
      headerOverridesToInsert = {
        approver: (approver && approver !== '_') ? approver : '',
        po_afe: (poAfe && poAfe !== '_') ? poAfe : '',
        cc: (cc && cc !== '_') ? cc : '',
        _grouping_key: targetBillingKey,
        _billing_key: targetBillingKey,
      };
    }
    const insertData: Record<string, unknown> = {
      date: params.date,
      user_id: params.userId,
      customer_id: params.customerId,
      project_id: params.projectId ?? null,
      location: ticketLocation,
      workflow_status: 'draft',
      employee_initials: employeeInitials,
    };
    if (headerOverridesToInsert) {
      insertData.header_overrides = headerOverridesToInsert;
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
   * Matches by project > location > billing key.
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
    const targetGroupingKey = buildGroupingKey(params.po_afe ?? '');
    let query = supabase
      .from(tableName)
      .select('id, header_overrides, workflow_status')
      .eq('date', params.date)
      .eq('user_id', params.userId)
      .eq('customer_id', params.customerId);
    if (params.projectId) {
      query = query.eq('project_id', params.projectId);
    }
    if (params.location) {
      query = query.eq('location', params.location);
    }
    const { data: candidates, error: findError } = await query;
    if (findError || !candidates?.length) return;
    const getRecordGroupingKey = (et: { header_overrides?: unknown }): string => {
      const ov = (et.header_overrides as Record<string, string> | null) ?? {};
      return (ov._grouping_key as string) ?? buildGroupingKey(ov.po_afe ?? '');
    };
    const ticket = candidates.find(et => getRecordGroupingKey(et) === targetGroupingKey);
    if (!ticket || ticket.workflow_status !== 'draft' && ticket.workflow_status !== 'rejected') return;
    const existing = (ticket.header_overrides as Record<string, unknown>) ?? {};
    const merged = {
      ...existing,
      _grouping_key: (existing._grouping_key as string) ?? targetGroupingKey,
      _billing_key: (existing._billing_key as string) ?? buildBillingKey(params.approver ?? '', params.po_afe ?? '', params.cc ?? ''),
      service_location: params.location ?? '',
      approver: params.approver ?? '',
      po_afe: params.po_afe ?? '',
      cc: params.cc ?? '',
      other: params.other ?? '',
    };
    await supabase.from(tableName).update({ header_overrides: merged }).eq('id', ticket.id);
  },

  /**
   * After a time entry is removed, delete the service ticket if no billable entries remain
   * for that ticket (same project, po_afe). Location is editable, not a grouping dimension.
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

    const { date, userId, customerId, projectId, po_afe } = params;

    // Count remaining billable entries for this ticket (project + po_afe only)
    if (!projectId) return;
    const { count: entryCount, error: countError } = await supabase
      .from('time_entries')
      .select('*', { count: 'exact', head: true })
      .eq('date', date)
      .eq('user_id', userId)
      .eq('project_id', projectId)
      .eq('po_afe', po_afe ?? '')
      .eq('billable', true)
      .eq('is_demo', isDemo);
    if (countError || (entryCount != null && entryCount > 0)) return;

    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    let findQuery = supabase
      .from(tableName)
      .select('id, header_overrides, ticket_number')
      .eq('date', date)
      .eq('user_id', userId)
      .eq('customer_id', customerId);
    if (projectId) findQuery = findQuery.eq('project_id', projectId);
    const { data: tickets, error: findError } = await findQuery;

    if (findError || !tickets?.length) return;

    const targetGroupingKey = buildGroupingKey(po_afe ?? '');
    const getRecordGroupingKey = (t: { header_overrides?: unknown }) => {
      const ov = (t.header_overrides as Record<string, string> | null) ?? {};
      return (ov._grouping_key as string) ?? buildGroupingKey(ov.po_afe ?? '');
    };
    const matching = tickets.filter(t => getRecordGroupingKey(t) === targetGroupingKey);
    const legacyKey = '_::_::_';
    const toDelete = matching.length > 0 ? matching : tickets.filter(t => getRecordGroupingKey(t) === legacyKey);

    for (const ticket of toDelete) {
      // Skip approved tickets (those with ticket_number) - they should persist even if time entries are deleted
      if ((ticket as { ticket_number?: string }).ticket_number) {
        continue;
      }
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
    const { data, error } = await supabase
      .from(tableName)
      .update(updatePayload)
      .eq('id', ticketId)
      .select('id, workflow_status');

    if (error) {
      console.error('Error updating workflow status:', error);
      throw error;
    }
    if (!data || data.length === 0) {
      throw new Error(`Workflow update failed: no rows updated for ticket ${ticketId}. This may be a permissions issue.`);
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
   * Optional date range filters to match Service Tickets Approved tab.
   */
  async getTicketsReadyForExport(
    isDemo: boolean = false,
    filters?: { startDate?: string; endDate?: string }
  ) {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    let query = supabase
      .from(tableName)
      .select('id, ticket_number, date, user_id, customer_id, project_id, location, is_edited, edited_hours, edited_descriptions, edited_entry_overrides, total_hours, header_overrides')
      .not('workflow_status', 'in', '("draft","rejected")')
      .eq('is_discarded', false)
      .not('ticket_number', 'is', null)
      .order('date', { ascending: false });

    if (filters?.startDate) {
      query = query.gte('date', filters.startDate);
    }
    if (filters?.endDate) {
      query = query.lte('date', filters.endDate);
    }

    const { data, error } = await query;

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

  /**
   * Clear rejected state for all of a user's rejected tickets (set to draft). Admin-only use to clear stuck sidebar notification.
   * Excludes trashed tickets. Fetches IDs then updates each via updateWorkflowStatus so updates use the same path as the app.
   * Returns the number of tickets updated.
   */
  async clearRejectedTicketsForUser(userId: string, isDemo: boolean = false): Promise<number> {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';
    const { data: rows, error: fetchError } = await supabase
      .from(tableName)
      .select('id')
      .eq('user_id', userId)
      .eq('workflow_status', 'rejected')
      .or('is_discarded.eq.false,is_discarded.is.null');
    if (fetchError) {
      throw new Error(`Could not load rejected tickets: ${fetchError.message}`);
    }
    const ids = (rows ?? []).map((r: { id: string }) => r.id);
    for (const id of ids) {
      try {
        await this.updateWorkflowStatus(id, 'draft', isDemo, null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not clear ticket ${id}: ${msg}`);
      }
    }
    return ids.length;
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
   * Deletes: expenses and ticket record. Time entries are preserved (user requested).
   */
  async deletePermanently(ticketId: string, isDemo: boolean = false): Promise<void> {
    const tableName = isDemo ? 'service_tickets_demo' : 'service_tickets';

    // Delete associated expenses first
    await serviceTicketExpensesService.deleteByTicketId(ticketId);

    // Delete the ticket record (time entries are intentionally preserved)
    const { error: delError } = await supabase.from(tableName).delete().eq('id', ticketId);
    if (delError) throw delError;
  },
};

/** App + UI use "Expenses" for the "Other" line type; Postgres CHECK typically allows "Other" only. */
export type ServiceTicketExpenseTypeApp =
  | 'Travel'
  | 'Subsistence'
  | 'Hotel'
  | 'Expenses'
  | 'Equipment';

/** Row from `service_ticket_expenses` with `expense_type` normalized for the app (Other → Expenses). */
export type ServiceTicketExpenseRow = {
  id: string;
  service_ticket_id: string;
  expense_type: ServiceTicketExpenseTypeApp;
  description: string;
  quantity: number;
  rate: number;
  unit?: string;
  actual_cost?: number;
  needs_reimbursement?: boolean;
  reimbursement_status?: string;
  reimbursement_approved_at?: string;
  user_expense_id?: string | null;
  created_at?: string;
  updated_at?: string;
};

/** Values must match Postgres `service_ticket_expenses_expense_type_check` (see migration). */
const TICKET_EXPENSE_DB_TYPES = new Set(['Travel', 'Subsistence', 'Hotel', 'Equipment', 'Other', 'Expenses']);

function ticketExpenseTypeToDb(t: string | undefined | null): string {
  const raw = String(t ?? '').trim();
  if (!raw) return 'Travel';
  const lower = raw.toLowerCase();
  // App UI type for miscellaneous / billable-from-receipt lines
  if (lower === 'expenses') return 'Other';
  // Title-case common DB values so "HOTEL", "travel" still save
  const title = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  if (title === 'Other') return 'Other';
  if (TICKET_EXPENSE_DB_TYPES.has(title)) return title;
  if (lower === 'mileage' || lower === 'truck') return 'Travel';
  if (lower === 'per diem' || lower === 'perdiem') return 'Subsistence';
  if (lower === 'hotel') return 'Hotel';
  if (lower === 'equipment' || lower.includes('laptop')) return 'Equipment';
  return 'Other';
}

function ticketExpenseTypeFromDb(t: string | undefined | null): ServiceTicketExpenseTypeApp {
  const u = String(t ?? '').trim();
  const lower = u.toLowerCase();
  if (lower === 'other') return 'Expenses';
  if (lower === 'travel') return 'Travel';
  if (lower === 'subsistence') return 'Subsistence';
  if (lower === 'hotel') return 'Hotel';
  if (lower === 'equipment') return 'Equipment';
  if (lower === 'expenses') return 'Expenses';
  if (u === 'Travel' || u === 'Subsistence' || u === 'Hotel' || u === 'Equipment' || u === 'Expenses') {
    return u as ServiceTicketExpenseTypeApp;
  }
  return 'Expenses';
}

export const serviceTicketExpensesService = {
  async getByTicketId(ticketId: string): Promise<ServiceTicketExpenseRow[]> {
    const { data, error } = await supabase
      .from('service_ticket_expenses')
      .select('*')
      .eq('service_ticket_id', ticketId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return (data ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const unitRaw = r.unit;
      const acRaw = r.actual_cost;
      const nrRaw = r.needs_reimbursement;
      const out: ServiceTicketExpenseRow = {
        id: String(r.id ?? ''),
        service_ticket_id: String(r.service_ticket_id ?? ''),
        expense_type: ticketExpenseTypeFromDb(r.expense_type as string),
        description: String(r.description ?? ''),
        quantity: Number(r.quantity) || 0,
        rate: Number(r.rate) || 0,
      };
      if (unitRaw != null && String(unitRaw).trim() !== '') out.unit = String(unitRaw);
      if (acRaw != null && !Number.isNaN(Number(acRaw))) out.actual_cost = Number(acRaw);
      if (typeof nrRaw === 'boolean') out.needs_reimbursement = nrRaw;
      if (r.reimbursement_status != null) out.reimbursement_status = String(r.reimbursement_status);
      if (r.reimbursement_approved_at != null) out.reimbursement_approved_at = String(r.reimbursement_approved_at);
      if (r.user_expense_id != null) out.user_expense_id = String(r.user_expense_id);
      if (r.created_at != null) out.created_at = String(r.created_at);
      if (r.updated_at != null) out.updated_at = String(r.updated_at);
      return out;
    });
  },

  /** Get total $ (quantity * rate) per service_ticket_id for the given ticket IDs */
  async getExpenseTotalsByTicketIds(ticketIds: string[]): Promise<Record<string, number>> {
    if (ticketIds.length === 0) return {};
    const { data, error } = await supabase
      .from('service_ticket_expenses')
      .select('service_ticket_id, quantity, rate')
      .in('service_ticket_id', ticketIds);

    if (error) throw error;
    const totals: Record<string, number> = {};
    for (const row of data || []) {
      const id = row.service_ticket_id;
      const amount = (Number(row.quantity) || 0) * (Number(row.rate) || 0);
      totals[id] = (totals[id] ?? 0) + amount;
    }
    return totals;
  },

  async getReimbursableByDateRange(startDate: string, endDate: string, userId?: string) {
    let query = supabase
      .from('service_ticket_expenses')
      .select(`
        *,
        service_tickets!inner (
          id, user_id, date, ticket_number, is_discarded, project_id,
          project:projects(id, name, project_number)
        )
      `)
      .gte('service_tickets.date', startDate)
      .lte('service_tickets.date', endDate);

    if (userId) {
      query = query.eq('service_tickets.user_id', userId);
    }

    const { data, error } = await query;
    if (error) throw error;
    // Filter out discarded tickets client-side (nested or filter can be unreliable)
    return (data || []).filter((r: any) => !r.service_tickets?.is_discarded);
  },

  async getNeedsReimbursement() {
    const { data, error } = await supabase
      .from('service_ticket_expenses')
      .select(`
        *,
        service_tickets (
          id, user_id, date, ticket_number
        )
      `)
      .eq('needs_reimbursement', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  /**
   * Hotel lines that need reimbursement (caller filters to own tickets via userId; match receipts client-side).
   */
  async getHotelReimbursementLinesForUser(userId: string) {
    const { data, error } = await supabase
      .from('service_ticket_expenses')
      .select(`
        id,
        service_ticket_id,
        expense_type,
        description,
        quantity,
        rate,
        actual_cost,
        reimbursement_status,
        created_at,
        service_tickets!inner (
          id,
          user_id,
          date,
          ticket_number,
          is_discarded
        )
      `)
      .eq('needs_reimbursement', true)
      .eq('expense_type', 'Hotel')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data || []).filter(
      (r: any) =>
        !r.service_tickets?.is_discarded &&
        String(r.service_tickets?.user_id ?? '') === String(userId)
    );
  },

  /**
   * Ticket expenses currently linked to a receipt (`user_expense_id` set).
   * Used to show "this receipt covers X ticket expenses" on receipt rows in
   * the admin Expense Management table, and to support unlinking.
   */
  async getLinkedTicketExpenses() {
    const { data, error } = await supabase
      .from('service_ticket_expenses')
      .select(`
        id,
        service_ticket_id,
        expense_type,
        description,
        quantity,
        rate,
        user_expense_id,
        service_tickets (
          id,
          ticket_number,
          date,
          is_discarded
        )
      `)
      .not('user_expense_id', 'is', null);
    if (error) throw error;
    return (data || []).filter((r: any) => !r.service_tickets?.is_discarded);
  },

  /**
   * Admin variant: ALL employees' reimbursable ticket expenses with no receipt
   * attached yet. Each row carries the joined ticket + employee user info so the
   * UI can render an employee column and group/filter by employee.
   */
  async getAllPendingReceiptLines() {
    const { data, error } = await supabase
      .from('service_ticket_expenses')
      .select(`
        id,
        service_ticket_id,
        expense_type,
        description,
        quantity,
        rate,
        unit,
        actual_cost,
        needs_reimbursement,
        reimbursement_status,
        user_expense_id,
        created_at,
        service_tickets!inner (
          id,
          user_id,
          date,
          ticket_number,
          is_discarded,
          customer_id,
          project_id,
          customer:customers(id, name),
          project:projects(id, name, project_number),
          user:users!service_tickets_user_id_fkey(id, first_name, last_name, email)
        )
      `)
      .eq('needs_reimbursement', true)
      .is('user_expense_id', null)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data || []).filter((r: any) => !r.service_tickets?.is_discarded);
  },

  /**
   * Reimbursable ticket expenses owned by the user that have NO receipt attached yet
   * (`needs_reimbursement = true` AND `user_expense_id IS NULL`). Used by the
   * "Awaiting Receipts" section in the Expenses page.
   */
  async getPendingReceiptLinesForUser(userId: string) {
    const { data, error } = await supabase
      .from('service_ticket_expenses')
      .select(`
        id,
        service_ticket_id,
        expense_type,
        description,
        quantity,
        rate,
        unit,
        actual_cost,
        needs_reimbursement,
        reimbursement_status,
        user_expense_id,
        created_at,
        service_tickets!inner (
          id,
          user_id,
          date,
          ticket_number,
          is_discarded,
          customer_id,
          project_id,
          customer:customers(id, name),
          project:projects(id, name, project_number)
        )
      `)
      .eq('needs_reimbursement', true)
      .is('user_expense_id', null)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data || []).filter(
      (r: any) =>
        !r.service_tickets?.is_discarded &&
        String(r.service_tickets?.user_id ?? '') === String(userId)
    );
  },

  /**
   * Bulk-link a single user_expenses receipt to one or more service_ticket_expenses rows.
   * Set `userExpenseId` to null to detach.
   */
  async linkUserExpense(ticketExpenseIds: string[], userExpenseId: string | null) {
    if (ticketExpenseIds.length === 0) return { count: 0 };
    const { error } = await supabase
      .from('service_ticket_expenses')
      .update({ user_expense_id: userExpenseId })
      .in('id', ticketExpenseIds);
    if (error) throw error;
    return { count: ticketExpenseIds.length };
  },

  async updateReimbursementStatus(id: string, status: 'pending' | 'approved' | 'rejected' | 'paid') {
    const updatePayload: Record<string, unknown> = { reimbursement_status: status };
    if (status === 'approved') {
      updatePayload.reimbursement_approved_at = new Date().toISOString();
    }
    const { data, error } = await supabase
      .from('service_ticket_expenses')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  /**
   * Mark approved ticket reimbursement expenses (needs_reimbursement) as paid when the ticket's period has passed
   * and they were approved before/during the period. Skips re-approved after period end.
   */
  /**
   * Auto-sweep: mark reimbursable ticket expenses as paid when the pay period
   * that included them has fully passed. Approval workflow currently bypassed —
   * every needs_reimbursement row whose status is not 'paid' flips to paid past
   * the cutoff. Pay periods are 14-day stripes anchored on 2026-01-19; payday
   * is 5 days after the period end.
   *
   * For receipt-required types (Hotel, Other) we additionally require the line
   * to have a receipt attached: either actual_cost set OR user_expense_id linked.
   * This matches the payroll inclusion rule.
   */
  async autoMarkPastPaydaysPaid(): Promise<{ count: number; cutoff: string | null }> {
    const ANCHOR_MS = new Date(2026, 0, 19).getTime();
    const PAYDAY_OFFSET_DAYS = 18;
    const MS_PER_DAY = 86400000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const refPaydayMs = ANCHOR_MS + PAYDAY_OFFSET_DAYS * MS_PER_DAY;
    const periodsSince = (today.getTime() - refPaydayMs) / MS_PER_DAY / 14;
    if (periodsSince < 0) return { count: 0, cutoff: null };
    const idx = Math.floor(periodsSince);
    const periodEndMs = ANCHOR_MS + (idx * 14 + 13) * MS_PER_DAY;
    const cutoffDate = new Date(periodEndMs);
    const cutoff = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, '0')}-${String(cutoffDate.getDate()).padStart(2, '0')}`;

    // Identify employees opted-in to approval, plus contractors (who never need receipts).
    const { data: emps } = await supabase
      .from('employees')
      .select('user_id, employment_type, expenses_require_approval');
    const approvalUserIds = new Set<string>();
    const contractorUserIds = new Set<string>();
    for (const e of (emps || []) as any[]) {
      const uid = String(e.user_id || '');
      if (!uid) continue;
      if (e.expenses_require_approval) approvalUserIds.add(uid);
      if ((e.employment_type || 'Employee') === 'Contractor') contractorUserIds.add(uid);
    }

    const { data: rows, error: selectError } = await supabase
      .from('service_ticket_expenses')
      .select(`
        id,
        expense_type,
        description,
        actual_cost,
        user_expense_id,
        reimbursement_status,
        service_tickets!inner ( date, is_discarded, user_id )
      `)
      .eq('needs_reimbursement', true);
    if (selectError) throw selectError;

    const toMark = (rows || []).filter((r: any) => {
      if (r.service_tickets?.is_discarded) return false;
      if (r.reimbursement_status === 'paid') return false;
      const d = r.service_tickets?.date;
      if (!d || d > cutoff) return false;
      const ownerId = String(r.service_tickets?.user_id ?? '');
      const isContractor = contractorUserIds.has(ownerId);
      // Receipt-required types only paid when receipt attached. Contractors are
      // exempt — they invoice us for expenses, so no receipt is expected.
      if (!isContractor) {
        const t = String(r.expense_type || '').toLowerCase();
        const needsReceipt = t === 'hotel' || t === 'expenses' || (r.description || '').toLowerCase().includes('hotel');
        if (needsReceipt) {
          const hasReceipt = (Number(r.actual_cost) || 0) > 0 || !!r.user_expense_id;
          if (!hasReceipt) return false;
        }
      }
      // Per-employee opt-in approval gate.
      if (approvalUserIds.has(ownerId) && r.reimbursement_status !== 'approved') return false;
      return true;
    });

    if (toMark.length === 0) return { count: 0, cutoff };
    const ids = toMark.map((r: any) => r.id);
    const { error: updateError } = await supabase
      .from('service_ticket_expenses')
      .update({ reimbursement_status: 'paid' })
      .in('id', ids);
    if (updateError) throw updateError;
    return { count: ids.length, cutoff };
  },

  async markReimbursementPaidForPeriod(startDate: string, endDate: string): Promise<{ count: number }> {
    const endOfDay = endDate + 'T23:59:59.999Z';
    const { data: rows, error: selectError } = await supabase
      .from('service_ticket_expenses')
      .select(`
        id,
        reimbursement_approved_at,
        service_tickets!inner ( date )
      `)
      .eq('needs_reimbursement', true)
      .eq('reimbursement_status', 'approved');

    if (selectError) throw selectError;
    const toMark = (rows || []).filter((r: any) => {
      const ticketDate = r.service_tickets?.date;
      if (!ticketDate || ticketDate < startDate || ticketDate > endDate) return false;
      const approvedAt = r.reimbursement_approved_at;
      return approvedAt == null || approvedAt <= endOfDay;
    });
    if (toMark.length === 0) return { count: 0 };
    const ids = toMark.map((r: any) => r.id);
    const { error: updateError } = await supabase
      .from('service_ticket_expenses')
      .update({ reimbursement_status: 'paid' })
      .in('id', ids);
    if (updateError) throw updateError;
    return { count: ids.length };
  },

  async create(expense: {
    service_ticket_id: string;
    expense_type: 'Travel' | 'Subsistence' | 'Hotel' | 'Expenses' | 'Equipment';
    description: string;
    quantity: number;
    rate: number;
    actual_cost?: number;
    unit?: string;
    needs_reimbursement?: boolean;
    reimbursement_status?: string;
  }) {
    const { data, error } = await supabase
      .from('service_ticket_expenses')
      .insert({
        ...expense,
        expense_type: ticketExpenseTypeToDb(expense.expense_type),
      })
      .select()
      .single();

    if (error) throw error;
    return {
      ...data,
      expense_type: ticketExpenseTypeFromDb(data?.expense_type as string),
    };
  },

  async update(id: string, updates: {
    expense_type?: 'Travel' | 'Subsistence' | 'Hotel' | 'Expenses' | 'Equipment';
    description?: string;
    quantity?: number;
    rate?: number;
    actual_cost?: number;
    unit?: string;
    needs_reimbursement?: boolean;
    reimbursement_status?: string | null;
    reimbursement_approved_at?: string | null;
  }) {
    const payload =
      updates.expense_type !== undefined
        ? { ...updates, expense_type: ticketExpenseTypeToDb(updates.expense_type) }
        : updates;
    const { data, error } = await supabase
      .from('service_ticket_expenses')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return {
      ...data,
      expense_type: ticketExpenseTypeFromDb(data?.expense_type as string),
    };
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

const INVOICED_BATCH_BUCKET = 'invoiced-batch-invoices';
const RECEIPTS_BUCKET = 'receipts';

export const userExpensesService = {
  async getAll() {
    const { data, error } = await supabase
      .from('user_expenses')
      .select(`
        *,
        service_tickets (
          ticket_number
        ),
        users (
          first_name,
          last_name,
          email
        )
      `)
      .order('expense_date', { ascending: false });

    if (error) throw error;
    return data;
  },

  async getByServiceTicketId(ticketId: string) {
    const { data, error } = await supabase
      .from('user_expenses')
      .select('*')
      .eq('service_ticket_id', ticketId)
      .order('expense_date', { ascending: false });

    if (error) throw error;
    return data;
  },

  async getUnappliedBillable(forUserId?: string) {
    const uid = forUserId || (await supabase.auth.getUser()).data.user?.id;
    if (!uid) throw new Error('Not authenticated');

    const { data, error } = await supabase
      .from('user_expenses')
      .select('*')
      .eq('user_id', uid)
      .eq('is_billable', true)
      .is('service_ticket_id', null)
      .order('expense_date', { ascending: false });

    if (error) throw error;
    return data;
  },

  async create(expense: {
    amount: number;
    description: string;
    expense_date: string;
    service_ticket_id?: string;
    receipt_url?: string;
    notes?: string;
    gst?: number;
    is_billable?: boolean;
    markup_amount?: number;
    quantity?: number;
    status?: 'pending' | 'approved' | 'rejected' | 'paid';
  }) {
    // Note: user_id will be handled by RLS via auth.uid() if we don't supply it. 
    // Wait, actually, user_id is NOT NULL, let's get the user ID first or rely on the caller or default it if we can.
    // Let's get the current user ID.
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Not authenticated');

    const { data, error } = await supabase
      .from('user_expenses')
      .insert({ ...expense, user_id: user.id })
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async update(id: string, updates: Partial<{
    amount: number;
    description: string;
    expense_date: string;
    service_ticket_id: string | null;
    receipt_url: string;
    notes: string;
    gst: number;
    is_billable: boolean;
    markup_amount: number | null;
    quantity: number;
    status: 'pending' | 'approved' | 'rejected' | 'paid';
  }>) {
    const payload = { ...updates };
    if (updates.status === 'approved') {
      (payload as any).approved_at = new Date().toISOString();
    }
    const { data, error } = await supabase
      .from('user_expenses')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  /**
   * Mark unpaid (pending) receipt expenses as paid for a given period.
   */
  /**
   * Auto-sweep: mark receipt expenses as paid when the pay period that contained
   * their expense_date has fully passed. By default (employees.expenses_require_approval = false)
   * any non-paid receipt flips to paid past the cutoff. For employees flagged as
   * requiring approval, only status='approved' rows are flipped.
   */
  async autoMarkPastPaydaysPaid(): Promise<{ count: number; cutoff: string | null }> {
    const ANCHOR_MS = new Date(2026, 0, 19).getTime();
    const PAYDAY_OFFSET_DAYS = 18;
    const MS_PER_DAY = 86400000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const refPaydayMs = ANCHOR_MS + PAYDAY_OFFSET_DAYS * MS_PER_DAY;
    const periodsSince = (today.getTime() - refPaydayMs) / MS_PER_DAY / 14;
    if (periodsSince < 0) return { count: 0, cutoff: null };
    const idx = Math.floor(periodsSince);
    const periodEndMs = ANCHOR_MS + (idx * 14 + 13) * MS_PER_DAY;
    const cutoffDate = new Date(periodEndMs);
    const cutoff = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, '0')}-${String(cutoffDate.getDate()).padStart(2, '0')}`;

    // Identify employees opted-in to the approval workflow.
    const { data: approvalEmps } = await supabase
      .from('employees')
      .select('user_id')
      .eq('expenses_require_approval', true);
    const approvalUserIds = (approvalEmps || []).map((e: any) => e.user_id).filter(Boolean);

    // Pass A: default (no approval needed) — flip any non-paid past cutoff.
    let queryA = supabase
      .from('user_expenses')
      .select('id')
      .neq('status', 'paid')
      .lte('expense_date', cutoff);
    if (approvalUserIds.length > 0) {
      queryA = queryA.not('user_id', 'in', `(${approvalUserIds.map((id) => `"${id}"`).join(',')})`);
    }
    const { data: rowsA, error: errA } = await queryA;
    if (errA) throw errA;

    // Pass B: approval-required employees — only status='approved' flips.
    let rowsB: any[] = [];
    if (approvalUserIds.length > 0) {
      const { data, error } = await supabase
        .from('user_expenses')
        .select('id')
        .eq('status', 'approved')
        .lte('expense_date', cutoff)
        .in('user_id', approvalUserIds);
      if (error) throw error;
      rowsB = data || [];
    }

    const ids = [...(rowsA || []), ...rowsB].map((r: any) => r.id);
    if (ids.length === 0) return { count: 0, cutoff };
    const { error: updateError } = await supabase
      .from('user_expenses')
      .update({ status: 'paid' })
      .in('id', ids);
    if (updateError) throw updateError;
    return { count: ids.length, cutoff };
  },

  async markPaidForPeriod(startDate: string, endDate: string): Promise<{ count: number }> {
    const { data: rows, error: selectError } = await supabase
      .from('user_expenses')
      .select('id')
      .gte('expense_date', startDate)
      .lte('expense_date', endDate)
      .neq('status', 'paid');

    if (selectError) throw selectError;
    if (!rows || rows.length === 0) return { count: 0 };
    const ids = rows.map((r: any) => r.id);
    const { error: updateError } = await supabase
      .from('user_expenses')
      .update({ status: 'paid' })
      .in('id', ids);
    if (updateError) throw updateError;
    return { count: ids.length };
  },

  /**
   * Fetch approved (unpaid) receipt expenses with expense_date before the given date.
   * Used to find catch-up expenses for the current pay period (re-approved after their period ended).
   */
  async getCatchUpReceipts(expenseDateBefore: string, userId?: string) {
    let query = supabase
      .from('user_expenses')
      .select('*')
      .neq('status', 'paid')
      .lt('expense_date', expenseDateBefore)
      .order('expense_date', { ascending: false });
    if (userId) {
      query = query.eq('user_id', userId);
    }
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  async updateAndSyncTicket(id: string, updates: Partial<{
    amount: number;
    description: string;
    expense_date: string;
    notes: string;
    gst: number;
    is_billable: boolean;
    quantity: number;
  }>) {
    const { data: existing } = await supabase
      .from('user_expenses')
      .select('service_ticket_id, markup_amount, amount, gst, description, quantity')
      .eq('id', id)
      .single();

    // If billable was unchecked and expense is applied to a ticket, unapply first
    if (updates.is_billable === false && existing?.service_ticket_id) {
      await userExpensesService._removeLinkedTicketExpense(existing.service_ticket_id, existing.description);
      (updates as any).service_ticket_id = null;
      (updates as any).markup_amount = null;
    }

    const { data, error } = await supabase
      .from('user_expenses')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    if (existing?.service_ticket_id && updates.is_billable !== false) {
      const newAmount = updates.amount ?? existing.amount;
      const newGst = updates.gst ?? existing.gst ?? 0;
      const newQty = Number(updates.quantity ?? existing.quantity ?? 1) || 1;
      const expTotal = Number(newAmount) + Number(newGst);
      const markupAmount = Number(existing.markup_amount) || 0;
      const newDescription = updates.description ?? existing.description;
      const totalWithMarkup = expTotal + markupAmount;
      // Preserve qty × rate breakdown on the customer-facing line.
      const ticketRatePerUnit = newQty > 0
        ? Math.round((totalWithMarkup / newQty) * 100) / 100
        : totalWithMarkup;

      const { data: linkedExpenses } = await supabase
        .from('service_ticket_expenses')
        .select('id')
        .eq('service_ticket_id', existing.service_ticket_id)
        .ilike('description', existing.description);

      if (linkedExpenses && linkedExpenses.length > 0) {
        await supabase
          .from('service_ticket_expenses')
          .update({ description: newDescription, quantity: newQty, rate: ticketRatePerUnit })
          .eq('id', linkedExpenses[0].id);
      }
    }
    return data;
  },

  /**
   * Delete a user_expenses row. By default removes the receipt file from storage when present.
   * Use `keepReceiptInStorage` when deleting duplicate split rows that share the same file with another expense.
   */
  async delete(id: string, options?: { keepReceiptInStorage?: boolean }) {
    const { data: expense } = await supabase.from('user_expenses').select('receipt_url, service_ticket_id, description').eq('id', id).single();

    if (expense?.receipt_url && !options?.keepReceiptInStorage) {
      const pathSegments = expense.receipt_url.split('/');
      const fileName = pathSegments[pathSegments.length - 1];
      const folderName = pathSegments[pathSegments.length - 2];
      if (fileName && folderName) {
         await supabase.storage.from(RECEIPTS_BUCKET).remove([`${folderName}/${fileName}`]);
      }
    }

    if (expense?.service_ticket_id) {
      await userExpensesService._removeLinkedTicketExpense(expense.service_ticket_id, expense.description);
    }

    const { error } = await supabase
      .from('user_expenses')
      .delete()
      .eq('id', id);

    if (error) throw error;
  },

  /**
   * Merge multiple unapplied rows that share the same receipt file into one (sum amount+GST).
   * Keeps the oldest row by created_at; deletes others without removing storage.
   * Returns true if at least two rows were consolidated.
   */
  async mergeUnappliedRowsSharingReceiptUrl(receiptUrl: string): Promise<boolean> {
    const url = String(receiptUrl || '').trim();
    if (!url) return false;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;

    const { data: rows, error } = await supabase
      .from('user_expenses')
      .select('*')
      .eq('user_id', user.id)
      .eq('receipt_url', url)
      .is('service_ticket_id', null)
      .order('created_at', { ascending: true });

    if (error) throw error;
    if (!rows || rows.length <= 1) return false;

    const splitHint =
      /(remainder \(same receipt\)|portion not billed to client|·\s*combined\s*\(\d+\))/i;
    const pickMergedDescription = (): string => {
      for (const r of rows as any[]) {
        const d = String(r.description || '').trim();
        if (d && !splitHint.test(d)) return d;
      }
      const d0 = String((rows[0] as any).description || 'Receipt').trim();
      return (
        d0
          .replace(/\s*—\s*remainder \(same receipt\)\s*$/i, '')
          .replace(/\s*—\s*portion not billed to client \(same receipt\)\s*$/i, '')
          .replace(/\s*·\s*combined \(\d+\)\s*$/i, '')
          .trim() || 'Receipt'
      );
    };

    const totalAmount =
      Math.round((rows as any[]).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0) * 100) / 100;
    const totalGst =
      Math.round((rows as any[]).reduce((s, r) => s + (parseFloat(r.gst) || 0), 0) * 100) / 100;
    const anyBillable = (rows as any[]).some((r) => r.is_billable);
    const statuses = (rows as any[]).map((r) => String(r.status || 'pending'));
    const mergedStatus: 'pending' | 'approved' | 'rejected' | 'paid' = statuses.includes('pending')
      ? 'pending'
      : statuses.includes('rejected')
        ? 'rejected'
        : statuses.includes('paid')
          ? 'paid'
          : 'approved';

    const primary = rows[0] as any;
    const primaryId = String(primary.id);

    await userExpensesService.update(primaryId, {
      amount: totalAmount,
      gst: totalGst,
      description: pickMergedDescription(),
      is_billable: anyBillable,
      status: mergedStatus,
      markup_amount: null,
    });

    for (let i = 1; i < rows.length; i++) {
      await userExpensesService.delete(String((rows[i] as any).id), { keepReceiptInStorage: true });
    }
    return true;
  },

  /**
   * When the user removes a receipt from a ticket expense line: clear receipt file (if unreferenced),
   * clear receipt_url/markup on linked user_expenses, set ticket line to not reimbursable.
   * Does not remove the service_ticket_expenses row.
   * @returns true if at least one linked user_expense had a receipt and was cleared
   */
  async removeReceiptFromTicketLine(
    serviceTicketId: string,
    description: string,
    serviceTicketExpenseId: string
  ): Promise<boolean> {
    const d = (description || '').trim();
    if (!d) return false;

    const { data: receipts, error: selErr } = await supabase
      .from('user_expenses')
      .select('id, receipt_url')
      .eq('service_ticket_id', serviceTicketId)
      .ilike('description', d);
    if (selErr) throw selErr;
    if (!receipts?.length) return false;

    const rows = receipts as { id: string; receipt_url?: string | null }[];
    const withReceipt = rows.filter((r) => String(r.receipt_url || '').trim());
    if (withReceipt.length === 0) return false;

    const idsToClear = withReceipt.map((r) => r.id);
    const urls = [...new Set(withReceipt.map((r) => String(r.receipt_url).trim()).filter(Boolean))];

    for (const url of urls) {
      const { data: refs } = await supabase.from('user_expenses').select('id').eq('receipt_url', url);
      const others = (refs || []).filter((r) => !idsToClear.includes(r.id));
      if (others.length === 0) {
        const pathSegments = url.split('/');
        const fileName = pathSegments[pathSegments.length - 1];
        const folderName = pathSegments[pathSegments.length - 2];
        if (fileName && folderName) {
          await supabase.storage.from(RECEIPTS_BUCKET).remove([`${folderName}/${fileName}`]);
        }
      }
    }

    const { error: upErr } = await supabase
      .from('user_expenses')
      .update({ receipt_url: null, markup_amount: null })
      .in('id', idsToClear);
    if (upErr) throw upErr;

    await serviceTicketExpensesService.update(serviceTicketExpenseId, {
      needs_reimbursement: false,
      reimbursement_status: null,
      reimbursement_approved_at: null,
    });

    return true;
  },

  async unapplyFromTicket(id: string) {
    const { data: expense, error: fetchErr } = await supabase
      .from('user_expenses')
      .select('service_ticket_id, description, receipt_url')
      .eq('id', id)
      .single();
    if (fetchErr) throw fetchErr;
    if (!expense?.service_ticket_id) return;

    await userExpensesService._removeLinkedTicketExpense(expense.service_ticket_id, expense.description);

    const { error: updateErr } = await supabase
      .from('user_expenses')
      .update({ service_ticket_id: null, markup_amount: null })
      .eq('id', id);
    if (updateErr) throw updateErr;

    const ru = (expense as { receipt_url?: string | null }).receipt_url;
    if (ru && String(ru).trim()) {
      await userExpensesService.mergeUnappliedRowsSharingReceiptUrl(String(ru).trim());
    }
  },

  async _removeLinkedTicketExpense(serviceTicketId: string, description: string) {
    const d = (description || '').trim();
    if (!d) return;
    const { data: linked } = await supabase
      .from('service_ticket_expenses')
      .select('id')
      .eq('service_ticket_id', serviceTicketId)
      .ilike('description', d);

    if (linked && linked.length > 0) {
      await supabase
        .from('service_ticket_expenses')
        .delete()
        .eq('id', linked[0].id);
    }
  },

  /** Unlink user_expenses (receipts) when their linked service_ticket_expense is deleted */
  async unlinkReceiptsForDeletedExpense(serviceTicketId: string, description: string) {
    const d = (description || '').trim();
    if (!d) return;
    const { data: receipts } = await supabase
      .from('user_expenses')
      .select('id, receipt_url')
      .eq('service_ticket_id', serviceTicketId)
      .ilike('description', d);

    if (receipts && receipts.length > 0) {
      await supabase
        .from('user_expenses')
        .update({ service_ticket_id: null, markup_amount: null })
        .in('id', receipts.map((r) => r.id));
      const urls = [
        ...new Set(
          receipts
            .map((r: any) => String(r.receipt_url || '').trim())
            .filter(Boolean)
        ),
      ];
      for (const url of urls) {
        await userExpensesService.mergeUnappliedRowsSharingReceiptUrl(url);
      }
    }
  },

  async uploadReceipt(file: File): Promise<string> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Not authenticated');

    const timestamp = Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storagePath = `${user.id}/${timestamp}_${safeName}`;

    const { error } = await supabase.storage
      .from(RECEIPTS_BUCKET)
      .upload(storagePath, file, { 
        cacheControl: '3600',
        upsert: false 
      });

    if (error) throw error;

    // Return the storage path so we can generate signed URLs on demand
    return storagePath;
  },

  async getReceiptSignedUrl(storagePath: string): Promise<string> {
    const { data, error } = await supabase.storage
      .from(RECEIPTS_BUCKET)
      .createSignedUrl(storagePath, 3600);

    if (error) throw error;
    return data.signedUrl;
  }
};

function sanitizeStoragePathSegment(s: string): string {
  return s.replace(/[/\\?*:|"]/g, '_').slice(0, 200);
}

/**
 * Normalize uploaded invoice PDF name for display/DB: "Invoice 1646 (1).pdf" → "Invoice 1646"
 * Strips duplicate (1), (2)… with optional space before "("; drops .pdf from the label only.
 */
function normalizeInvoiceUploadLabel(originalName: string): { label: string; storageFileSegment: string } {
  const trimmed = (originalName || 'invoice.pdf').trim();
  const lastDot = trimmed.lastIndexOf('.');
  let base = lastDot > 0 ? trimmed.slice(0, lastDot) : trimmed;
  while (/\s*\(\d+\)$/i.test(base)) {
    base = base.replace(/\s*\(\d+\)$/i, '').trim();
  }
  const label = (base || 'invoice').trim();
  const storageFileSegment = `${label}.pdf`;
  return { label, storageFileSegment };
}

/** Normalize any stored invoice_filename for UI (legacy rows may still include .pdf or "(1)") */
export function displayInvoiceFilename(stored: string | null | undefined): string {
  if (stored == null || stored === '') return '';
  let s = stored.trim();
  if (/\.pdf$/i.test(s)) s = s.slice(0, -4).trim();
  while (/\s*\(\d+\)$/i.test(s)) s = s.replace(/\s*\(\d+\)$/i, '').trim();
  return s || stored.trim();
}

/** saveAs() / file downloads — stem only in DB/UI, always ends with .pdf */
export function invoiceFilenameForDownload(labelOrLegacy: string | null | undefined): string {
  const stem = displayInvoiceFilename(labelOrLegacy) || 'invoice';
  return /\.pdf$/i.test(stem) ? stem : `${stem}.pdf`;
}

export const invoicedBatchInvoicesService = {
  async uploadInvoice(groupId: string, file: File): Promise<{ storagePath: string; filename: string }> {
    const safeId = sanitizeStoragePathSegment(groupId);
    const timestamp = Date.now();
    const { label, storageFileSegment } = normalizeInvoiceUploadLabel(file.name || 'invoice.pdf');
    const safeName = sanitizeStoragePathSegment(storageFileSegment);
    const storagePath = `${safeId}/${timestamp}_${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from(INVOICED_BATCH_BUCKET)
      .upload(storagePath, file, { contentType: 'application/pdf', upsert: true });

    if (uploadError) throw uploadError;

    const { error: upsertError } = await supabase
      .from('invoiced_batch_invoices')
      .upsert(
        {
          group_id: groupId,
          invoice_filename: label,
          storage_path: storagePath,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'group_id' }
      );

    if (upsertError) throw upsertError;
    return { storagePath, filename: label };
  },

  async getAllInvoicedGroupIds(): Promise<string[]> {
    const { data, error } = await supabase
      .from('invoiced_batch_invoices')
      .select('group_id');
    if (error) throw error;
    return (data || []).map((row) => row.group_id);
  },

  async getMetadataByGroupIds(groupIds: string[]): Promise<Record<string, { filename: string; storagePath: string }>> {
    if (groupIds.length === 0) return {};
    const { data, error } = await supabase
      .from('invoiced_batch_invoices')
      .select('group_id, invoice_filename, storage_path')
      .in('group_id', groupIds);

    if (error) throw error;
    const out: Record<string, { filename: string; storagePath: string }> = {};
    for (const row of data || []) {
      out[row.group_id] = {
        filename: displayInvoiceFilename(row.invoice_filename),
        storagePath: row.storage_path,
      };
    }
    return out;
  },

  async downloadInvoice(storagePath: string): Promise<Blob> {
    const { data, error } = await supabase.storage.from(INVOICED_BATCH_BUCKET).download(storagePath);
    if (error) throw error;
    if (!data) throw new Error('No data returned');
    return data;
  },

  async deleteInvoice(groupId: string): Promise<void> {
    const { data: rows } = await supabase
      .from('invoiced_batch_invoices')
      .select('storage_path')
      .eq('group_id', groupId)
      .limit(1);

    if (rows?.[0]?.storage_path) {
      await supabase.storage.from(INVOICED_BATCH_BUCKET).remove([rows[0].storage_path]);
    }
    const { error } = await supabase.from('invoiced_batch_invoices').delete().eq('group_id', groupId);
    if (error) throw error;
  },
};

/**
 * Signed/approved batch PDFs (Portal Approval workflow). Same bucket as invoices,
 * stored under an _approvals/ prefix so the two PDF kinds don't collide.
 */
export const invoicedBatchApprovalsService = {
  async uploadApproval(groupId: string, file: File): Promise<{ storagePath: string; filename: string }> {
    const safeId = sanitizeStoragePathSegment(groupId);
    const timestamp = Date.now();
    const { label, storageFileSegment } = normalizeInvoiceUploadLabel(file.name || 'approval.pdf');
    const safeName = sanitizeStoragePathSegment(storageFileSegment);
    const storagePath = `_approvals/${safeId}/${timestamp}_${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from(INVOICED_BATCH_BUCKET)
      .upload(storagePath, file, { contentType: 'application/pdf', upsert: true });

    if (uploadError) throw uploadError;

    const { data: { user } } = await supabase.auth.getUser();
    const now = new Date().toISOString();
    const { error: upsertError } = await supabase
      .from('invoiced_batch_approvals')
      .upsert(
        {
          group_id: groupId,
          approval_filename: label,
          storage_path: storagePath,
          uploaded_by: user?.id ?? null,
          uploaded_at: now,
          updated_at: now,
        },
        { onConflict: 'group_id' }
      );

    if (upsertError) throw upsertError;
    return { storagePath, filename: label };
  },

  async getMetadataByGroupIds(groupIds: string[]): Promise<Record<string, { filename: string; storagePath: string }>> {
    if (groupIds.length === 0) return {};
    const { data, error } = await supabase
      .from('invoiced_batch_approvals')
      .select('group_id, approval_filename, storage_path')
      .in('group_id', groupIds);

    if (error) throw error;
    const out: Record<string, { filename: string; storagePath: string }> = {};
    for (const row of data || []) {
      out[row.group_id] = {
        filename: displayInvoiceFilename(row.approval_filename),
        storagePath: row.storage_path,
      };
    }
    return out;
  },

  async downloadApproval(storagePath: string): Promise<Blob> {
    const { data, error } = await supabase.storage.from(INVOICED_BATCH_BUCKET).download(storagePath);
    if (error) throw error;
    if (!data) throw new Error('No data returned');
    return data;
  },

  async deleteApproval(groupId: string): Promise<void> {
    const { data: rows } = await supabase
      .from('invoiced_batch_approvals')
      .select('storage_path')
      .eq('group_id', groupId)
      .limit(1);

    if (rows?.[0]?.storage_path) {
      await supabase.storage.from(INVOICED_BATCH_BUCKET).remove([rows[0].storage_path]);
    }
    const { error } = await supabase.from('invoiced_batch_approvals').delete().eq('group_id', groupId);
    if (error) throw error;
  },
};

export type InvoicedBatchMarkRow = {
  group_id: string;
  key_snapshot: { key: unknown; ticketIds: string[] } | null;
  marked_at: string;
  marked_by: string | null;
};

/** Persisted "marked as invoiced" groups (same group_id as PDF batch uploads). */
export const invoicedBatchMarksService = {
  async getAll(): Promise<InvoicedBatchMarkRow[]> {
    const { data, error } = await supabase
      .from('invoiced_batch_marks')
      .select('group_id, key_snapshot, marked_at, marked_by')
      .order('marked_at', { ascending: false });
    if (error) throw error;
    return (data || []) as InvoicedBatchMarkRow[];
  },

  async upsert(groupId: string, keySnapshot: { key: unknown; ticketIds: string[] }): Promise<void> {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const now = new Date().toISOString();
    const { error } = await supabase.from('invoiced_batch_marks').upsert(
      {
        group_id: groupId,
        key_snapshot: keySnapshot,
        marked_by: user?.id ?? null,
        marked_at: now,
        updated_at: now,
      },
      { onConflict: 'group_id' }
    );
    if (error) throw error;
  },

  async deleteMark(groupId: string): Promise<void> {
    const { error } = await supabase.from('invoiced_batch_marks').delete().eq('group_id', groupId);
    if (error) throw error;
  },
};

/* ─── Invoice Workflows ─── */

export type InvoiceWorkflowStatus = {
  id: string;
  label: string;
  color: string;
};

export type InvoiceWorkflowRow = {
  id: string;
  name: string;
  statuses: InvoiceWorkflowStatus[];
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

export const invoiceWorkflowsService = {
  async getAll(): Promise<InvoiceWorkflowRow[]> {
    const { data, error } = await supabase
      .from('invoice_workflows')
      .select('*')
      .order('is_default', { ascending: false })
      .order('name');
    if (error) throw error;
    return (data || []) as InvoiceWorkflowRow[];
  },

  async create(workflow: { name: string; statuses: InvoiceWorkflowStatus[]; is_default?: boolean }): Promise<InvoiceWorkflowRow> {
    if (workflow.is_default) {
      await supabase.from('invoice_workflows').update({ is_default: false }).eq('is_default', true);
    }
    const { data, error } = await supabase
      .from('invoice_workflows')
      .insert({ name: workflow.name, statuses: workflow.statuses, is_default: workflow.is_default ?? false })
      .select()
      .single();
    if (error) throw error;
    return data as InvoiceWorkflowRow;
  },

  async update(id: string, updates: { name?: string; statuses?: InvoiceWorkflowStatus[]; is_default?: boolean }): Promise<InvoiceWorkflowRow> {
    if (updates.is_default) {
      await supabase.from('invoice_workflows').update({ is_default: false }).eq('is_default', true);
    }
    const { data, error } = await supabase
      .from('invoice_workflows')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data as InvoiceWorkflowRow;
  },

  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('invoice_workflows').delete().eq('id', id);
    if (error) throw error;
  },
};

/* ─── Invoice Status History ─── */

export type InvoiceStatusHistoryRow = {
  id: string;
  group_id: string;
  customer_name: string | null;
  project_number: string | null;
  workflow_id: string | null;
  status_id: string;
  status_label: string;
  entered_at: string;
  exited_at: string | null;
  days_in_status: number | null;
  changed_by: string | null;
};

export const invoiceStatusHistoryService = {
  async logEntry(entry: {
    group_id: string;
    customer_name?: string;
    project_number?: string;
    workflow_id?: string;
    status_id: string;
    status_label: string;
    entered_at?: string;
  }): Promise<void> {
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('invoice_status_history').insert({
      group_id: entry.group_id,
      customer_name: entry.customer_name ?? null,
      project_number: entry.project_number ?? null,
      workflow_id: entry.workflow_id ?? null,
      status_id: entry.status_id,
      status_label: entry.status_label,
      entered_at: entry.entered_at ?? new Date().toISOString(),
      changed_by: user?.id ?? null,
    });
    if (error) throw error;
  },

  async closeEntry(groupId: string, statusId: string): Promise<void> {
    const now = new Date();
    const { data: rows } = await supabase
      .from('invoice_status_history')
      .select('id, entered_at')
      .eq('group_id', groupId)
      .eq('status_id', statusId)
      .is('exited_at', null)
      .order('entered_at', { ascending: false })
      .limit(1);
    if (!rows || rows.length === 0) return;
    const row = rows[0];
    const enteredAt = new Date(row.entered_at);
    const daysInStatus = Math.round(((now.getTime() - enteredAt.getTime()) / (1000 * 60 * 60 * 24)) * 100) / 100;
    await supabase
      .from('invoice_status_history')
      .update({ exited_at: now.toISOString(), days_in_status: daysInStatus })
      .eq('id', row.id);
  },

  async getByGroupId(groupId: string): Promise<InvoiceStatusHistoryRow[]> {
    const { data, error } = await supabase
      .from('invoice_status_history')
      .select('*')
      .eq('group_id', groupId)
      .order('entered_at', { ascending: true });
    if (error) throw error;
    return (data || []) as InvoiceStatusHistoryRow[];
  },
};

/** All service_tickets.id values listed in any invoiced batch mark (admin Service Tickets lock UI). */
export function collectLockedServiceTicketIdsFromMarks(rows: InvoicedBatchMarkRow[]): Set<string> {
  const s = new Set<string>();
  for (const r of rows) {
    const ids = r.key_snapshot?.ticketIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id === 'string' && id.length > 0) s.add(id);
    }
  }
  return s;
}

/** Ticket IDs for the current user that appear in an invoiced batch (RLS-safe RPC). */
export async function fetchLockedServiceTicketIdsForCurrentUser(): Promise<string[]> {
  const { data, error } = await supabase.rpc('locked_service_ticket_ids_for_current_user');
  if (error) throw error;
  if (!data) return [];
  const arr = Array.isArray(data) ? data : [];
  return arr
    .map((row: { ticket_id?: string }) => row?.ticket_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}
