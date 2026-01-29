import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { serviceTicketsService, customersService, employeesService, serviceTicketExpensesService } from '../services/supabaseServices';
import { groupEntriesIntoTickets, formatTicketDate, generateTicketDisplayId, ServiceTicket, getRateTypeSortOrder } from '../utils/serviceTickets';
import { Link } from 'react-router-dom';
import { downloadExcelServiceTicket } from '../utils/serviceTicketXlsx';
import { downloadPdfFromHtml } from '../utils/pdfFromHtml';
import { supabase } from '../lib/supabaseClient';
import { quickbooksClientService } from '../services/quickbooksService';
import SearchableSelect from '../components/SearchableSelect';

// Workflow status types and labels
const WORKFLOW_STATUSES = {
  draft: { label: 'Draft', color: '#6b7280', icon: '📝' },
  approved: { label: 'Approved', color: '#3b82f6', icon: '✓' },
  pdf_exported: { label: 'PDF Exported', color: '#8b5cf6', icon: '📄' },
  qbo_created: { label: 'QBO Invoice', color: '#f59e0b', icon: '💰' },
  sent_to_cnrl: { label: 'Sent to CNRL', color: '#ec4899', icon: '📧' },
  cnrl_approved: { label: 'CNRL Approved', color: '#10b981', icon: '✅' },
  submitted_to_cnrl: { label: 'Submitted', color: '#059669', icon: '🎉' },
} as const;

type WorkflowStatus = keyof typeof WORKFLOW_STATUSES;

