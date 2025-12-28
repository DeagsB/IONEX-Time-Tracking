import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { serviceTicketsService, customersService, employeesService, serviceTicketExpensesService } from '../services/supabaseServices';
import { groupEntriesIntoTickets, formatTicketDate, generateTicketDisplayId, ServiceTicket } from '../utils/serviceTickets';
import { Link } from 'react-router-dom';
import { downloadExcelServiceTicket } from '../utils/serviceTicketXlsx';
import { downloadPdfFromHtml } from '../utils/pdfFromHtml';
import { supabase } from '../lib/supabaseClient';

export default function ServiceTickets() {
  const { user } = useAuth();
  const { isDemoMode } = useDemoMode();
  const queryClient = useQueryClient();
  
  // Filters state
  const [startDate, setStartDate] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 30); // Default to last 30 days
    return date.toISOString().split('T')[0];
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [approvedOnly, setApprovedOnly] = useState(false);
  
  // Ticket preview state
  const [selectedTicket, setSelectedTicket] = useState<ServiceTicket | null>(null);
  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [currentTicketRecordId, setCurrentTicketRecordId] = useState<string | null>(null);
  
  // Expense management state
  const [expenses, setExpenses] = useState<Array<{
    id?: string;
    expense_type: 'Travel' | 'Subsistence' | 'Expenses' | 'Equipment';
    description: string;
    quantity: number;
    rate: number;
    unit?: string;
  }>>([]);
  const [editingExpense, setEditingExpense] = useState<{
    id?: string;
    expense_type: 'Travel' | 'Subsistence' | 'Expenses' | 'Equipment';
    description: string;
    quantity: number;
    rate: number;
    unit?: string;
  } | null>(null);
  
  // Editable ticket fields state
  const [editableTicket, setEditableTicket] = useState<{
    customerName: string;
    address: string;
    cityState: string;
    zipCode: string;
    phone: string;
    email: string;
    contactName: string;
    serviceLocation: string;
    locationCode: string;
    poNumber: string;
    approverName: string;
    techName: string;
    projectNumber: string;
    date: string;
  } | null>(null);
  
  // Generated ticket number for display
  const [displayTicketNumber, setDisplayTicketNumber] = useState<string>('');
  
  // Bulk selection state
  const [selectedTicketIds, setSelectedTicketIds] = useState<Set<string>>(new Set());
  const [isBulkExporting, setIsBulkExporting] = useState(false);

  // Round to nearest 0.5 hour (always round up)
  const roundToHalfHour = (hours: number): number => {
    return Math.ceil(hours * 2) / 2;
  };

  // Handler for exporting ticket as PDF
  const handleExportPdf = async (ticket: ServiceTicket) => {
    setIsExportingPdf(true);
    try {
      // Check if a ticket number already exists in the database
      const existingRecord = existingTickets?.find(
        et => et.date === ticket.date && 
              et.user_id === ticket.userId && 
              (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
      );
      
      let ticketNumber: string;
      
      if (existingRecord?.ticket_number) {
        // Use existing ticket number
        ticketNumber = existingRecord.ticket_number;
      } else if (ticket.ticketNumber && !ticket.ticketNumber.includes('XXX')) {
        // Use the already assigned ticket number
        ticketNumber = ticket.ticketNumber;
      } else if (displayTicketNumber && !displayTicketNumber.includes('XXX')) {
        // Use the display ticket number if it's not a placeholder
        ticketNumber = displayTicketNumber;
      } else {
        // Generate a new ticket number
        ticketNumber = await serviceTicketsService.getNextTicketNumber(ticket.userInitials);
        
        // Calculate totals for recording
        const rtRate = ticket.rates.rt, ttRate = ticket.rates.tt, ftRate = ticket.rates.ft, otRate = ticket.rates.ot;
        const rtAmount = ticket.hoursByRateType['Shop Time'] * rtRate;
        const ttAmount = ticket.hoursByRateType['Travel Time'] * ttRate;
        const ftAmount = ticket.hoursByRateType['Field Time'] * ftRate;
        const otAmount = (ticket.hoursByRateType['Shop Overtime'] + ticket.hoursByRateType['Field Overtime']) * otRate;
        const totalAmount = rtAmount + ttAmount + ftAmount + otAmount;
        
        // Save the ticket record to the database
        const year = new Date().getFullYear() % 100;
        const sequenceMatch = ticketNumber.match(/\d{3}$/);
        const sequenceNumber = sequenceMatch ? parseInt(sequenceMatch[0]) : 1;
        
        await serviceTicketsService.createTicketRecord({
          ticketNumber,
          employeeInitials: ticket.userInitials,
          year,
          sequenceNumber,
          date: ticket.date,
          customerId: ticket.customerId !== 'unassigned' ? ticket.customerId : undefined,
          userId: ticket.userId,
          projectId: ticket.projectId,
          totalHours: ticket.totalHours,
          totalAmount,
        });
      }
      
      const ticketWithNumber = { ...ticket, ticketNumber };
      // Load expenses for PDF export if needed
      let ticketExpenses = expenses;
      if (!currentTicketRecordId || ticket.id !== selectedTicket?.id) {
        try {
          const existing = existingTickets?.find(
            et => et.date === ticket.date && 
                  et.user_id === ticket.userId && 
                  (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
          );
          if (existing) {
            ticketExpenses = await serviceTicketExpensesService.getByTicketId(existing.id);
          }
        } catch (error) {
          console.error('Error loading expenses for export:', error);
          ticketExpenses = [];
        }
      }
      await downloadPdfFromHtml(ticketWithNumber, ticketExpenses);
    } catch (error) {
      console.error('PDF export error:', error);
      alert('Failed to export service ticket PDF. Check console for details.');
    } finally {
      setIsExportingPdf(false);
    }
  };

  // Handler for exporting ticket as Excel
  const handleExportExcel = async (ticket: ServiceTicket) => {
    setIsExportingExcel(true);
    try {
      // Use the ticket number that was already set (either from DB or newly generated)
      const ticketNumber = ticket.ticketNumber || displayTicketNumber;
      
      // Create a copy of the ticket with the ticket number
      const ticketWithNumber = { ...ticket, ticketNumber };
      
      // Load expenses for this ticket if not already loaded
      let ticketExpenses = expenses;
      if (currentTicketRecordId && ticket.id === selectedTicket?.id) {
        // Expenses already loaded
      } else {
        // Load expenses for this ticket
        try {
          const existing = existingTickets?.find(
            et => et.date === ticket.date && 
                  et.user_id === ticket.userId && 
                  (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
          );
          if (existing) {
            ticketExpenses = await serviceTicketExpensesService.getByTicketId(existing.id);
          }
        } catch (error) {
          console.error('Error loading expenses for export:', error);
          ticketExpenses = [];
        }
      }
      
      await downloadExcelServiceTicket(ticketWithNumber, ticketExpenses);
      
      // Only create a new record if this ticket doesn't already have one
      // Check if a record already exists for this date/user/customer combo
      const existingRecord = existingTickets?.find(
        et => et.date === ticket.date && 
              et.user_id === ticket.userId && 
              (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
      );
      
      if (!existingRecord) {
        // Calculate totals for recording
        const rtRate = 130, ttRate = 130, ftRate = 140, otRate = 195;
        const rtAmount = ticket.hoursByRateType['Shop Time'] * rtRate;
        const ttAmount = ticket.hoursByRateType['Travel Time'] * ttRate;
        const ftAmount = ticket.hoursByRateType['Field Time'] * ftRate;
        const otAmount = (ticket.hoursByRateType['Shop Overtime'] + ticket.hoursByRateType['Field Overtime']) * otRate;
        const totalAmount = rtAmount + ttAmount + ftAmount + otAmount;
        
        // Save the ticket record to the database
        const year = new Date().getFullYear() % 100;
        const sequenceMatch = ticketNumber.match(/\d{3}$/);
        const sequenceNumber = sequenceMatch ? parseInt(sequenceMatch[0]) : 1;
        
        await serviceTicketsService.createTicketRecord({
          ticketNumber,
          employeeInitials: ticket.userInitials,
          year,
          sequenceNumber,
          date: ticket.date,
          customerId: ticket.customerId !== 'unassigned' ? ticket.customerId : undefined,
          userId: ticket.userId,
          projectId: ticket.projectId,
          totalHours: ticket.totalHours,
          totalAmount,
        });
      }
    } catch (error) {
      alert('Failed to export service ticket Excel.');
    } finally {
      setIsExportingExcel(false);
    }
  };

  // Toggle selection for a ticket
  const toggleTicketSelection = (ticketId: string) => {
    setSelectedTicketIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(ticketId)) {
        newSet.delete(ticketId);
      } else {
        newSet.add(ticketId);
      }
      return newSet;
    });
  };

  // Select/deselect all tickets
  const toggleSelectAll = () => {
    if (selectedTicketIds.size === filteredTickets.length) {
      setSelectedTicketIds(new Set());
    } else {
      setSelectedTicketIds(new Set(filteredTickets.map(t => t.id)));
    }
  };

  // Get ticket by ID from filtered tickets
  const getTicketById = (id: string) => filteredTickets.find(t => t.id === id);

  // Bulk export to Excel
  const handleBulkExportExcel = async () => {
    setIsBulkExporting(true);
    try {
      const ticketsToExport = Array.from(selectedTicketIds).map(id => getTicketById(id)).filter(Boolean) as (ServiceTicket & { displayTicketNumber: string })[];
      
      for (const ticket of ticketsToExport) {
        // Check if a ticket number already exists
        const existingRecord = existingTickets?.find(
          et => et.date === ticket.date && 
                et.user_id === ticket.userId && 
                (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
        );
        
        let ticketNumber: string;
        
        if (existingRecord?.ticket_number) {
          ticketNumber = existingRecord.ticket_number;
        } else if (ticket.displayTicketNumber && !ticket.displayTicketNumber.includes('XXX')) {
          ticketNumber = ticket.displayTicketNumber;
        } else {
          // Generate a new ticket number
          ticketNumber = await serviceTicketsService.getNextTicketNumber(ticket.userInitials);
          
          // Save the ticket record
          const year = new Date().getFullYear() % 100;
          const sequenceMatch = ticketNumber.match(/\d{3}$/);
          const sequenceNumber = sequenceMatch ? parseInt(sequenceMatch[0]) : 1;
          
          const rtRate = ticket.rates.rt, ttRate = ticket.rates.tt, ftRate = ticket.rates.ft, otRate = ticket.rates.ot;
          const rtAmount = ticket.hoursByRateType['Shop Time'] * rtRate;
          const ttAmount = ticket.hoursByRateType['Travel Time'] * ttRate;
          const ftAmount = ticket.hoursByRateType['Field Time'] * ftRate;
          const otAmount = (ticket.hoursByRateType['Shop Overtime'] + ticket.hoursByRateType['Field Overtime']) * otRate;
          const totalAmount = rtAmount + ttAmount + ftAmount + otAmount;
          
          await serviceTicketsService.createTicketRecord({
            ticketNumber,
            employeeInitials: ticket.userInitials,
            year,
            sequenceNumber,
            date: ticket.date,
            customerId: ticket.customerId !== 'unassigned' ? ticket.customerId : undefined,
            userId: ticket.userId,
            projectId: ticket.projectId,
            totalHours: ticket.totalHours,
            totalAmount,
          });
        }
        
        const ticketWithNumber = { ...ticket, ticketNumber };
        // Load expenses for bulk export
        let ticketExpenses = [];
        try {
          const existing = existingTickets?.find(
            et => et.date === ticket.date && 
                  et.user_id === ticket.userId && 
                  (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
          );
          if (existing) {
            ticketExpenses = await serviceTicketExpensesService.getByTicketId(existing.id);
          }
        } catch (error) {
          console.error('Error loading expenses for export:', error);
        }
        await downloadExcelServiceTicket(ticketWithNumber, ticketExpenses);
        
        // Small delay between exports to avoid overwhelming the browser
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      setSelectedTicketIds(new Set());
      alert(`Successfully exported ${ticketsToExport.length} Excel files!`);
    } catch (error) {
      console.error('Bulk Excel export error:', error);
      alert('Error during bulk export. Some files may have been exported.');
    } finally {
      setIsBulkExporting(false);
    }
  };

  // Bulk export to PDF
  const handleBulkExportPdf = async () => {
    setIsBulkExporting(true);
    try {
      const ticketsToExport = Array.from(selectedTicketIds).map(id => getTicketById(id)).filter(Boolean) as (ServiceTicket & { displayTicketNumber: string })[];
      
      for (const ticket of ticketsToExport) {
        // Check if a ticket number already exists
        const existingRecord = existingTickets?.find(
          et => et.date === ticket.date && 
                et.user_id === ticket.userId && 
                (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
        );
        
        let ticketNumber: string;
        
        if (existingRecord?.ticket_number) {
          ticketNumber = existingRecord.ticket_number;
        } else if (ticket.displayTicketNumber && !ticket.displayTicketNumber.includes('XXX')) {
          ticketNumber = ticket.displayTicketNumber;
        } else {
          // Generate a new ticket number
          ticketNumber = await serviceTicketsService.getNextTicketNumber(ticket.userInitials);
          
          // Save the ticket record
          const year = new Date().getFullYear() % 100;
          const sequenceMatch = ticketNumber.match(/\d{3}$/);
          const sequenceNumber = sequenceMatch ? parseInt(sequenceMatch[0]) : 1;
          
          const rtRate = ticket.rates.rt, ttRate = ticket.rates.tt, ftRate = ticket.rates.ft, otRate = ticket.rates.ot;
          const rtAmount = ticket.hoursByRateType['Shop Time'] * rtRate;
          const ttAmount = ticket.hoursByRateType['Travel Time'] * ttRate;
          const ftAmount = ticket.hoursByRateType['Field Time'] * ftRate;
          const otAmount = (ticket.hoursByRateType['Shop Overtime'] + ticket.hoursByRateType['Field Overtime']) * otRate;
          const totalAmount = rtAmount + ttAmount + ftAmount + otAmount;
          
          await serviceTicketsService.createTicketRecord({
            ticketNumber,
            employeeInitials: ticket.userInitials,
            year,
            sequenceNumber,
            date: ticket.date,
            customerId: ticket.customerId !== 'unassigned' ? ticket.customerId : undefined,
            userId: ticket.userId,
            projectId: ticket.projectId,
            totalHours: ticket.totalHours,
            totalAmount,
          });
        }
        
        const ticketWithNumber = { ...ticket, ticketNumber };
        // Load expenses for bulk export
        let ticketExpenses = [];
        try {
          const existing = existingTickets?.find(
            et => et.date === ticket.date && 
                  et.user_id === ticket.userId && 
                  (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
          );
          if (existing) {
            ticketExpenses = await serviceTicketExpensesService.getByTicketId(existing.id);
          }
        } catch (error) {
          console.error('Error loading expenses for export:', error);
        }
        await downloadPdfFromHtml(ticketWithNumber, ticketExpenses);
        
        // Small delay between exports to avoid overwhelming the browser
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      setSelectedTicketIds(new Set());
      alert(`Successfully exported ${ticketsToExport.length} PDF files!`);
    } catch (error) {
      console.error('Bulk PDF export error:', error);
      alert('Error during bulk export. Some files may have been exported.');
    } finally {
      setIsBulkExporting(false);
    }
  };

  // Fetch billable entries (filtered by demo mode)
  const { data: billableEntries, isLoading: isLoadingEntries, error: entriesError } = useQuery({
    queryKey: ['billableEntries', startDate, endDate, selectedCustomerId, selectedUserId, approvedOnly, isDemoMode],
    queryFn: () => serviceTicketsService.getBillableEntries({
      startDate,
      endDate,
      customerId: selectedCustomerId || undefined,
      userId: selectedUserId || undefined,
      approvedOnly,
      isDemoMode, // Only show demo entries in demo mode, real entries otherwise
    }),
  });

  // Fetch customers for filter
  const { data: customers } = useQuery({
    queryKey: ['customers'],
    queryFn: () => customersService.getAll(),
  });

  // Fetch employees for filter
  const { data: employees } = useQuery({
    queryKey: ['employees'],
    queryFn: () => employeesService.getAll(),
  });

  // Group entries into tickets (with employee rates)
  const tickets = useMemo(() => {
    if (!billableEntries) return [];
    return groupEntriesIntoTickets(billableEntries, employees);
  }, [billableEntries, employees]);

  // Fetch existing ticket numbers for display
  const { data: existingTickets } = useQuery({
    queryKey: ['existingServiceTickets'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('service_tickets')
        .select('id, ticket_number, date, user_id, customer_id');
      if (error) throw error;
      return data;
    },
  });

  // Expense mutations
  const createExpenseMutation = useMutation({
    mutationFn: (expense: {
      service_ticket_id: string;
      expense_type: 'Travel' | 'Subsistence' | 'Expenses' | 'Equipment';
      description: string;
      quantity: number;
      rate: number;
      unit?: string;
    }) => serviceTicketExpensesService.create(expense),
    onSuccess: () => {
      if (currentTicketRecordId) {
        loadExpenses(currentTicketRecordId);
      }
    },
  });

  const updateExpenseMutation = useMutation({
    mutationFn: ({ id, ...updates }: { id: string } & Parameters<typeof serviceTicketExpensesService.update>[1]) =>
      serviceTicketExpensesService.update(id, updates),
    onSuccess: () => {
      if (currentTicketRecordId) {
        loadExpenses(currentTicketRecordId);
      }
    },
  });

  const deleteExpenseMutation = useMutation({
    mutationFn: (id: string) => serviceTicketExpensesService.delete(id),
    onSuccess: () => {
      if (currentTicketRecordId) {
        loadExpenses(currentTicketRecordId);
      }
    },
  });

  // Load expenses for a service ticket
  const loadExpenses = async (ticketId: string) => {
    try {
      const expenseData = await serviceTicketExpensesService.getByTicketId(ticketId);
      setExpenses(expenseData || []);
    } catch (error) {
      console.error('Error loading expenses:', error);
      setExpenses([]);
    }
  };

  // Get or create service ticket record ID when a ticket is selected
  const getOrCreateTicketRecord = async (ticket: ServiceTicket): Promise<string> => {
    // Try to find existing ticket record
    const existing = existingTickets?.find(
      et => et.date === ticket.date && 
            et.user_id === ticket.userId && 
            (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
    );

    if (existing) {
      return existing.id;
    }

    // Create new ticket record
    const ticketNumber = displayTicketNumber && !displayTicketNumber.includes('XXX')
      ? displayTicketNumber
      : await serviceTicketsService.getNextTicketNumber(ticket.userInitials);
    
    const year = new Date().getFullYear() % 100;
    const sequenceMatch = ticketNumber.match(/\d{3}$/);
    const sequenceNumber = sequenceMatch ? parseInt(sequenceMatch[0]) : 1;
    
    const rtRate = ticket.rates.rt, ttRate = ticket.rates.tt, ftRate = ticket.rates.ft, otRate = ticket.rates.ot;
    const rtAmount = ticket.hoursByRateType['Shop Time'] * rtRate;
    const ttAmount = ticket.hoursByRateType['Travel Time'] * ttRate;
    const ftAmount = ticket.hoursByRateType['Field Time'] * ftRate;
    const otAmount = (ticket.hoursByRateType['Shop Overtime'] + ticket.hoursByRateType['Field Overtime']) * otRate;
    const totalAmount = rtAmount + ttAmount + ftAmount + otAmount;

    const record = await serviceTicketsService.createTicketRecord({
      ticketNumber,
      employeeInitials: ticket.userInitials,
      year,
      sequenceNumber,
      date: ticket.date,
      customerId: ticket.customerId !== 'unassigned' ? ticket.customerId : undefined,
      userId: ticket.userId,
      projectId: ticket.projectId,
      totalHours: ticket.totalHours,
      totalAmount,
    });

    return record.id;
  };

  // Match tickets with existing ticket numbers or generate preview
  const ticketsWithNumbers = useMemo(() => {
    return tickets.map(ticket => {
      // Try to find an existing ticket number for this specific ticket
      const existing = existingTickets?.find(
        et => et.date === ticket.date && 
              et.user_id === ticket.userId && 
              (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
      );
      
      return {
        ...ticket,
        displayTicketNumber: existing?.ticket_number || `${ticket.userInitials}_${new Date(ticket.date).getFullYear() % 100}XXX`
      };
    });
  }, [tickets, existingTickets]);

  // Filter by customer on frontend (optional, for additional client-side filtering)
  const filteredTickets = useMemo(() => {
    let result = ticketsWithNumbers;
    if (selectedCustomerId) {
      result = result.filter(t => t.customerId === selectedCustomerId);
    }
    return result;
  }, [ticketsWithNumbers, selectedCustomerId]);

  if (user?.role !== 'ADMIN') {
    return (
      <div>
        <h2>Service Tickets</h2>
        <div className="card">
          <p>You don't have permission to view this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>
          Service Tickets
        </h2>
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: '24px', padding: '20px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
          <div>
            <label className="label">Start Date</label>
            <input
              type="date"
              className="input"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              style={{
                width: '100%',
                padding: '8px',
                backgroundColor: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'var(--text-primary)',
              }}
            />
          </div>
          <div>
            <label className="label">End Date</label>
            <input
              type="date"
              className="input"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              style={{
                width: '100%',
                padding: '8px',
                backgroundColor: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'var(--text-primary)',
              }}
            />
          </div>
          <div>
            <label className="label">Customer</label>
            <select
              className="input"
              value={selectedCustomerId}
              onChange={(e) => setSelectedCustomerId(e.target.value)}
              style={{
                width: '100%',
                padding: '8px',
                backgroundColor: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'var(--text-primary)',
              }}
            >
              <option value="">All Customers</option>
              {customers?.map((customer: any) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Employee</label>
            <select
              className="input"
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
              style={{
                width: '100%',
                padding: '8px',
                backgroundColor: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'var(--text-primary)',
              }}
            >
              <option value="">All Employees</option>
              {employees?.map((employee: any) => (
                <option key={employee.user_id} value={employee.user_id}>
                  {employee.user?.first_name} {employee.user?.last_name}
                </option>
              ))}
            </select>
          </div>
          {!isDemoMode && (
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={approvedOnly}
                  onChange={(e) => setApprovedOnly(e.target.checked)}
                  style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: '#c770f0' }}
                />
                <span style={{ fontSize: '14px', color: 'var(--text-primary)' }}>Approved Only</span>
              </label>
            </div>
          )}
        </div>
      </div>

      {/* Tickets List */}
      {entriesError ? (
        <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: '#ef5350', marginBottom: '10px', fontWeight: '600' }}>
            Error loading service tickets
          </p>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
            {entriesError instanceof Error ? entriesError.message : 'Unknown error occurred'}
          </p>
        </div>
      ) : isLoadingEntries ? (
        <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-secondary)' }}>Loading service tickets...</p>
        </div>
      ) : filteredTickets.length === 0 ? (
        <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-secondary)' }}>
            No billable time entries found for the selected filters.
          </p>
        </div>
      ) : (
        <>
        {/* Bulk Action Bar */}
        {selectedTicketIds.size > 0 && (
          <div style={{
            backgroundColor: '#2563eb',
            padding: '12px 20px',
            borderRadius: '8px 8px 0 0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px',
          }}>
            <span style={{ color: 'white', fontWeight: '500' }}>
              {selectedTicketIds.size} ticket{selectedTicketIds.size > 1 ? 's' : ''} selected
            </span>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={handleBulkExportExcel}
                disabled={isBulkExporting}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#16a34a',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '13px',
                  fontWeight: '500',
                  cursor: isBulkExporting ? 'not-allowed' : 'pointer',
                  opacity: isBulkExporting ? 0.6 : 1,
                }}
              >
                {isBulkExporting ? 'Exporting...' : '📊 Export All to Excel'}
              </button>
              <button
                onClick={handleBulkExportPdf}
                disabled={isBulkExporting}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#dc2626',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '13px',
                  fontWeight: '500',
                  cursor: isBulkExporting ? 'not-allowed' : 'pointer',
                  opacity: isBulkExporting ? 0.6 : 1,
                }}
              >
                {isBulkExporting ? 'Exporting...' : '📄 Export All to PDF'}
              </button>
              <button
                onClick={() => setSelectedTicketIds(new Set())}
                disabled={isBulkExporting}
                style={{
                  padding: '8px 16px',
                  backgroundColor: 'rgba(255,255,255,0.2)',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '13px',
                  cursor: isBulkExporting ? 'not-allowed' : 'pointer',
                }}
              >
                Clear Selection
              </button>
            </div>
          </div>
        )}
        
        <div className="card" style={{ overflow: 'hidden', borderRadius: selectedTicketIds.size > 0 ? '0 0 8px 8px' : '8px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
                <th style={{ padding: '16px', textAlign: 'center', width: '50px' }}>
                  <input
                    type="checkbox"
                    checked={filteredTickets.length > 0 && selectedTicketIds.size === filteredTickets.length}
                    onChange={toggleSelectAll}
                    style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: '#c770f0' }}
                    title="Select all"
                  />
                </th>
                <th style={{ padding: '16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  Ticket ID
                </th>
                <th style={{ padding: '16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  Date
                </th>
                <th style={{ padding: '16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  Customer
                </th>
                <th style={{ padding: '16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  Tech
                </th>
                <th style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  Total Hours
                </th>
                <th style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  RT
                </th>
                <th style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  OT
                </th>
                <th style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  TT
                </th>
                <th style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  FT
                </th>
                <th style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  FOT
                </th>
                <th style={{ padding: '16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredTickets.map((ticket) => {
                const handleRowClick = async () => {
                  setSelectedTicket(ticket);
                  setEditableTicket({
                    customerName: ticket.customerInfo.name || '',
                    address: ticket.customerInfo.address || '',
                    cityState: ticket.customerInfo.city && ticket.customerInfo.state 
                      ? `${ticket.customerInfo.city}, ${ticket.customerInfo.state}`
                      : ticket.customerInfo.city || ticket.customerInfo.state || '',
                    zipCode: ticket.customerInfo.zip_code || '',
                    phone: ticket.customerInfo.phone || '',
                    email: ticket.customerInfo.email || '',
                    contactName: ticket.userName || '',
                    serviceLocation: ticket.customerInfo.service_location || ticket.customerInfo.address || '',
                    locationCode: ticket.customerInfo.location_code || '',
                    poNumber: ticket.customerInfo.po_number || '',
                    approverName: ticket.customerInfo.approver_name || '',
                    techName: ticket.userName || '',
                    projectNumber: ticket.projectNumber || '',
                    date: ticket.date || '',
                  });
                  
                  // Use existing ticket number if already exported, otherwise generate a new one
                  if (ticket.displayTicketNumber && !ticket.displayTicketNumber.includes('XXX')) {
                    // This ticket was already exported - use the existing number
                    setDisplayTicketNumber(ticket.displayTicketNumber);
                  } else {
                    // Generate a new ticket number for first-time export
                    serviceTicketsService.getNextTicketNumber(ticket.userInitials)
                      .then(num => setDisplayTicketNumber(num))
                      .catch(() => setDisplayTicketNumber(`${ticket.userInitials}_${new Date().getFullYear() % 100}XXX`));
                  }

                  // Load expenses for this ticket
                  try {
                    const ticketRecordId = await getOrCreateTicketRecord(ticket);
                    setCurrentTicketRecordId(ticketRecordId);
                    await loadExpenses(ticketRecordId);
                  } catch (error) {
                    console.error('Error loading expenses:', error);
                    setExpenses([]);
                  }
                };

                return (
                <tr
                  key={ticket.id}
                  style={{
                    borderBottom: '1px solid var(--border-color)',
                    transition: 'background-color 0.2s',
                    cursor: 'pointer',
                    backgroundColor: selectedTicketIds.has(ticket.id) ? 'rgba(37, 99, 235, 0.1)' : 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = selectedTicketIds.has(ticket.id) ? 'rgba(37, 99, 235, 0.2)' : 'var(--hover-bg)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = selectedTicketIds.has(ticket.id) ? 'rgba(37, 99, 235, 0.1)' : 'transparent';
                  }}
                  onClick={handleRowClick}
                >
                  <td style={{ padding: '16px', textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedTicketIds.has(ticket.id)}
                      onChange={() => toggleTicketSelection(ticket.id)}
                      style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: '#c770f0' }}
                    />
                  </td>
                  <td style={{ padding: '16px', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: '13px' }}>
                    {ticket.displayTicketNumber}
                  </td>
                  <td style={{ padding: '16px', color: 'var(--text-primary)' }}>
                    {new Date(ticket.date).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </td>
                  <td style={{ padding: '16px', color: 'var(--text-primary)', fontWeight: '500' }}>
                    {ticket.customerName}
                  </td>
                  <td style={{ padding: '16px', color: 'var(--text-primary)' }}>
                    {ticket.userName}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-primary)', fontWeight: '600' }}>
                    {ticket.totalHours.toFixed(2)}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {ticket.hoursByRateType['Shop Time'].toFixed(1)}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {ticket.hoursByRateType['Shop Overtime'].toFixed(1)}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {ticket.hoursByRateType['Travel Time'].toFixed(1)}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {ticket.hoursByRateType['Field Time'].toFixed(1)}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {ticket.hoursByRateType['Field Overtime'].toFixed(1)}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                    <button
                      className="button"
                      onClick={() => {
                        // TODO: Implement mark as invoiced functionality
                        alert('Mark as invoiced functionality coming soon!');
                      }}
                      style={{
                        padding: '6px 16px',
                        fontSize: '13px',
                        backgroundColor: '#4caf50',
                        color: 'white',
                        border: 'none',
                      }}
                    >
                      Mark as Invoiced
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}

      {/* Ticket Preview Modal */}
      {selectedTicket && editableTicket && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '20px',
          }}
          onClick={() => { setSelectedTicket(null); setEditableTicket(null); }}
        >
          <div
            style={{
              backgroundColor: '#1a1a2e',
              borderRadius: '12px',
              maxWidth: '900px',
              width: '100%',
              maxHeight: '90vh',
              overflow: 'auto',
              boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Ticket Header */}
            <div
              style={{
                padding: '24px',
                borderBottom: '1px solid rgba(255,255,255,0.1)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <h2 style={{ fontSize: '24px', fontWeight: '700', color: '#fff', margin: '0 0 8px 0' }}>
                  SERVICE TICKET
                </h2>
                <p style={{ fontSize: '14px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>
                  Ticket: {displayTicketNumber || 'Loading...'}
                </p>
              </div>
              <button
                onClick={() => { setSelectedTicket(null); setEditableTicket(null); }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: '24px',
                  color: 'rgba(255,255,255,0.6)',
                  cursor: 'pointer',
                  padding: '4px 8px',
                }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: '24px' }}>
              {/* Editable input style */}
              {(() => {
                const inputStyle: React.CSSProperties = {
                  width: '100%',
                  padding: '8px 12px',
                  backgroundColor: 'rgba(255,255,255,0.1)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '6px',
                  color: '#fff',
                  fontSize: '14px',
                  outline: 'none',
                };
                const labelStyle: React.CSSProperties = {
                  display: 'block',
                  fontSize: '11px',
                  fontWeight: '600',
                  color: 'rgba(255,255,255,0.5)',
                  marginBottom: '4px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                };
                const sectionStyle: React.CSSProperties = {
                  backgroundColor: 'rgba(255,255,255,0.05)',
                  borderRadius: '8px',
                  padding: '16px',
                  marginBottom: '16px',
                };
                const sectionTitleStyle: React.CSSProperties = {
                  fontSize: '12px',
                  fontWeight: '700',
                  textTransform: 'uppercase',
                  color: '#c770f0',
                  marginBottom: '16px',
                  letterSpacing: '1px',
                };

                return (
                  <>
                    {/* Customer & Service Info Section */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
                      {/* Customer Info */}
                      <div style={sectionStyle}>
                        <h3 style={sectionTitleStyle}>Customer Information</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                          <div>
                            <label style={labelStyle}>Customer Name</label>
                            <input
                              style={inputStyle}
                              value={editableTicket.customerName}
                              onChange={(e) => setEditableTicket({ ...editableTicket, customerName: e.target.value })}
                            />
                          </div>
                          <div>
                            <label style={labelStyle}>Address</label>
                            <input
                              style={inputStyle}
                              value={editableTicket.address}
                              onChange={(e) => setEditableTicket({ ...editableTicket, address: e.target.value })}
                            />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={labelStyle}>City, Province</label>
                              <input
                                style={inputStyle}
                                value={editableTicket.cityState}
                                onChange={(e) => setEditableTicket({ ...editableTicket, cityState: e.target.value })}
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>Postal Code</label>
                              <input
                                style={inputStyle}
                                value={editableTicket.zipCode}
                                onChange={(e) => setEditableTicket({ ...editableTicket, zipCode: e.target.value })}
                              />
                            </div>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={labelStyle}>Phone</label>
                              <input
                                style={inputStyle}
                                value={editableTicket.phone}
                                onChange={(e) => setEditableTicket({ ...editableTicket, phone: e.target.value })}
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>Email</label>
                              <input
                                style={inputStyle}
                                value={editableTicket.email}
                                onChange={(e) => setEditableTicket({ ...editableTicket, email: e.target.value })}
                              />
                            </div>
                          </div>
                          <div>
                            <label style={labelStyle}>Contact Name</label>
                            <input
                              style={inputStyle}
                              value={editableTicket.contactName}
                              onChange={(e) => setEditableTicket({ ...editableTicket, contactName: e.target.value })}
                            />
                          </div>
                        </div>
                      </div>

                      {/* Service Info */}
                      <div style={sectionStyle}>
                        <h3 style={sectionTitleStyle}>Service Information</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                          <div>
                            <label style={labelStyle}>Technician</label>
                            <input
                              style={inputStyle}
                              value={editableTicket.techName}
                              onChange={(e) => setEditableTicket({ ...editableTicket, techName: e.target.value })}
                            />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={labelStyle}>Project Number</label>
                              <input
                                style={inputStyle}
                                value={editableTicket.projectNumber}
                                onChange={(e) => setEditableTicket({ ...editableTicket, projectNumber: e.target.value })}
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>Date</label>
                              <input
                                type="date"
                                style={inputStyle}
                                value={editableTicket.date}
                                onChange={(e) => setEditableTicket({ ...editableTicket, date: e.target.value })}
                              />
                            </div>
                          </div>
                          <div>
                            <label style={labelStyle}>Service Location</label>
                            <input
                              style={inputStyle}
                              value={editableTicket.serviceLocation}
                              onChange={(e) => setEditableTicket({ ...editableTicket, serviceLocation: e.target.value })}
                            />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={labelStyle}>Location Code</label>
                              <input
                                style={inputStyle}
                                value={editableTicket.locationCode}
                                onChange={(e) => setEditableTicket({ ...editableTicket, locationCode: e.target.value })}
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>PO Number</label>
                              <input
                                style={inputStyle}
                                value={editableTicket.poNumber}
                                onChange={(e) => setEditableTicket({ ...editableTicket, poNumber: e.target.value })}
                              />
                            </div>
                          </div>
                          <div>
                            <label style={labelStyle}>Approver</label>
                            <input
                              style={inputStyle}
                              value={editableTicket.approverName}
                              onChange={(e) => setEditableTicket({ ...editableTicket, approverName: e.target.value })}
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Service Description Section */}
                    <div style={sectionStyle}>
                      <h3 style={sectionTitleStyle}>Service Description</h3>
                      <div style={{ color: '#fff', fontSize: '14px' }}>
                        {Object.entries(selectedTicket.hoursByRateType).map(([rateType, hours]) => {
                          if (hours === 0) return null;
                          const entriesForType = selectedTicket.entries.filter(
                            (e) => (e.rate_type || 'Shop Time') === rateType
                          );
                          const roundedTotal = entriesForType.reduce((sum, e) => sum + roundToHalfHour(e.hours), 0);
                          return (
                            <div key={rateType} style={{ marginBottom: '16px' }}>
                              <h4 style={{ fontSize: '13px', fontWeight: '600', color: '#c770f0', marginBottom: '8px' }}>
                                {rateType} ({roundedTotal.toFixed(2)} hrs)
                              </h4>
                              <ul style={{ margin: 0, paddingLeft: '20px', color: 'rgba(255,255,255,0.8)' }}>
                                {entriesForType.map((entry) => (
                                  <li key={entry.id} style={{ marginBottom: '4px', lineHeight: '1.5' }}>
                                    {entry.description || 'No description'}
                                    {entry.start_time && entry.end_time && (
                                      <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '12px', marginLeft: '8px' }}>
                                        ({new Date(entry.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} - 
                                        {new Date(entry.end_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})
                                      </span>
                                    )}
                                    <span style={{ fontWeight: '600', marginLeft: '8px', color: '#fff' }}>
                                      {roundToHalfHour(entry.hours).toFixed(2)} hrs
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Hours Summary Section */}
                    <div style={sectionStyle}>
                      <h3 style={sectionTitleStyle}>Hours Summary</h3>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
                        {Object.entries(selectedTicket.hoursByRateType).map(([rateType, hours]) => {
                          const entriesForType = selectedTicket.entries.filter(
                            (e) => (e.rate_type || 'Shop Time') === rateType
                          );
                          const roundedTotal = entriesForType.reduce((sum, e) => sum + roundToHalfHour(e.hours), 0);
                          return (
                            <div key={rateType} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.7)', fontWeight: '500' }}>{rateType}:</span>
                              <span style={{ fontSize: '14px', color: '#fff', fontWeight: '700' }}>{roundedTotal.toFixed(2)}</span>
                            </div>
                          );
                        })}
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gridColumn: 'span 3',
                            paddingTop: '12px',
                            borderTop: '1px solid rgba(255,255,255,0.2)',
                            marginTop: '8px',
                          }}
                        >
                          <span style={{ fontSize: '15px', color: '#fff', fontWeight: '700' }}>TOTAL HOURS:</span>
                          <span style={{ fontSize: '18px', color: '#c770f0', fontWeight: '700' }}>
                            {selectedTicket.entries.reduce((sum, e) => sum + roundToHalfHour(e.hours), 0).toFixed(2)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Expenses Section */}
                    <div style={sectionStyle}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                        <h3 style={sectionTitleStyle}>Travel / Subsistence / Expenses / Equipment</h3>
                        {currentTicketRecordId && (
                          <button
                            onClick={() => {
                              setEditingExpense({
                                expense_type: 'Travel',
                                description: '',
                                quantity: 1,
                                rate: 0,
                                unit: '',
                              });
                            }}
                            style={{
                              padding: '6px 12px',
                              backgroundColor: '#c770f0',
                              color: 'white',
                              border: 'none',
                              borderRadius: '6px',
                              fontSize: '12px',
                              fontWeight: '600',
                              cursor: 'pointer',
                            }}
                          >
                            + Add Expense
                          </button>
                        )}
                      </div>
                      
                      {expenses.length === 0 && !editingExpense && (
                        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '13px', margin: 0 }}>
                          No expenses added yet.
                        </p>
                      )}

                      {editingExpense && currentTicketRecordId && (
                        <div style={{
                          backgroundColor: 'rgba(199, 112, 240, 0.1)',
                          border: '1px solid rgba(199, 112, 240, 0.3)',
                          borderRadius: '6px',
                          padding: '12px',
                          marginBottom: '12px',
                        }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', marginBottom: '12px' }}>
                            <div>
                              <label style={labelStyle}>Type</label>
                              <select
                                style={inputStyle}
                                value={editingExpense.expense_type}
                                onChange={(e) => setEditingExpense({ ...editingExpense, expense_type: e.target.value as any })}
                              >
                                <option value="Travel">Travel</option>
                                <option value="Subsistence">Subsistence</option>
                                <option value="Expenses">Expenses</option>
                                <option value="Equipment">Equipment</option>
                              </select>
                            </div>
                            <div>
                              <label style={labelStyle}>Unit (e.g., km, day, hr)</label>
                              <input
                                style={inputStyle}
                                value={editingExpense.unit || ''}
                                onChange={(e) => setEditingExpense({ ...editingExpense, unit: e.target.value })}
                                placeholder="km, day, hr, unit"
                              />
                            </div>
                          </div>
                          <div style={{ marginBottom: '12px' }}>
                            <label style={labelStyle}>Description</label>
                            <input
                              style={inputStyle}
                              value={editingExpense.description}
                              onChange={(e) => setEditingExpense({ ...editingExpense, description: e.target.value })}
                              placeholder="e.g., Mileage, Per diem, Equipment billout"
                            />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                            <div>
                              <label style={labelStyle}>Quantity</label>
                              <input
                                type="number"
                                step="0.01"
                                style={inputStyle}
                                value={editingExpense.quantity}
                                onChange={(e) => setEditingExpense({ ...editingExpense, quantity: parseFloat(e.target.value) || 0 })}
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>Rate ($)</label>
                              <input
                                type="number"
                                step="0.01"
                                style={inputStyle}
                                value={editingExpense.rate}
                                onChange={(e) => setEditingExpense({ ...editingExpense, rate: parseFloat(e.target.value) || 0 })}
                              />
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                            <button
                              onClick={() => setEditingExpense(null)}
                              style={{
                                padding: '6px 12px',
                                backgroundColor: 'transparent',
                                color: 'rgba(255,255,255,0.7)',
                                border: '1px solid rgba(255,255,255,0.2)',
                                borderRadius: '6px',
                                fontSize: '12px',
                                cursor: 'pointer',
                              }}
                            >
                              Cancel
                            </button>
                            <button
                              onClick={async () => {
                                if (!editingExpense.description.trim()) {
                                  alert('Please enter a description');
                                  return;
                                }
                                if (editingExpense.id) {
                                  await updateExpenseMutation.mutateAsync({
                                    id: editingExpense.id,
                                    ...editingExpense,
                                  });
                                } else {
                                  await createExpenseMutation.mutateAsync({
                                    service_ticket_id: currentTicketRecordId,
                                    ...editingExpense,
                                  });
                                }
                                setEditingExpense(null);
                              }}
                              style={{
                                padding: '6px 12px',
                                backgroundColor: '#c770f0',
                                color: 'white',
                                border: 'none',
                                borderRadius: '6px',
                                fontSize: '12px',
                                fontWeight: '600',
                                cursor: 'pointer',
                              }}
                            >
                              {editingExpense.id ? 'Update' : 'Add'}
                            </button>
                          </div>
                        </div>
                      )}

                      {expenses.map((expense) => (
                        <div
                          key={expense.id}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr auto',
                            gap: '12px',
                            alignItems: 'center',
                            padding: '10px',
                            backgroundColor: 'rgba(255,255,255,0.03)',
                            borderRadius: '6px',
                            marginBottom: '8px',
                            fontSize: '13px',
                          }}
                        >
                          <div>
                            <span style={{ color: '#c770f0', fontWeight: '600', fontSize: '11px', textTransform: 'uppercase' }}>
                              {expense.expense_type}
                            </span>
                            <div style={{ color: '#fff', marginTop: '2px' }}>
                              {expense.description}
                              {expense.unit && <span style={{ color: 'rgba(255,255,255,0.5)', marginLeft: '4px' }}>({expense.unit})</span>}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right', color: 'rgba(255,255,255,0.7)' }}>
                            {expense.quantity.toFixed(2)}
                          </div>
                          <div style={{ textAlign: 'right', color: 'rgba(255,255,255,0.7)' }}>
                            @ ${expense.rate.toFixed(2)}
                          </div>
                          <div style={{ textAlign: 'right', color: '#fff', fontWeight: '700' }}>
                            ${(expense.quantity * expense.rate).toFixed(2)}
                          </div>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              onClick={() => setEditingExpense({ ...expense })}
                              style={{
                                padding: '4px 8px',
                                backgroundColor: 'transparent',
                                color: 'rgba(255,255,255,0.7)',
                                border: '1px solid rgba(255,255,255,0.2)',
                                borderRadius: '4px',
                                fontSize: '11px',
                                cursor: 'pointer',
                              }}
                            >
                              Edit
                            </button>
                            <button
                              onClick={async () => {
                                if (expense.id && confirm('Delete this expense?')) {
                                  await deleteExpenseMutation.mutateAsync(expense.id);
                                }
                              }}
                              style={{
                                padding: '4px 8px',
                                backgroundColor: 'transparent',
                                color: '#ef5350',
                                border: '1px solid rgba(239, 83, 80, 0.3)',
                                borderRadius: '4px',
                                fontSize: '11px',
                                cursor: 'pointer',
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      ))}

                      {expenses.length > 0 && (
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            paddingTop: '12px',
                            borderTop: '1px solid rgba(255,255,255,0.2)',
                            marginTop: '8px',
                          }}
                        >
                          <span style={{ fontSize: '15px', color: '#fff', fontWeight: '700' }}>TOTAL EXPENSES:</span>
                          <span style={{ fontSize: '18px', color: '#c770f0', fontWeight: '700' }}>
                            ${expenses.reduce((sum, e) => sum + (e.quantity * e.rate), 0).toFixed(2)}
                          </span>
                        </div>
                      )}
                    </div>
                  </>
                );
              })()}

              {/* Action Buttons */}
              <div style={{ marginTop: '24px', display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                <button
                  className="button button-secondary"
                  onClick={() => { setSelectedTicket(null); setEditableTicket(null); }}
                  style={{ padding: '10px 24px' }}
                  disabled={isExportingExcel || isExportingPdf}
                >
                  Close
                </button>
                <button
                  className="button button-primary"
                  onClick={async () => {
                    // Ensure expenses are loaded
                    if (currentTicketRecordId && expenses.length === 0) {
                      await loadExpenses(currentTicketRecordId);
                    }
                    // Create a modified ticket with the editable values
                    const modifiedTicket: ServiceTicket = {
                      ...selectedTicket,
                      userName: editableTicket.techName,
                      projectNumber: editableTicket.projectNumber,
                      date: editableTicket.date,
                      ticketNumber: displayTicketNumber,
                      customerInfo: {
                        ...selectedTicket.customerInfo,
                        name: editableTicket.customerName,
                        address: editableTicket.address,
                        city: editableTicket.cityState.split(',')[0]?.trim() || '',
                        state: editableTicket.cityState.split(',')[1]?.trim() || '',
                        zip_code: editableTicket.zipCode,
                        phone: editableTicket.phone,
                        email: editableTicket.email,
                        service_location: editableTicket.serviceLocation,
                        location_code: editableTicket.locationCode,
                        po_number: editableTicket.poNumber,
                        approver_name: editableTicket.approverName,
                      },
                    };
                    handleExportExcel(modifiedTicket);
                  }}
                  style={{ 
                    padding: '10px 24px',
                    backgroundColor: '#4caf50',
                    borderColor: '#4caf50',
                  }}
                  disabled={isExportingExcel || isExportingPdf}
                >
                  {isExportingExcel ? 'Generating Excel...' : 'Export Excel'}
                </button>
                <button
                  className="button button-primary"
                  onClick={async () => {
                    // Ensure expenses are loaded
                    if (currentTicketRecordId && expenses.length === 0) {
                      await loadExpenses(currentTicketRecordId);
                    }
                    // Create a modified ticket with the editable values
                    const modifiedTicket: ServiceTicket = {
                      ...selectedTicket,
                      userName: editableTicket.techName,
                      projectNumber: editableTicket.projectNumber,
                      date: editableTicket.date,
                      ticketNumber: displayTicketNumber,
                      customerInfo: {
                        ...selectedTicket.customerInfo,
                        name: editableTicket.customerName,
                        address: editableTicket.address,
                        city: editableTicket.cityState.split(',')[0]?.trim() || '',
                        state: editableTicket.cityState.split(',')[1]?.trim() || '',
                        zip_code: editableTicket.zipCode,
                        phone: editableTicket.phone,
                        email: editableTicket.email,
                        service_location: editableTicket.serviceLocation,
                        location_code: editableTicket.locationCode,
                        po_number: editableTicket.poNumber,
                        approver_name: editableTicket.approverName,
                      },
                    };
                    handleExportPdf(modifiedTicket);
                  }}
                  style={{ padding: '10px 24px' }}
                  disabled={isExportingExcel || isExportingPdf}
                >
                  {isExportingPdf ? 'Generating PDF...' : 'Export PDF'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

