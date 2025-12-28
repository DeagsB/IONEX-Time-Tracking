import { supabase } from '../lib/supabaseClient';

// Service functions for interacting with Supabase tables

export const timeEntriesService = {
  async getAll(isDemoMode?: boolean) {
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
  async getAll() {
    const { data, error } = await supabase
      .from('customers')
      .select('*, projects(*)')
      .order('name');

    if (error) throw error;
    return data;
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
    const { data, error } = await supabase
      .from('customers')
      .insert(customer)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async update(id: string, updates: any) {
    const { data, error } = await supabase
      .from('customers')
      .update(updates)
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
  async getAll() {
    const { data, error } = await supabase
      .from('projects')
      .select(`
        *,
        customer:customers(*)
      `)
      .order('name');

    if (error) throw error;
    return data;
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

  async create(project: any) {
    const { data, error } = await supabase
      .from('projects')
      .insert(project)
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
  async getAll() {
    const { data, error } = await supabase
      .from('employees')
      .select(`
        *,
        user:users(id, email, first_name, last_name)
      `)
      .order('employee_id');

    if (error) throw error;
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
};

export const serviceTicketsService = {
  async getBillableEntries(filters?: {
    startDate?: string;
    endDate?: string;
    customerId?: string;
    userId?: string;
    approvedOnly?: boolean;
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
          customer:customers!projects_customer_id_fkey(*)
        )
      `)
      .eq('billable', true)
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
    if (filters?.approvedOnly) {
      query = query.eq('approved', true);
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
   */
  async getNextTicketNumber(userInitials: string): Promise<string> {
    const year = new Date().getFullYear() % 100; // Get last 2 digits of year
    
    // Find the highest sequence number for this employee this year
    const { data, error } = await supabase
      .from('service_tickets')
      .select('sequence_number')
      .eq('employee_initials', userInitials.toUpperCase())
      .eq('year', year)
      .order('sequence_number', { ascending: false })
      .limit(1);

    if (error) {
      throw error;
    }

    const nextSequence = data && data.length > 0 ? data[0].sequence_number + 1 : 1;
    const paddedSequence = String(nextSequence).padStart(3, '0');
    
    return `${userInitials.toUpperCase()}_${year}${paddedSequence}`;
  },

  /**
   * Create a service ticket record in the database
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
  }) {
    const { data, error } = await supabase
      .from('service_tickets')
      .insert({
        ticket_number: ticket.ticketNumber,
        employee_initials: ticket.employeeInitials,
        year: ticket.year,
        sequence_number: ticket.sequenceNumber,
        date: ticket.date,
        customer_id: ticket.customerId,
        user_id: ticket.userId,
        project_id: ticket.projectId,
        total_hours: ticket.totalHours,
        total_amount: ticket.totalAmount,
        status: 'draft'
      })
      .select()
      .single();

    if (error) {
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