export default function ServiceTickets() {
  const { user, isAdmin } = useAuth();
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
  const [selectedWorkflowStatus, setSelectedWorkflowStatus] = useState<string>('');
  
  // Sorting state - persisted per user in localStorage
  const [sortField, setSortField] = useState<'ticketNumber' | 'date' | 'customerName' | 'userName' | 'totalHours'>(() => {
    const saved = localStorage.getItem(`serviceTickets_sortField_${user?.id}`);
    return (saved as any) || 'date';
  });
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(() => {
    const saved = localStorage.getItem(`serviceTickets_sortDirection_${user?.id}`);
    return (saved as 'asc' | 'desc') || 'desc';
  });
  
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
    other: string;
    techName: string;
    projectNumber: string;
    date: string;
  } | null>(null);
  
  // Editable service descriptions and hours state - new row-based format
  // Each row has a description and hours for each rate type (ST/TT/FT/SO/FO)
  interface ServiceRow {
    id: string;
    description: string;
    st: number;  // Shop Time
    tt: number;  // Travel Time
    ft: number;  // Field Time
    so: number;  // Shop Overtime
    fo: number;  // Field Overtime
  }
  const [serviceRows, setServiceRows] = useState<ServiceRow[]>([]);
  const [isTicketEdited, setIsTicketEdited] = useState(false);
  
  // Legacy state for backward compatibility (used in some exports)
  const [editedDescriptions, setEditedDescriptions] = useState<Record<string, string[]>>({});
  const [editedHours, setEditedHours] = useState<Record<string, number[]>>({});
  
  // Generated ticket number for display
  const [displayTicketNumber, setDisplayTicketNumber] = useState<string>('');
  
  // Bulk selection state
  const [selectedTicketIds, setSelectedTicketIds] = useState<Set<string>>(new Set());
  const [isBulkExporting, setIsBulkExporting] = useState(false);

  // Round to nearest 0.5 hour (always round up)
  const roundToHalfHour = (hours: number): number => {
    return Math.ceil(hours * 2) / 2;
  };

  // Convert time entries to service rows (description + 5 hour columns)
  const entriesToServiceRows = (entries: ServiceTicket['entries']): ServiceRow[] => {
    return entries.map((entry, index) => {
      const rateType = entry.rate_type || 'Shop Time';
      const hours = Number(entry.hours) || 0;
      return {
        id: entry.id || `entry-${index}`,
        description: entry.description || '',
        st: rateType === 'Shop Time' ? hours : 0,
        tt: rateType === 'Travel Time' ? hours : 0,
        ft: rateType === 'Field Time' ? hours : 0,
        so: rateType === 'Shop Overtime' ? hours : 0,
        fo: rateType === 'Field Overtime' ? hours : 0,
      };
    });
  };

  // Convert service rows to legacy format for database storage
  const serviceRowsToLegacyFormat = (rows: ServiceRow[]): { descriptions: Record<string, string[]>, hours: Record<string, number[]> } => {
    const descriptions: Record<string, string[]> = {};
    const hours: Record<string, number[]> = {};
    
    // Process each row and aggregate by rate type
    rows.forEach(row => {
      // Add to Shop Time if has hours
      if (row.st > 0) {
        if (!descriptions['Shop Time']) descriptions['Shop Time'] = [];
        if (!hours['Shop Time']) hours['Shop Time'] = [];
        descriptions['Shop Time'].push(row.description);
        hours['Shop Time'].push(row.st);
      }
      // Add to Travel Time if has hours
      if (row.tt > 0) {
        if (!descriptions['Travel Time']) descriptions['Travel Time'] = [];
        if (!hours['Travel Time']) hours['Travel Time'] = [];
        descriptions['Travel Time'].push(row.description);
        hours['Travel Time'].push(row.tt);
      }
      // Add to Field Time if has hours
      if (row.ft > 0) {
        if (!descriptions['Field Time']) descriptions['Field Time'] = [];
        if (!hours['Field Time']) hours['Field Time'] = [];
        descriptions['Field Time'].push(row.description);
        hours['Field Time'].push(row.ft);
      }
      // Add to Shop Overtime if has hours
      if (row.so > 0) {
        if (!descriptions['Shop Overtime']) descriptions['Shop Overtime'] = [];
        if (!hours['Shop Overtime']) hours['Shop Overtime'] = [];
        descriptions['Shop Overtime'].push(row.description);
        hours['Shop Overtime'].push(row.so);
      }
      // Add to Field Overtime if has hours
      if (row.fo > 0) {
        if (!descriptions['Field Overtime']) descriptions['Field Overtime'] = [];
        if (!hours['Field Overtime']) hours['Field Overtime'] = [];
        descriptions['Field Overtime'].push(row.description);
        hours['Field Overtime'].push(row.fo);
      }
    });
    
    return { descriptions, hours };
  };

  // Handler for exporting ticket as PDF
  const handleExportPdf = async (ticket: ServiceTicket) => {
    setIsExportingPdf(true);
    try {
      // Check if a ticket number already exists in the database
      // In demo mode, existingTickets will already be from the demo table
      const existingRecord = existingTickets?.find(
        et => et.date === ticket.date && 
              et.user_id === ticket.userId && 
              (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
      );
      
      // Debug logging
      if (isDemoMode) {
        console.log('[DEBUG] Demo mode export - Existing tickets count:', existingTickets?.length || 0, 'Found existing record:', !!existingRecord);
      }
      
      // Only use existing ticket number - don't auto-assign
      if (!existingRecord?.ticket_number) {
        alert('This ticket does not have a ticket number assigned. Please assign a ticket number before exporting.');
        setIsExportingPdf(false);
        return;
      }
      
      const ticketNumber = existingRecord.ticket_number;
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
      
      // Invalidate and refetch queries to refresh the ticket list with the new ticket number
      await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
      await queryClient.refetchQueries({ queryKey: ['existingServiceTickets'] });
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
      // Check if a ticket number already exists in the database
      // In demo mode, existingTickets will already be from the demo table
      const existingRecord = existingTickets?.find(
        et => et.date === ticket.date && 
              et.user_id === ticket.userId && 
              (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
      );
      
      // Debug logging
      if (isDemoMode) {
        console.log('[DEBUG] Demo mode export - Existing tickets count:', existingTickets?.length || 0, 'Found existing record:', !!existingRecord);
      }
      
      // Only use existing ticket number - don't auto-assign
      if (!existingRecord?.ticket_number) {
        alert('This ticket does not have a ticket number assigned. Please assign a ticket number before exporting.');
        return;
      }
      
      const ticketNumber = existingRecord.ticket_number;
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
      
      // Invalidate and refetch queries to refresh the ticket list with the new ticket number
      await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
      await queryClient.refetchQueries({ queryKey: ['existingServiceTickets'] });
    } catch (error) {
      console.error('Excel export error:', error);
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
  const getTicketById = (id: string) => filteredTickets.find(t => t.id === id) as ServiceTicket & { displayTicketNumber: string } | undefined;

  // Bulk export to Excel
  const handleBulkExportExcel = async () => {
    setIsBulkExporting(true);
    try {
      const ticketsToExport = Array.from(selectedTicketIds).map(id => getTicketById(id)).filter(Boolean) as (ServiceTicket & { displayTicketNumber: string })[];

      let updatedTicketsList = [...(existingTickets || [])];

      for (const ticket of ticketsToExport) {
        try {
          // Check if a ticket number already exists (check both original list and newly created tickets)
          let existingRecord = updatedTicketsList.find(
            et => et.date === ticket.date && 
                  et.user_id === ticket.userId && 
                  (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
          );
          
          let ticketNumber: string;
          let ticketRecordId: string | undefined;
          
          // Only use existing ticket number - don't auto-assign
          if (!existingRecord?.ticket_number) {
            console.warn(`Skipping ticket ${ticket.id} - no ticket number assigned`);
            continue; // Skip this ticket
          }
          
            ticketNumber = existingRecord.ticket_number;
            ticketRecordId = existingRecord.id;
          
          const ticketWithNumber = { ...ticket, ticketNumber };
          // Load expenses for bulk export
          let ticketExpenses = [];
          if (ticketRecordId) {
            try {
              ticketExpenses = await serviceTicketExpensesService.getByTicketId(ticketRecordId);
            } catch (error) {
              console.error('Error loading expenses for export:', error);
            }
          }
          await downloadExcelServiceTicket(ticketWithNumber, ticketExpenses);

          // Small delay between exports to avoid overwhelming the browser
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error(`Error exporting ticket for ${ticket.date}:`, error);
          // Continue with next ticket even if this one fails
        }
      }

      // Invalidate and refetch queries to refresh the ticket list with new ticket numbers
      await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
      await queryClient.refetchQueries({ queryKey: ['existingServiceTickets'] });
      
      setSelectedTicketIds(new Set());
      alert(`Successfully exported ${ticketsToExport.length} Excel files!`);
    } catch (error) {
      console.error('Bulk Excel export error:', error);
      alert('Error during bulk export. Some files may have been exported.');
    } finally {
      setIsBulkExporting(false);
    }
  };

  // Assign ticket number to a single ticket
  const handleAssignTicketNumber = async (ticket: ServiceTicket) => {
    try {
      // Find or create ticket record
      const existing = existingTickets?.find(
            et => et.date === ticket.date && 
                  et.user_id === ticket.userId && 
                  (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
          );
          
      let ticketRecordId: string;
      const isDemoTicket = ticket.entries.every(entry => entry.is_demo === true);
      
      // Get the next available ticket number ONCE before any database operations
      const ticketNumber = await serviceTicketsService.getNextTicketNumber(ticket.userInitials, isDemoTicket);
      const year = new Date().getFullYear() % 100;
      const sequenceMatch = ticketNumber.match(/\d{3}$/);
      const sequenceNumber = sequenceMatch ? parseInt(sequenceMatch[0]) : 1;
      
      if (existing) {
        if (existing.ticket_number) {
          return; // Already has a ticket number assigned
        }
        ticketRecordId = existing.id;
        // Update existing record with the ticket number
        await serviceTicketsService.updateTicketNumber(ticketRecordId, ticketNumber, isDemoTicket);
      } else {
        // Create ticket record with the ticket number already assigned
        const rtRate = ticket.rates.rt, ttRate = ticket.rates.tt, ftRate = ticket.rates.ft, shopOtRate = ticket.rates.shop_ot, fieldOtRate = ticket.rates.field_ot;
        const rtAmount = ticket.hoursByRateType['Shop Time'] * rtRate;
        const ttAmount = ticket.hoursByRateType['Travel Time'] * ttRate;
        const ftAmount = ticket.hoursByRateType['Field Time'] * ftRate;
        const shopOtAmount = ticket.hoursByRateType['Shop Overtime'] * shopOtRate;
        const fieldOtAmount = ticket.hoursByRateType['Field Overtime'] * fieldOtRate;
        const otAmount = shopOtAmount + fieldOtAmount;
        const totalAmount = rtAmount + ttAmount + ftAmount + otAmount;
        
        const record = await serviceTicketsService.createTicketRecord({
          ticketNumber: ticketNumber,
          employeeInitials: ticket.userInitials,
          year,
          sequenceNumber,
          date: ticket.date,
          customerId: ticket.customerId !== 'unassigned' ? ticket.customerId : undefined,
          userId: ticket.userId,
          projectId: ticket.projectId,
          totalHours: ticket.totalHours,
          totalAmount,
          isDemo: isDemoTicket,
        });
        ticketRecordId = record.id;
      }

      // Refresh the tickets list
      await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
      await queryClient.refetchQueries({ queryKey: ['existingServiceTickets'] });
    } catch (error) {
      console.error('Error assigning ticket number:', error);
    }
  };

  // Unassign ticket number from a single ticket
  const handleUnassignTicketNumber = async (ticket: ServiceTicket) => {
    try {
      const existing = existingTickets?.find(
        et => et.date === ticket.date && 
              et.user_id === ticket.userId && 
              (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
      );

      if (!existing || !existing.ticket_number) {
        return;
      }

      await serviceTicketsService.updateTicketNumber(existing.id, null, isDemoMode);

      // Refresh the tickets list
      await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
      await queryClient.refetchQueries({ queryKey: ['existingServiceTickets'] });
    } catch (error) {
      console.error('Error unassigning ticket number:', error);
    }
  };

  // Bulk assign ticket numbers
  const handleBulkAssignTicketNumbers = async () => {
    try {
      const ticketsToAssign = Array.from(selectedTicketIds)
        .map(id => getTicketById(id))
        .filter((t): t is ServiceTicket & { displayTicketNumber: string } => {
          if (!t) return false;
          const existing = existingTickets?.find(
            et => et.date === t.date && 
                  et.user_id === t.userId && 
                  (et.customer_id === t.customerId || (!et.customer_id && t.customerId === 'unassigned'))
          );
          return !existing?.ticket_number; // Only tickets without ticket numbers
        });

      if (ticketsToAssign.length === 0) {
        return; // No tickets to assign
      }

      for (const ticket of ticketsToAssign) {
        await handleAssignTicketNumber(ticket);
      }

      setSelectedTicketIds(new Set());
    } catch (error) {
      console.error('Error in bulk assign:', error);
    }
  };

  // Bulk unassign ticket numbers
  const handleBulkUnassignTicketNumbers = async () => {
    try {
      const ticketsToUnassign = Array.from(selectedTicketIds)
        .map(id => getTicketById(id))
        .filter((t): t is ServiceTicket & { displayTicketNumber: string } => {
          if (!t) return false;
          const existing = existingTickets?.find(
            et => et.date === t.date && 
                  et.user_id === t.userId && 
                  (et.customer_id === t.customerId || (!et.customer_id && t.customerId === 'unassigned'))
          );
          return existing?.ticket_number !== undefined && existing.ticket_number !== null;
        });

      if (ticketsToUnassign.length === 0) {
        return;
      }

      for (const ticket of ticketsToUnassign) {
        await handleUnassignTicketNumber(ticket);
      }

      setSelectedTicketIds(new Set());
    } catch (error) {
      console.error('Error in bulk unassign:', error);
    }
  };

  // Bulk export to PDF
  const handleBulkExportPdf = async () => {
    setIsBulkExporting(true);
    try {
      const ticketsToExport = Array.from(selectedTicketIds).map(id => getTicketById(id)).filter(Boolean) as (ServiceTicket & { displayTicketNumber: string })[];
      
      let updatedTicketsList = [...(existingTickets || [])];
      
      for (const ticket of ticketsToExport) {
        try {
          // Check if a ticket number already exists (check both original list and newly created tickets)
          let existingRecord = updatedTicketsList.find(
            et => et.date === ticket.date && 
                  et.user_id === ticket.userId && 
                  (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
          );
          
          let ticketNumber: string;
          let ticketRecordId: string | undefined;
          
          // Only use existing ticket number - don't auto-assign
          if (!existingRecord?.ticket_number) {
            console.warn(`Skipping ticket ${ticket.id} - no ticket number assigned`);
            continue; // Skip this ticket
          }
          
          ticketNumber = existingRecord.ticket_number;
          ticketRecordId = existingRecord.id;
          
          const ticketWithNumber = { ...ticket, ticketNumber };
          // Load expenses for bulk export
          let ticketExpenses = [];
          if (ticketRecordId) {
            try {
              ticketExpenses = await serviceTicketExpensesService.getByTicketId(ticketRecordId);
            } catch (error) {
              console.error('Error loading expenses for export:', error);
            }
          }
          
          await downloadPdfFromHtml(ticketWithNumber, ticketExpenses);
          
          // Small delay between exports to avoid overwhelming the browser
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error(`Error exporting ticket for ${ticket.date}:`, error);
          // Continue with next ticket even if this one fails
        }
      }
      
      // Invalidate and refetch queries to refresh the ticket list with new ticket numbers
      await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
      await queryClient.refetchQueries({ queryKey: ['existingServiceTickets'] });
      
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
    queryKey: ['billableEntries', startDate, endDate, selectedCustomerId, selectedUserId, isDemoMode],
    queryFn: () => serviceTicketsService.getBillableEntries({
      startDate,
      endDate,
      customerId: selectedCustomerId || undefined,
      userId: selectedUserId || undefined,
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

  // Fetch current user's employee record to check department
  const { data: currentEmployee } = useQuery({
    queryKey: ['currentEmployee', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data, error } = await supabase
        .from('employees')
        .select('*')
        .eq('user_id', user.id)
        .single();
      if (error && error.code !== 'PGRST116') throw error;
      return data;
    },
    enabled: !!user?.id,
  });

  // Role-based access control
  const isAutomationDepartment = currentEmployee?.department === 'Automation';
  const canAccessPage = isAdmin || isAutomationDepartment;

  // Group entries into tickets (with employee rates)
  // Fetch existing ticket numbers and edited hours for display (from appropriate table based on demo mode)
  const { data: existingTickets } = useQuery({
    queryKey: ['existingServiceTickets', isDemoMode],
    queryFn: async () => {
      const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
      const { data, error } = await supabase
        .from(tableName)
        .select('id, ticket_number, date, user_id, customer_id, is_edited, edited_hours, workflow_status');
      if (error) throw error;
      return data;
    },
  });

  const tickets = useMemo(() => {
    if (!billableEntries) return [];
    const baseTickets = groupEntriesIntoTickets(billableEntries, employees);
    
    // Merge edited hours from database into tickets
    if (existingTickets && existingTickets.length > 0) {
      return baseTickets.map(ticket => {
        // Find matching ticket record in database
        const ticketRecord = existingTickets.find(
          et => et.date === ticket.date && 
                et.user_id === ticket.userId && 
                (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
        );
        
        // If ticket has been edited, use edited hours instead of original
        if (ticketRecord?.is_edited && ticketRecord.edited_hours) {
          const editedHours = ticketRecord.edited_hours as Record<string, number | number[]>;
          const updatedHoursByRateType = { ...ticket.hoursByRateType };
          
          // Sum edited hours for each rate type
          Object.keys(editedHours).forEach(rateType => {
            const hours = editedHours[rateType];
            if (Array.isArray(hours)) {
              updatedHoursByRateType[rateType as keyof typeof updatedHoursByRateType] = hours.reduce((sum, h) => sum + (h || 0), 0);
            } else {
              updatedHoursByRateType[rateType as keyof typeof updatedHoursByRateType] = hours as number;
            }
          });
          
          // Recalculate total hours
          const totalHours = Object.values(updatedHoursByRateType).reduce((sum, h) => sum + h, 0);
          
          return {
            ...ticket,
            hoursByRateType: updatedHoursByRateType,
            totalHours,
          };
        }
        
        return ticket;
      });
    }
    
    return baseTickets;
  }, [billableEntries, employees, existingTickets]);

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
    
    const rtRate = ticket.rates.rt, ttRate = ticket.rates.tt, ftRate = ticket.rates.ft, shopOtRate = ticket.rates.shop_ot, fieldOtRate = ticket.rates.field_ot;
    const rtAmount = ticket.hoursByRateType['Shop Time'] * rtRate;
    const ttAmount = ticket.hoursByRateType['Travel Time'] * ttRate;
    const ftAmount = ticket.hoursByRateType['Field Time'] * ftRate;
    const shopOtAmount = ticket.hoursByRateType['Shop Overtime'] * shopOtRate;
    const fieldOtAmount = ticket.hoursByRateType['Field Overtime'] * fieldOtRate;
    const otAmount = shopOtAmount + fieldOtAmount;
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
      // Check if this is a demo ticket (all entries are demo)
      const isDemoTicket = ticket.entries.every(entry => entry.is_demo === true);
      
      // Try to find an existing ticket number for this ticket
      const existing = existingTickets?.find(
        et => et.date === ticket.date && 
              et.user_id === ticket.userId && 
              (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
      );
      
      // If there's an existing ticket number, use it (even for demo tickets)
      if (existing?.ticket_number) {
        return {
          ...ticket,
          displayTicketNumber: existing.ticket_number
        };
      }
      
      // Otherwise, show XXX placeholder
      return {
        ...ticket,
        displayTicketNumber: `${ticket.userInitials}_${new Date(ticket.date).getFullYear() % 100}XXX`
      };
    });
  }, [tickets, existingTickets]);

  // Filter and sort tickets
  const filteredTickets = useMemo(() => {
    let result = ticketsWithNumbers;
    
    // Non-admin users can only see their own tickets
    if (!isAdmin && user?.id) {
      result = result.filter(t => t.userId === user.id);
    }
    
    if (selectedCustomerId) {
      result = result.filter(t => t.customerId === selectedCustomerId);
    }
    
    // Filter by workflow status (only for admins)
    if (isAdmin && selectedWorkflowStatus) {
      result = result.filter(t => {
        const existing = existingTickets?.find(
          et => et.date === t.date && 
                et.user_id === t.userId && 
                (et.customer_id === t.customerId || (!et.customer_id && t.customerId === 'unassigned'))
        );
        const workflowStatus = existing?.workflow_status || 'draft';
        return workflowStatus === selectedWorkflowStatus;
      });
    }
    
    // Sort tickets
    result = [...result].sort((a, b) => {
      let aVal: string | number;
      let bVal: string | number;
      
      switch (sortField) {
        case 'ticketNumber':
          aVal = a.displayTicketNumber || a.ticketNumber || '';
          bVal = b.displayTicketNumber || b.ticketNumber || '';
          break;
        case 'date':
          aVal = a.date;
          bVal = b.date;
          break;
        case 'customerName':
          aVal = a.customerName.toLowerCase();
          bVal = b.customerName.toLowerCase();
          break;
        case 'userName':
          aVal = a.userName.toLowerCase();
          bVal = b.userName.toLowerCase();
          break;
        case 'totalHours':
          aVal = a.totalHours;
          bVal = b.totalHours;
          break;
        default:
          return 0;
      }
      
      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
    
    return result;
  }, [ticketsWithNumbers, selectedCustomerId, selectedWorkflowStatus, existingTickets, sortField, sortDirection, isAdmin, user?.id]);
  
  // Toggle sort function - saves to localStorage per user
  const handleSort = (field: typeof sortField) => {
    let newDirection: 'asc' | 'desc';
    if (sortField === field) {
      newDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      setSortDirection(newDirection);
    } else {
      newDirection = 'asc';
      setSortField(field);
      setSortDirection(newDirection);
      if (user?.id) localStorage.setItem(`serviceTickets_sortField_${user.id}`, field);
    }
    if (user?.id) localStorage.setItem(`serviceTickets_sortDirection_${user.id}`, newDirection);
  };

  if (!canAccessPage) {
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
            <SearchableSelect
              options={customers?.map((customer: any) => ({
                value: customer.id,
                label: customer.name,
              })) || []}
              value={selectedCustomerId}
              onChange={(value) => setSelectedCustomerId(value)}
              placeholder="Search customers..."
              emptyOption={{ value: '', label: 'All Customers' }}
            />
          </div>
          {/* Employee filter - only visible to admins (non-admins only see their own tickets) */}
          {isAdmin && (
            <div>
              <label className="label">Employee</label>
              <SearchableSelect
                options={employees?.map((employee: any) => ({
                  value: employee.user_id,
                  label: `${employee.user?.first_name || ''} ${employee.user?.last_name || ''}`.trim(),
                })) || []}
                value={selectedUserId}
                onChange={(value) => setSelectedUserId(value)}
                placeholder="Search employees..."
                emptyOption={{ value: '', label: 'All Employees' }}
              />
            </div>
          )}
          {/* Workflow Status filter - only visible to admins */}
          {isAdmin && (
            <div>
              <label className="label">Workflow Status</label>
              <SearchableSelect
                options={Object.entries(WORKFLOW_STATUSES).map(([key, { label, icon }]) => ({
                  value: key,
                  label: `${icon} ${label}`,
                }))}
                value={selectedWorkflowStatus}
                onChange={(value) => setSelectedWorkflowStatus(value)}
                placeholder="Search statuses..."
                emptyOption={{ value: '', label: 'All Statuses' }}
              />
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
                onClick={handleBulkAssignTicketNumbers}
                disabled={isBulkExporting}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#4caf50',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '13px',
                  fontWeight: '500',
                  cursor: isBulkExporting ? 'not-allowed' : 'pointer',
                  opacity: isBulkExporting ? 0.6 : 1,
                }}
              >
                ✓ Approve Selected
              </button>
              <button
                onClick={handleBulkUnassignTicketNumbers}
                disabled={isBulkExporting}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#f59e0b',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '13px',
                  fontWeight: '500',
                  cursor: isBulkExporting ? 'not-allowed' : 'pointer',
                  opacity: isBulkExporting ? 0.6 : 1,
                }}
              >
                ✗ Unapprove Selected
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
                    style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--primary-color)' }}
                    title="Select all"
                  />
                </th>
                <th 
                  onClick={() => handleSort('ticketNumber')}
                  style={{ padding: '16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', cursor: 'pointer', userSelect: 'none' }}
                >
                  Ticket ID {sortField === 'ticketNumber' && (sortDirection === 'asc' ? '▲' : '▼')}
                </th>
                <th 
                  onClick={() => handleSort('date')}
                  style={{ padding: '16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', cursor: 'pointer', userSelect: 'none' }}
                >
                  Date {sortField === 'date' && (sortDirection === 'asc' ? '▲' : '▼')}
                </th>
                <th 
                  onClick={() => handleSort('customerName')}
                  style={{ padding: '16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', cursor: 'pointer', userSelect: 'none' }}
                >
                  Customer {sortField === 'customerName' && (sortDirection === 'asc' ? '▲' : '▼')}
                </th>
                <th 
                  onClick={() => handleSort('userName')}
                  style={{ padding: '16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', cursor: 'pointer', userSelect: 'none' }}
                >
                  Tech {sortField === 'userName' && (sortDirection === 'asc' ? '▲' : '▼')}
                </th>
                <th 
                  onClick={() => handleSort('totalHours')}
                  style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', cursor: 'pointer', userSelect: 'none' }}
                >
                  Total Hours {sortField === 'totalHours' && (sortDirection === 'asc' ? '▲' : '▼')}
                </th>
                <th style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  ST
                </th>
                <th style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  TT
                </th>
                <th style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  FT
                </th>
                <th style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  SO
                </th>
                <th style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  FO
                </th>
                <th style={{ padding: '16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  Action
                </th>
                {/* Workflow column - only visible to admins */}
                {isAdmin && (
                  <th style={{ padding: '16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                    Workflow
                  </th>
                )}
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
                    // Use project defaults if available, otherwise fall back to customer info
                    serviceLocation: ticket.projectLocation || ticket.customerInfo.service_location || ticket.customerInfo.address || '',
                    locationCode: ticket.customerInfo.location_code || '',
                    poNumber: ticket.customerInfo.po_number || '',
                    approverName: ticket.projectApproverPoAfe || [ticket.customerInfo.approver_name, ticket.customerInfo.po_number, ticket.customerInfo.location_code].filter(Boolean).join(' / ') || '',
                    other: ticket.projectOther || '',
                    techName: ticket.userName || '',
                    projectNumber: ticket.projectNumber || '',
                    date: ticket.date || '',
                  });
                  
                  // Set display ticket number (will be XXX until exported)
                  setDisplayTicketNumber(ticket.displayTicketNumber);

                  // Load expenses and edited data for this ticket
                  try {
                    const ticketRecordId = await getOrCreateTicketRecord(ticket);
                    setCurrentTicketRecordId(ticketRecordId);
                    await loadExpenses(ticketRecordId);
                    
                    // Load edited descriptions and hours
                    const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
                    const { data: ticketRecord } = await supabase
                      .from(tableName)
                      .select('is_edited, edited_descriptions, edited_hours')
                      .eq('id', ticketRecordId)
                      .single();
                    
                    if (ticketRecord && ticketRecord.is_edited) {
                      setIsTicketEdited(true);
                      const loadedDescriptions = (ticketRecord.edited_descriptions as Record<string, string[]>) || {};
                      const loadedHours = (ticketRecord.edited_hours as Record<string, number | number[]>) || {};
                      
                      // Convert legacy format to service rows
                      // Collect all unique descriptions and their hours across rate types
                      const rowMap = new Map<string, ServiceRow>();
                      let rowIndex = 0;
                      
                      Object.keys(loadedDescriptions).forEach(rateType => {
                        const descs = loadedDescriptions[rateType] || [];
                        const hrs = loadedHours[rateType];
                        const hoursArray = Array.isArray(hrs) ? hrs : (hrs !== undefined ? [hrs as number] : []);
                        
                        descs.forEach((desc, i) => {
                          const hours = hoursArray[i] || 0;
                          // Use description as key for grouping (or create unique row)
                          const key = `${desc}-${rowIndex++}`;
                          const row: ServiceRow = {
                            id: key,
                            description: desc,
                            st: rateType === 'Shop Time' ? hours : 0,
                            tt: rateType === 'Travel Time' ? hours : 0,
                            ft: rateType === 'Field Time' ? hours : 0,
                            so: rateType === 'Shop Overtime' ? hours : 0,
                            fo: rateType === 'Field Overtime' ? hours : 0,
                          };
                          rowMap.set(key, row);
                        });
                      });
                      
                      setServiceRows(Array.from(rowMap.values()));
                      setEditedDescriptions(loadedDescriptions);
                      setEditedHours(
                        Object.keys(loadedHours).reduce((acc, rateType) => {
                          const hrs = loadedHours[rateType];
                          acc[rateType] = Array.isArray(hrs) ? hrs : [hrs as number];
                          return acc;
                        }, {} as Record<string, number[]>)
                      );
                    } else {
                      setIsTicketEdited(false);
                      // Initialize service rows from time entries
                      setServiceRows(entriesToServiceRows(ticket.entries));
                      setEditedDescriptions({});
                      setEditedHours({});
                    }
                  } catch (error) {
                    console.error('Error loading ticket data:', error);
                    setExpenses([]);
                    setIsTicketEdited(false);
                    setServiceRows(entriesToServiceRows(ticket.entries));
                    setEditedDescriptions({});
                    setEditedHours({});
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
                      style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--primary-color)' }}
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
                    {ticket.hoursByRateType['Travel Time'].toFixed(1)}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {ticket.hoursByRateType['Field Time'].toFixed(1)}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {ticket.hoursByRateType['Shop Overtime'].toFixed(1)}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {ticket.hoursByRateType['Field Overtime'].toFixed(1)}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                    {(() => {
                      const existing = existingTickets?.find(
                        et => et.date === ticket.date && 
                              et.user_id === ticket.userId && 
                              (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
                      );
                      const hasTicketNumber = existing?.ticket_number;
                      
                      return hasTicketNumber ? (
                        <button
                          className="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleUnassignTicketNumber(ticket);
                          }}
                          style={{
                            padding: '6px 16px',
                            fontSize: '13px',
                            backgroundColor: '#4caf50',
                            color: 'white',
                            border: 'none',
                            cursor: 'pointer',
                          }}
                          title="Click to unapprove"
                        >
                          ✓ Approved
                        </button>
                      ) : (
                        <button
                          className="button button-primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleAssignTicketNumber(ticket);
                          }}
                          style={{
                            padding: '6px 16px',
                            fontSize: '13px',
                            cursor: 'pointer',
                          }}
                          title="Approve and assign ticket number"
                        >
                          Approve
                        </button>
                      );
                    })()}
                  </td>
                  {/* Workflow status cell - only visible to admins */}
                  {isAdmin && (
                    <td style={{ padding: '16px', textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                      {(() => {
                        const existing = existingTickets?.find(
                          et => et.date === ticket.date && 
                                et.user_id === ticket.userId && 
                                (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
                        );
                        const workflowStatus = (existing?.workflow_status || 'draft') as WorkflowStatus;
                        const statusInfo = WORKFLOW_STATUSES[workflowStatus] || WORKFLOW_STATUSES.draft;
                        
                        return (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '4px 10px',
                              borderRadius: '12px',
                              fontSize: '11px',
                              fontWeight: '500',
                              backgroundColor: `${statusInfo.color}20`,
                              color: statusInfo.color,
                              whiteSpace: 'nowrap',
                            }}
                            title={`Status: ${statusInfo.label}`}
                          >
                            {statusInfo.icon} {statusInfo.label}
                          </span>
                        );
                      })()}
                    </td>
                  )}
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
          onClick={() => { 
            setSelectedTicket(null); 
            setEditableTicket(null);
            setServiceRows([]);
            setEditedDescriptions({});
            setEditedHours({});
            setIsTicketEdited(false);
          }}
        >
          <div
            style={{
              backgroundColor: 'var(--bg-primary)',
              borderRadius: '12px',
              maxWidth: '900px',
              width: '100%',
              maxHeight: '90vh',
              overflow: 'auto',
              boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
              border: '1px solid var(--border-color)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <style>{`
              .service-ticket-textarea::-webkit-scrollbar {
                width: 8px;
              }
              .service-ticket-textarea::-webkit-scrollbar-track {
                background: transparent;
              }
              .service-ticket-textarea::-webkit-scrollbar-thumb {
                background: var(--primary-light);
                border-radius: 4px;
              }
              .service-ticket-textarea::-webkit-scrollbar-thumb:hover {
                background: var(--primary-color);
              }
            `}</style>
            {/* Ticket Header */}
            <div
              style={{
                padding: '24px',
                borderBottom: '1px solid var(--border-color)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <h2 style={{ fontSize: '24px', fontWeight: '700', color: 'var(--text-primary)', margin: '0 0 8px 0' }}>
                  SERVICE TICKET
                </h2>
                <p style={{ fontSize: '14px', color: 'var(--text-secondary)', margin: 0 }}>
                  Ticket: {displayTicketNumber || 'Loading...'}
                </p>
              </div>
              <button
                onClick={() => { 
                  setSelectedTicket(null); 
                  setEditableTicket(null);
                  setServiceRows([]);
                  setEditedDescriptions({});
                  setEditedHours({});
                  setIsTicketEdited(false);
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: '24px',
                  color: 'var(--text-secondary)',
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
                  backgroundColor: 'var(--bg-tertiary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  outline: 'none',
                };
                const labelStyle: React.CSSProperties = {
                  display: 'block',
                  fontSize: '11px',
                  fontWeight: '600',
                  color: 'var(--text-secondary)',
                  marginBottom: '4px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                };
                const sectionStyle: React.CSSProperties = {
                  backgroundColor: 'var(--bg-secondary)',
                  borderRadius: '8px',
                  padding: '16px',
                  marginBottom: '16px',
                  border: '1px solid var(--border-color)',
                };
                const sectionTitleStyle: React.CSSProperties = {
                  fontSize: '12px',
                  fontWeight: '700',
                  textTransform: 'uppercase',
                  color: 'var(--primary-color)',
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
                          <div>
                            <label style={labelStyle}>Contact Name</label>
                            <input
                              style={inputStyle}
                              value={editableTicket.contactName}
                              onChange={(e) => setEditableTicket({ ...editableTicket, contactName: e.target.value })}
                            />
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
                          <div>
                            <label style={labelStyle}>Approver / PO / AFE</label>
                            <input
                              style={inputStyle}
                              value={editableTicket.approverName}
                              onChange={(e) => setEditableTicket({ ...editableTicket, approverName: e.target.value })}
                            />
                          </div>
                          <div>
                            <label style={labelStyle}>Other</label>
                            <input
                              style={inputStyle}
                              value={editableTicket.other}
                              onChange={(e) => setEditableTicket({ ...editableTicket, other: e.target.value })}
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Service Description Section - Row-based with 5 hour columns */}
                    <div style={sectionStyle}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                        <h3 style={sectionTitleStyle}>Service Description</h3>
                        {isTicketEdited && (
                          <span style={{ 
                            fontSize: '11px', 
                            color: 'var(--primary-color)', 
                            padding: '4px 8px', 
                            backgroundColor: 'var(--primary-light)', 
                            borderRadius: '4px',
                            fontWeight: '600'
                          }}>
                            EDITED - Time entries won't update this ticket
                          </span>
                        )}
                      </div>
                      
                      {/* Column Headers */}
                      <div style={{ 
                        display: 'grid', 
                        gridTemplateColumns: '1fr 55px 55px 55px 55px 55px 40px',
                        gap: '8px',
                        marginBottom: '8px',
                        paddingBottom: '8px',
                        borderBottom: '1px solid var(--border-color)'
                      }}>
                        <span style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)' }}>Description</span>
                        <span style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textAlign: 'center' }}>ST</span>
                        <span style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textAlign: 'center' }}>TT</span>
                        <span style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textAlign: 'center' }}>FT</span>
                        <span style={{ fontSize: '11px', fontWeight: '600', color: '#ff9800', textAlign: 'center' }}>SO</span>
                        <span style={{ fontSize: '11px', fontWeight: '600', color: '#ff9800', textAlign: 'center' }}>FO</span>
                        <span></span>
                      </div>
                      
                      {/* Service Rows */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {serviceRows.map((row, index) => (
                          <div 
                            key={row.id} 
                            style={{ 
                              display: 'grid', 
                              gridTemplateColumns: '1fr 55px 55px 55px 55px 55px 40px',
                              gap: '8px',
                              alignItems: 'center',
                              padding: '8px',
                              backgroundColor: 'var(--bg-tertiary)',
                              borderRadius: '6px'
                            }}
                          >
                            <textarea
                              value={row.description}
                              onChange={(e) => {
                                const newRows = [...serviceRows];
                                newRows[index] = { ...row, description: e.target.value };
                                setServiceRows(newRows);
                                setIsTicketEdited(true);
                                // Update legacy format
                                const legacy = serviceRowsToLegacyFormat(newRows);
                                setEditedDescriptions(legacy.descriptions);
                                setEditedHours(legacy.hours);
                              }}
                              style={{
                                ...inputStyle,
                                minHeight: '60px',
                                resize: 'none',
                                fontFamily: 'inherit',
                                fontSize: '13px',
                              }}
                              placeholder="Enter description..."
                            />
                            <input
                              type="number"
                              step="0.5"
                              min="0"
                              value={row.st || ''}
                              onChange={(e) => {
                                const newRows = [...serviceRows];
                                newRows[index] = { ...row, st: parseFloat(e.target.value) || 0 };
                                setServiceRows(newRows);
                                setIsTicketEdited(true);
                                const legacy = serviceRowsToLegacyFormat(newRows);
                                setEditedDescriptions(legacy.descriptions);
                                setEditedHours(legacy.hours);
                              }}
                              style={{
                                ...inputStyle,
                                padding: '6px 4px',
                                textAlign: 'center',
                                fontSize: '13px',
                              }}
                              title="Shop Time"
                            />
                            <input
                              type="number"
                              step="0.5"
                              min="0"
                              value={row.tt || ''}
                              onChange={(e) => {
                                const newRows = [...serviceRows];
                                newRows[index] = { ...row, tt: parseFloat(e.target.value) || 0 };
                                setServiceRows(newRows);
                                setIsTicketEdited(true);
                                const legacy = serviceRowsToLegacyFormat(newRows);
                                setEditedDescriptions(legacy.descriptions);
                                setEditedHours(legacy.hours);
                              }}
                              style={{
                                ...inputStyle,
                                padding: '6px 4px',
                                textAlign: 'center',
                                fontSize: '13px',
                              }}
                              title="Travel Time"
                            />
                            <input
                              type="number"
                              step="0.5"
                              min="0"
                              value={row.ft || ''}
                              onChange={(e) => {
                                const newRows = [...serviceRows];
                                newRows[index] = { ...row, ft: parseFloat(e.target.value) || 0 };
                                setServiceRows(newRows);
                                setIsTicketEdited(true);
                                const legacy = serviceRowsToLegacyFormat(newRows);
                                setEditedDescriptions(legacy.descriptions);
                                setEditedHours(legacy.hours);
                              }}
                              style={{
                                ...inputStyle,
                                padding: '6px 4px',
                                textAlign: 'center',
                                fontSize: '13px',
                              }}
                              title="Field Time"
                            />
                            <input
                              type="number"
                              step="0.5"
                              min="0"
                              value={row.so || ''}
                              onChange={(e) => {
                                const newRows = [...serviceRows];
                                newRows[index] = { ...row, so: parseFloat(e.target.value) || 0 };
                                setServiceRows(newRows);
                                setIsTicketEdited(true);
                                const legacy = serviceRowsToLegacyFormat(newRows);
                                setEditedDescriptions(legacy.descriptions);
                                setEditedHours(legacy.hours);
                              }}
                              style={{
                                ...inputStyle,
                                padding: '6px 4px',
                                textAlign: 'center',
                                fontSize: '13px',
                                backgroundColor: 'rgba(255, 152, 0, 0.1)',
                              }}
                              title="Shop Overtime"
                            />
                            <input
                              type="number"
                              step="0.5"
                              min="0"
                              value={row.fo || ''}
                              onChange={(e) => {
                                const newRows = [...serviceRows];
                                newRows[index] = { ...row, fo: parseFloat(e.target.value) || 0 };
                                setServiceRows(newRows);
                                setIsTicketEdited(true);
                                const legacy = serviceRowsToLegacyFormat(newRows);
                                setEditedDescriptions(legacy.descriptions);
                                setEditedHours(legacy.hours);
                              }}
                              style={{
                                ...inputStyle,
                                padding: '6px 4px',
                                textAlign: 'center',
                                fontSize: '13px',
                                backgroundColor: 'rgba(255, 152, 0, 0.1)',
                              }}
                              title="Field Overtime"
                            />
                            <button
                              onClick={() => {
                                const newRows = serviceRows.filter((_, i) => i !== index);
                                setServiceRows(newRows);
                                setIsTicketEdited(true);
                                const legacy = serviceRowsToLegacyFormat(newRows);
                                setEditedDescriptions(legacy.descriptions);
                                setEditedHours(legacy.hours);
                              }}
                              style={{
                                padding: '4px 8px',
                                backgroundColor: 'transparent',
                                color: '#ef5350',
                                border: '1px solid rgba(239, 83, 80, 0.3)',
                                borderRadius: '4px',
                                fontSize: '11px',
                                cursor: 'pointer',
                                alignSelf: 'center',
                              }}
                              title="Remove row"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                        
                        {/* Totals Row */}
                        <div 
                          style={{ 
                            display: 'grid', 
                            gridTemplateColumns: '1fr 55px 55px 55px 55px 55px 40px',
                            gap: '8px',
                            alignItems: 'center',
                            padding: '10px 8px',
                            backgroundColor: 'var(--bg-secondary)',
                            borderRadius: '6px',
                            borderTop: '2px solid var(--border-color)',
                            marginTop: '8px',
                          }}
                        >
                          <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)' }}>TOTAL HOURS:</span>
                          <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)', textAlign: 'center' }}>
                            {roundToHalfHour(serviceRows.reduce((sum, r) => sum + (r.st || 0), 0)).toFixed(1)}
                          </span>
                          <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)', textAlign: 'center' }}>
                            {roundToHalfHour(serviceRows.reduce((sum, r) => sum + (r.tt || 0), 0)).toFixed(1)}
                          </span>
                          <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)', textAlign: 'center' }}>
                            {roundToHalfHour(serviceRows.reduce((sum, r) => sum + (r.ft || 0), 0)).toFixed(1)}
                          </span>
                          <span style={{ fontSize: '13px', fontWeight: '700', color: '#ff9800', textAlign: 'center' }}>
                            {roundToHalfHour(serviceRows.reduce((sum, r) => sum + (r.so || 0), 0)).toFixed(1)}
                          </span>
                          <span style={{ fontSize: '13px', fontWeight: '700', color: '#ff9800', textAlign: 'center' }}>
                            {roundToHalfHour(serviceRows.reduce((sum, r) => sum + (r.fo || 0), 0)).toFixed(1)}
                          </span>
                          <span style={{ fontSize: '14px', fontWeight: '700', color: 'var(--primary-color)', textAlign: 'center' }}>
                            {roundToHalfHour(serviceRows.reduce((sum, r) => 
                              sum + (r.st || 0) + (r.tt || 0) + (r.ft || 0) + (r.so || 0) + (r.fo || 0), 0)).toFixed(1)}
                          </span>
                        </div>
                        
                        {/* Add Row Button */}
                        <button
                          onClick={() => {
                            const newRow: ServiceRow = {
                              id: `new-${Date.now()}`,
                              description: '',
                              st: 0,
                              tt: 0,
                              ft: 0,
                              so: 0,
                              fo: 0,
                            };
                            const newRows = [...serviceRows, newRow];
                            setServiceRows(newRows);
                            setIsTicketEdited(true);
                          }}
                          style={{
                            padding: '8px 16px',
                            backgroundColor: 'var(--primary-light)',
                            color: 'var(--primary-color)',
                            border: '1px solid rgba(199, 112, 240, 0.3)',
                            borderRadius: '6px',
                            fontSize: '12px',
                            fontWeight: '600',
                            cursor: 'pointer',
                            alignSelf: 'flex-start',
                            marginTop: '8px',
                          }}
                        >
                          + Add Row
                        </button>
                        
                        {/* Legend */}
                        <div style={{ 
                          marginTop: '12px', 
                          fontSize: '10px', 
                          color: 'var(--text-tertiary)',
                          display: 'flex',
                          gap: '16px',
                          flexWrap: 'wrap'
                        }}>
                          <span>ST = Shop Time</span>
                          <span>TT = Travel Time</span>
                          <span>FT = Field Time</span>
                          <span style={{ color: '#ff9800' }}>SO = Shop Overtime</span>
                          <span style={{ color: '#ff9800' }}>FO = Field Overtime</span>
                        </div>
                      </div>
                      
                      {/* Save Button */}
                      {isTicketEdited && (
                        <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.2)' }}>
                          <button
                            onClick={async () => {
                              if (!currentTicketRecordId || !selectedTicket) return;
                              
                              // Convert service rows to legacy format for storage
                              const legacy = serviceRowsToLegacyFormat(serviceRows);
                              
                              // Calculate total hours and total amount
                              let totalEditedHours = 0;
                              let totalAmount = 0;
                              
                              serviceRows.forEach(row => {
                                totalEditedHours += row.st + row.tt + row.ft + row.so + row.fo;
                                totalAmount += row.st * (selectedTicket.rates.rt || 0);
                                totalAmount += row.tt * (selectedTicket.rates.tt || 0);
                                totalAmount += row.ft * (selectedTicket.rates.ft || 0);
                                totalAmount += row.so * (selectedTicket.rates.shop_ot || 0);
                                totalAmount += row.fo * (selectedTicket.rates.field_ot || 0);
                              });
                              
                              // Round up hours to nearest 0.5
                              totalEditedHours = Math.ceil(totalEditedHours * 2) / 2;
                              
                              const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
                              const { error } = await supabase
                                .from(tableName)
                                .update({
                                  is_edited: true,
                                  edited_descriptions: legacy.descriptions,
                                  edited_hours: legacy.hours,
                                  total_hours: totalEditedHours,
                                  total_amount: totalAmount,
                                })
                                .eq('id', currentTicketRecordId);
                              
                              if (error) {
                                console.error('Error saving edited ticket:', error);
                                alert('Failed to save edited ticket data.');
                              } else {
                                alert('Service ticket saved successfully.');
                                queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
                              }
                            }}
                            style={{
                              padding: '10px 20px',
                              backgroundColor: 'var(--primary-color)',
                              color: 'white',
                              border: 'none',
                              borderRadius: '6px',
                              fontSize: '13px',
                              fontWeight: '600',
                              cursor: 'pointer',
                            }}
                          >
                            Save Service Ticket
                          </button>
                        </div>
                      )}
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
                                description: 'Mileage',
                                quantity: 1,
                                rate: 1,
                                unit: 'km',
                              });
                            }}
                            style={{
                              padding: '6px 12px',
                              backgroundColor: 'var(--primary-color)',
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
                        <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>
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
                                style={{
                                  ...inputStyle,
                                  backgroundColor: 'var(--bg-tertiary)',
                                  color: 'var(--text-primary)',
                                  cursor: 'pointer',
                                }}
                                value={editingExpense.expense_type}
                                onChange={(e) => {
                                  const selectedType = e.target.value as 'Travel' | 'Subsistence' | 'Expenses' | 'Equipment';
                                  // Auto-fill default values based on type
                                  let defaults = { unit: '', description: '', quantity: 1, rate: 0 };
                                  
                                  // Map display types to database types and set defaults
                                  if (selectedType === 'Travel') {
                                    // Mileage
                                    defaults = { unit: 'km', description: 'Mileage', quantity: 1, rate: 1 };
                                  } else if (selectedType === 'Subsistence') {
                                    // Per Diem
                                    defaults = { unit: 'Day', description: 'Per Diem', quantity: 1, rate: 60 };
                                  } else if (selectedType === 'Equipment') {
                                    // Equipment Billout
                                    defaults = { unit: 'unit', description: 'Equipment Billout', quantity: 1, rate: 10 };
                                  } else if (selectedType === 'Expenses') {
                                    // Other - all empty
                                    defaults = { unit: '', description: '', quantity: 0, rate: 0 };
                                  }
                                  
                                  setEditingExpense({
                                    ...editingExpense,
                                    expense_type: selectedType,
                                    unit: defaults.unit,
                                    description: defaults.description,
                                    quantity: defaults.quantity,
                                    rate: defaults.rate,
                                  });
                                }}
                              >
                                <option value="Travel">Mileage</option>
                                <option value="Subsistence">Per Diem</option>
                                <option value="Equipment">Equipment Billout</option>
                                <option value="Expenses">Other</option>
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
                                min="0"
                                style={inputStyle}
                                value={editingExpense.quantity || ''}
                                onChange={(e) => {
                                  const val = e.target.value === '' ? 0 : parseFloat(e.target.value);
                                  setEditingExpense({ ...editingExpense, quantity: isNaN(val) ? 0 : val });
                                }}
                                placeholder="0.00"
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>Rate ($)</label>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                style={inputStyle}
                                value={editingExpense.rate || ''}
                                onChange={(e) => {
                                  const val = e.target.value === '' ? 0 : parseFloat(e.target.value);
                                  setEditingExpense({ ...editingExpense, rate: isNaN(val) ? 0 : val });
                                }}
                                placeholder="0.00"
                              />
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                            <button
                              onClick={() => setEditingExpense(null)}
                              style={{
                                padding: '6px 12px',
                                backgroundColor: 'transparent',
                                color: 'var(--text-secondary)',
                                border: '1px solid var(--border-color)',
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
                                backgroundColor: 'var(--primary-color)',
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
                            backgroundColor: 'var(--bg-tertiary)',
                            borderRadius: '6px',
                            marginBottom: '8px',
                            fontSize: '13px',
                          }}
                        >
                          <div>
                            <span style={{ color: 'var(--primary-color)', fontWeight: '600', fontSize: '11px', textTransform: 'uppercase' }}>
                              {expense.expense_type}
                            </span>
                            <div style={{ color: 'var(--text-primary)', marginTop: '2px' }}>
                              {expense.description}
                              {expense.unit && <span style={{ color: 'var(--text-tertiary)', marginLeft: '4px' }}>({expense.unit})</span>}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right', color: 'rgba(255,255,255,0.7)' }}>
                            {expense.quantity.toFixed(2)}
                          </div>
                          <div style={{ textAlign: 'right', color: 'rgba(255,255,255,0.7)' }}>
                            @ ${expense.rate.toFixed(2)}
                          </div>
                          <div style={{ textAlign: 'right', color: 'var(--text-primary)', fontWeight: '700' }}>
                            ${(expense.quantity * expense.rate).toFixed(2)}
                          </div>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              onClick={() => setEditingExpense({ ...expense })}
                              style={{
                                padding: '4px 8px',
                                backgroundColor: 'transparent',
                                color: 'var(--text-secondary)',
                                border: '1px solid var(--border-color)',
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
                            borderTop: '1px solid var(--border-color)',
                            marginTop: '8px',
                          }}
                        >
                          <span style={{ fontSize: '15px', color: 'var(--text-primary)', fontWeight: '700' }}>TOTAL EXPENSES:</span>
                          <span style={{ fontSize: '18px', color: 'var(--primary-color)', fontWeight: '700' }}>
                            ${expenses.reduce((sum, e) => sum + (e.quantity * e.rate), 0).toFixed(2)}
                          </span>
                        </div>
                      )}
                    </div>
                  </>
                );
              })()}

              {/* Workflow Status Section - only visible to admins */}
              {isAdmin && (() => {
                const existing = existingTickets?.find(
                  et => et.date === selectedTicket.date && 
                        et.user_id === selectedTicket.userId && 
                        (et.customer_id === selectedTicket.customerId || (!et.customer_id && selectedTicket.customerId === 'unassigned'))
                );
                const currentStatus = (existing?.workflow_status || 'draft') as WorkflowStatus;
                const hasTicketNumber = !!existing?.ticket_number;
                
                // Define the workflow steps in order
                const workflowSteps: WorkflowStatus[] = ['approved', 'pdf_exported', 'qbo_created', 'sent_to_cnrl', 'cnrl_approved', 'submitted_to_cnrl'];
                const currentStepIndex = workflowSteps.indexOf(currentStatus);
                
                const handleWorkflowAction = async (action: WorkflowStatus) => {
                  if (!currentTicketRecordId) return;
                  
                  try {
                    switch (action) {
                      case 'pdf_exported':
                        await serviceTicketsService.markPdfExported(currentTicketRecordId, null, isDemoMode);
                        break;
                      case 'qbo_created':
                        // For now, just mark as QBO created (manual entry)
                        // In future, this will trigger actual QBO invoice creation
                        const invoiceId = prompt('Enter QuickBooks Invoice ID (or leave blank to skip):');
                        const invoiceNumber = prompt('Enter QuickBooks Invoice Number:') || '';
                        if (invoiceId) {
                          await serviceTicketsService.markQboCreated(currentTicketRecordId, invoiceId, invoiceNumber, isDemoMode);
                        } else {
                          await serviceTicketsService.updateWorkflowStatus(currentTicketRecordId, 'qbo_created', isDemoMode);
                        }
                        break;
                      case 'sent_to_cnrl':
                        await serviceTicketsService.markSentToCnrl(currentTicketRecordId, isDemoMode);
                        break;
                      case 'cnrl_approved':
                        await serviceTicketsService.markCnrlApproved(currentTicketRecordId, isDemoMode);
                        break;
                      case 'submitted_to_cnrl':
                        const notes = prompt('Enter any notes for CNRL submission (optional):');
                        await serviceTicketsService.markSubmittedToCnrl(currentTicketRecordId, notes, isDemoMode);
                        break;
                      default:
                        await serviceTicketsService.updateWorkflowStatus(currentTicketRecordId, action, isDemoMode);
                    }
                    
                    // Refresh data
                    queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
                    alert(`Workflow updated to: ${WORKFLOW_STATUSES[action].label}`);
                  } catch (error) {
                    console.error('Error updating workflow:', error);
                    alert('Failed to update workflow status');
                  }
                };
                
                return hasTicketNumber ? (
                  <div style={{
                    marginTop: '24px',
                    padding: '16px',
                    backgroundColor: 'var(--bg-secondary)',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color)',
                  }}>
                    <h4 style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', color: 'var(--primary-color)', marginBottom: '12px', letterSpacing: '1px' }}>
                      Workflow Progress
                    </h4>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
                      {workflowSteps.map((step, idx) => {
                        const stepInfo = WORKFLOW_STATUSES[step];
                        const isCompleted = idx <= currentStepIndex;
                        const isCurrent = step === currentStatus;
                        
                        return (
                          <div key={step} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                padding: '6px 12px',
                                borderRadius: '16px',
                                fontSize: '12px',
                                fontWeight: isCurrent ? '600' : '400',
                                backgroundColor: isCompleted ? `${stepInfo.color}30` : 'var(--bg-tertiary)',
                                color: isCompleted ? stepInfo.color : 'var(--text-secondary)',
                                border: isCurrent ? `2px solid ${stepInfo.color}` : '1px solid var(--border-color)',
                              }}
                            >
                              {stepInfo.icon} {stepInfo.label}
                            </span>
                            {idx < workflowSteps.length - 1 && (
                              <span style={{ color: 'var(--text-secondary)' }}>→</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      {currentStepIndex < workflowSteps.length - 1 && (
                        <button
                          className="button button-primary"
                          onClick={() => handleWorkflowAction(workflowSteps[currentStepIndex + 1])}
                          style={{ padding: '8px 16px', fontSize: '13px' }}
                        >
                          Mark as {WORKFLOW_STATUSES[workflowSteps[currentStepIndex + 1]].label}
                        </button>
                      )}
                      {currentStepIndex > 0 && (
                        <button
                          className="button button-secondary"
                          onClick={() => handleWorkflowAction(workflowSteps[currentStepIndex - 1])}
                          style={{ padding: '8px 16px', fontSize: '13px' }}
                        >
                          Revert to {WORKFLOW_STATUSES[workflowSteps[currentStepIndex - 1]].label}
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div style={{
                    marginTop: '24px',
                    padding: '16px',
                    backgroundColor: 'var(--bg-secondary)',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color)',
                    textAlign: 'center',
                  }}>
                    <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
                      Approve this ticket to enable workflow tracking
                    </p>
                  </div>
                );
              })()}

              {/* Action Buttons */}
              <div style={{ marginTop: '24px', display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                <button
                  className="button button-secondary"
                  onClick={() => { 
                    setSelectedTicket(null); 
                    setEditableTicket(null);
                    setServiceRows([]);
                    setEditedDescriptions({});
                    setEditedHours({});
                    setIsTicketEdited(false);
                  }}
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
                    
                    // Calculate hours totals from serviceRows
                    const hoursTotals = {
                      'Shop Time': serviceRows.reduce((sum, r) => sum + (r.st || 0), 0),
                      'Travel Time': serviceRows.reduce((sum, r) => sum + (r.tt || 0), 0),
                      'Field Time': serviceRows.reduce((sum, r) => sum + (r.ft || 0), 0),
                      'Shop Overtime': serviceRows.reduce((sum, r) => sum + (r.so || 0), 0),
                      'Field Overtime': serviceRows.reduce((sum, r) => sum + (r.fo || 0), 0),
                    };
                    
                    // Convert serviceRows to entries for export
                    // Each row with hours in a column becomes an entry with that rate type
                    const exportEntries: typeof selectedTicket.entries = [];
                    serviceRows.forEach((row, idx) => {
                      const template = selectedTicket.entries[0] || { id: '', date: selectedTicket.date, user_id: selectedTicket.userId };
                      if (row.st > 0) {
                        exportEntries.push({ ...template, id: `export-st-${idx}`, description: row.description, hours: row.st, rate_type: 'Shop Time' });
                      }
                      if (row.tt > 0) {
                        exportEntries.push({ ...template, id: `export-tt-${idx}`, description: row.description, hours: row.tt, rate_type: 'Travel Time' });
                      }
                      if (row.ft > 0) {
                        exportEntries.push({ ...template, id: `export-ft-${idx}`, description: row.description, hours: row.ft, rate_type: 'Field Time' });
                      }
                      if (row.so > 0) {
                        exportEntries.push({ ...template, id: `export-so-${idx}`, description: row.description, hours: row.so, rate_type: 'Shop Overtime' });
                      }
                      if (row.fo > 0) {
                        exportEntries.push({ ...template, id: `export-fo-${idx}`, description: row.description, hours: row.fo, rate_type: 'Field Overtime' });
                      }
                    });
                    
                    // Create a modified ticket with the editable values and serviceRows data
                    const modifiedTicket: ServiceTicket = {
                      ...selectedTicket,
                      userName: editableTicket.techName,
                      projectNumber: editableTicket.projectNumber,
                      date: editableTicket.date,
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
                        location_code: editableTicket.other,
                        po_number: editableTicket.poNumber,
                        approver_name: editableTicket.approverName,
                      },
                      hoursByRateType: hoursTotals as typeof selectedTicket.hoursByRateType,
                      entries: exportEntries,
                    };
                    // Recalculate total hours
                    modifiedTicket.totalHours = Object.values(hoursTotals).reduce((sum, h) => sum + h, 0);
                    await handleExportPdf(modifiedTicket);
                    // Refresh the ticket list to show updated ticket number
                    queryClient.invalidateQueries({ queryKey: ['billableEntries'] });
                    queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
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

