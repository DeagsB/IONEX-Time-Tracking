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
  
  // Editable service descriptions and hours state
  const [editedDescriptions, setEditedDescriptions] = useState<Record<string, string[]>>({});
  const [editedHours, setEditedHours] = useState<Record<string, number[]>>({});
  const [isTicketEdited, setIsTicketEdited] = useState(false);
  
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
    // #region agent log
    console.log('[DEBUG] Single Excel export started', {ticketId:ticket.id,date:ticket.date,hasEntries:!!ticket.entries,entriesCount:ticket.entries?.length,isDemoEntries:ticket.entries?.every((e: any)=>e.is_demo),hasRates:!!ticket.rates,hasCustomerInfo:!!ticket.customerInfo});
    fetch('http://127.0.0.1:7242/ingest/42154b7e-9114-4abf-aaac-8c6066245862',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ServiceTickets.tsx:171',message:'Single Excel export started',data:{ticketId:ticket.id,date:ticket.date,hasEntries:!!ticket.entries,entriesCount:ticket.entries?.length,isDemoEntries:ticket.entries?.every((e: any)=>e.is_demo),hasRates:!!ticket.rates,hasCustomerInfo:!!ticket.customerInfo},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
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
      
      // #region agent log
      console.log('[DEBUG] Single: Before downloadExcelServiceTicket', {ticketNumber:ticketWithNumber.ticketNumber,expensesCount:ticketExpenses.length,customerName:ticketWithNumber.customerName,entriesCount:ticketWithNumber.entries?.length});
      fetch('http://127.0.0.1:7242/ingest/42154b7e-9114-4abf-aaac-8c6066245862',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ServiceTickets.tsx:245',message:'Single: Before downloadExcelServiceTicket',data:{ticketNumber:ticketWithNumber.ticketNumber,expensesCount:ticketExpenses.length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      await downloadExcelServiceTicket(ticketWithNumber, ticketExpenses);
      // #region agent log
      console.log('[DEBUG] Single: After downloadExcelServiceTicket - SUCCESS', {ticketNumber:ticketWithNumber.ticketNumber});
      fetch('http://127.0.0.1:7242/ingest/42154b7e-9114-4abf-aaac-8c6066245862',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ServiceTickets.tsx:250',message:'Single: After downloadExcelServiceTicket - SUCCESS',data:{ticketNumber:ticketWithNumber.ticketNumber},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      
      // Invalidate and refetch queries to refresh the ticket list with the new ticket number
      await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
      await queryClient.refetchQueries({ queryKey: ['existingServiceTickets'] });
    } catch (error) {
      // #region agent log
      console.error('[DEBUG] Single Excel: EXPORT ERROR', error);
      fetch('http://127.0.0.1:7242/ingest/42154b7e-9114-4abf-aaac-8c6066245862',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ServiceTickets.tsx:260',message:'Single Excel: EXPORT ERROR',data:{error:String(error),errorMessage:(error as Error)?.message},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
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
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/42154b7e-9114-4abf-aaac-8c6066245862',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ServiceTickets.tsx:287',message:'Bulk Excel export started',data:{selectedCount:selectedTicketIds.size,ticketsToExportCount:ticketsToExport.length,ticketIds:ticketsToExport.map(t=>t.id)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      
      let updatedTicketsList = [...(existingTickets || [])];
      
      for (const ticket of ticketsToExport) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/42154b7e-9114-4abf-aaac-8c6066245862',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ServiceTickets.tsx:293',message:'Excel: Processing ticket',data:{ticketId:ticket.id,date:ticket.date,hasEntries:!!ticket.entries,entriesCount:ticket.entries?.length,isDemoEntries:ticket.entries?.every((e: any)=>e.is_demo),hasRates:!!ticket.rates,displayTicketNumber:ticket.displayTicketNumber},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
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
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/42154b7e-9114-4abf-aaac-8c6066245862',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ServiceTickets.tsx:355',message:'Excel: Ticket number resolved',data:{ticketNumber,ticketRecordId,hasExistingRecord:!!existingRecord},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          // Load expenses for bulk export
          let ticketExpenses = [];
          if (ticketRecordId) {
            try {
              ticketExpenses = await serviceTicketExpensesService.getByTicketId(ticketRecordId);
            } catch (error) {
              console.error('Error loading expenses for export:', error);
            }
          }
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/42154b7e-9114-4abf-aaac-8c6066245862',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ServiceTickets.tsx:370',message:'Excel: Before downloadExcelServiceTicket',data:{ticketNumber,expensesCount:ticketExpenses.length,hasCustomerInfo:!!ticketWithNumber.customerInfo,customerName:ticketWithNumber.customerInfo?.name},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
          // #endregion
          await downloadExcelServiceTicket(ticketWithNumber, ticketExpenses);
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/42154b7e-9114-4abf-aaac-8c6066245862',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ServiceTickets.tsx:375',message:'Excel: After downloadExcelServiceTicket - SUCCESS',data:{ticketNumber},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
          // #endregion
          
          // Small delay between exports to avoid overwhelming the browser
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/42154b7e-9114-4abf-aaac-8c6066245862',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ServiceTickets.tsx:382',message:'Excel: ERROR in ticket export loop',data:{ticketDate:ticket.date,error:String(error),errorMessage:(error as Error)?.message},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B,D,E'})}).catch(()=>{});
          // #endregion
          console.error(`Error exporting ticket for ${ticket.date}:`, error);
          // Continue with next ticket even if this one fails
        }
      }
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/42154b7e-9114-4abf-aaac-8c6066245862',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ServiceTickets.tsx:390',message:'Excel: Bulk export complete',data:{exportedCount:ticketsToExport.length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      
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
      if (existing) {
        if (existing.ticket_number) {
          alert('This ticket already has a ticket number assigned.');
          return;
        }
        ticketRecordId = existing.id;
          } else {
        // Create ticket record first (with a temporary ticket number, then we'll assign the real one)
            const isDemoTicket = ticket.entries.every(entry => entry.is_demo === true);
            const rtRate = ticket.rates.rt, ttRate = ticket.rates.tt, ftRate = ticket.rates.ft, shopOtRate = ticket.rates.shop_ot, fieldOtRate = ticket.rates.field_ot;
            const rtAmount = ticket.hoursByRateType['Shop Time'] * rtRate;
            const ttAmount = ticket.hoursByRateType['Travel Time'] * ttRate;
            const ftAmount = ticket.hoursByRateType['Field Time'] * ftRate;
            const shopOtAmount = ticket.hoursByRateType['Shop Overtime'] * shopOtRate;
            const fieldOtAmount = ticket.hoursByRateType['Field Overtime'] * fieldOtRate;
            const otAmount = shopOtAmount + fieldOtAmount;
            const totalAmount = rtAmount + ttAmount + ftAmount + otAmount;
            
        // Generate ticket number first, then create record with it (we'll update it to the correct one)
        const year = new Date().getFullYear() % 100;
        const tempTicketNumber = await serviceTicketsService.getNextTicketNumber(ticket.userInitials, isDemoTicket);
        const sequenceMatch = tempTicketNumber.match(/\d{3}$/);
        const sequenceNumber = sequenceMatch ? parseInt(sequenceMatch[0]) : 1;
        
        const record = await serviceTicketsService.createTicketRecord({
          ticketNumber: tempTicketNumber,
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

      // Assign ticket number (get next available)
      const ticketNumber = await serviceTicketsService.getNextTicketNumber(ticket.userInitials, isDemoMode);
      await serviceTicketsService.updateTicketNumber(ticketRecordId, ticketNumber, isDemoMode);

      // Refresh the tickets list
      await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
      await queryClient.refetchQueries({ queryKey: ['existingServiceTickets'] });
      
      alert('Ticket number assigned successfully!');
    } catch (error) {
      console.error('Error assigning ticket number:', error);
      alert('Failed to assign ticket number. Please try again.');
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
        alert('This ticket does not have a ticket number assigned.');
        return;
      }

      await serviceTicketsService.updateTicketNumber(existing.id, null, isDemoMode);

      // Refresh the tickets list
      await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
      await queryClient.refetchQueries({ queryKey: ['existingServiceTickets'] });
      
      alert('Ticket number unassigned successfully!');
    } catch (error) {
      console.error('Error unassigning ticket number:', error);
      alert('Failed to unassign ticket number. Please try again.');
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
        alert('No tickets selected or all selected tickets already have ticket numbers.');
        return;
      }

      for (const ticket of ticketsToAssign) {
        await handleAssignTicketNumber(ticket);
      }

      setSelectedTicketIds(new Set());
      alert(`Successfully assigned ticket numbers to ${ticketsToAssign.length} ticket(s)!`);
    } catch (error) {
      console.error('Error in bulk assign:', error);
      alert('Error during bulk assignment. Some tickets may have been assigned.');
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
        alert('No tickets selected or selected tickets do not have ticket numbers assigned.');
        return;
      }

      for (const ticket of ticketsToUnassign) {
        await handleUnassignTicketNumber(ticket);
      }

      setSelectedTicketIds(new Set());
      alert(`Successfully unassigned ticket numbers from ${ticketsToUnassign.length} ticket(s)!`);
    } catch (error) {
      console.error('Error in bulk unassign:', error);
      alert('Error during bulk unassignment. Some tickets may have been unassigned.');
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
    queryKey: ['customers', user?.id],
    queryFn: () => customersService.getAll(user?.id),
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

  // Fetch existing ticket numbers for display (from appropriate table based on demo mode)
  const { data: existingTickets } = useQuery({
    queryKey: ['existingServiceTickets', isDemoMode],
    queryFn: async () => {
      const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
      const { data, error } = await supabase
        .from(tableName)
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
                onClick={handleBulkAssignTicketNumbers}
                disabled={isBulkExporting}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#10b981',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '13px',
                  fontWeight: '500',
                  cursor: isBulkExporting ? 'not-allowed' : 'pointer',
                  opacity: isBulkExporting ? 0.6 : 1,
                }}
              >
                ✓ Assign Ticket Numbers
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
                ✗ Unassign Ticket Numbers
              </button>
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
                    
                    if (ticketRecord) {
                      setIsTicketEdited(ticketRecord.is_edited || false);
                      setEditedDescriptions((ticketRecord.edited_descriptions as Record<string, string[]>) || {});
                      
                      // Convert old format (Record<string, number>) to new format (Record<string, number[]>)
                      const loadedHours = (ticketRecord.edited_hours as Record<string, number | number[]>) || {};
                      const convertedHours: Record<string, number[]> = {};
                      
                      Object.keys(loadedHours).forEach(rateType => {
                        const hours = loadedHours[rateType];
                        if (Array.isArray(hours)) {
                          convertedHours[rateType] = hours;
                        } else {
                          // Old format: convert to array (will be distributed when descriptions are loaded)
                          convertedHours[rateType] = [hours as number];
                        }
                      });
                      
                      setEditedHours(convertedHours);
                    } else {
                      setIsTicketEdited(false);
                      setEditedDescriptions({});
                      setEditedHours({});
                    }
                  } catch (error) {
                    console.error('Error loading ticket data:', error);
                    setExpenses([]);
                    setIsTicketEdited(false);
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
                    <div style={{ display: 'flex', gap: '6px', justifyContent: 'center', alignItems: 'center' }}>
                      {(() => {
                        const existing = existingTickets?.find(
                          et => et.date === ticket.date && 
                                et.user_id === ticket.userId && 
                                (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
                        );
                        const hasTicketNumber = existing?.ticket_number;
                        
                        return hasTicketNumber ? (
                          <button
                            className="button button-secondary"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleUnassignTicketNumber(ticket);
                            }}
                            style={{
                              padding: '4px 8px',
                              fontSize: '11px',
                              minWidth: 'auto',
                            }}
                            title="Unassign ticket number"
                          >
                            ✗
                          </button>
                        ) : (
                          <button
                            className="button button-primary"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleAssignTicketNumber(ticket);
                            }}
                            style={{
                              padding: '4px 8px',
                              fontSize: '11px',
                              minWidth: 'auto',
                            }}
                            title="Assign ticket number"
                          >
                            ✓
                          </button>
                        );
                      })()}
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
                    </div>
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
          onClick={() => { 
            setSelectedTicket(null); 
            setEditableTicket(null);
            setEditedDescriptions({});
            setEditedHours({});
            setIsTicketEdited(false);
          }}
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
            <style>{`
              .service-ticket-textarea::-webkit-scrollbar {
                width: 8px;
              }
              .service-ticket-textarea::-webkit-scrollbar-track {
                background: transparent;
              }
              .service-ticket-textarea::-webkit-scrollbar-thumb {
                background: rgba(199, 112, 240, 0.3);
                border-radius: 4px;
              }
              .service-ticket-textarea::-webkit-scrollbar-thumb:hover {
                background: rgba(199, 112, 240, 0.5);
              }
            `}</style>
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
                onClick={() => { 
                  setSelectedTicket(null); 
                  setEditableTicket(null);
                  setEditedDescriptions({});
                  setEditedHours({});
                  setIsTicketEdited(false);
                }}
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
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                      <h3 style={sectionTitleStyle}>Service Description</h3>
                        {isTicketEdited && (
                          <span style={{ 
                            fontSize: '11px', 
                            color: '#c770f0', 
                            padding: '4px 8px', 
                            backgroundColor: 'rgba(199, 112, 240, 0.2)', 
                            borderRadius: '4px',
                            fontWeight: '600'
                          }}>
                            EDITED - Time entries won't update this ticket
                          </span>
                        )}
                      </div>
                      <div style={{ color: '#fff', fontSize: '14px' }}>
                        {Object.entries(selectedTicket.hoursByRateType)
                          .filter(([rateType, hours]) => hours > 0)
                          .sort(([rateTypeA], [rateTypeB]) => {
                            const orderA = getRateTypeSortOrder(rateTypeA);
                            const orderB = getRateTypeSortOrder(rateTypeB);
                            return orderA - orderB;
                          })
                          .map(([rateType, hours]) => {
                            const entriesForType = selectedTicket.entries.filter(
                              (e) => (e.rate_type || 'Shop Time') === rateType
                            );
                            
                            // Use edited data if available, otherwise use original
                            const editedDescriptionsForType = editedDescriptions[rateType] || entriesForType.map(e => e.description || 'No description');
                            
                            // Convert old format (number) to new format (number[]) or use existing array
                            let editedHoursForType: number[];
                            if (editedHours[rateType] !== undefined) {
                              if (Array.isArray(editedHours[rateType])) {
                                editedHoursForType = editedHours[rateType];
                              } else {
                                // Old format: single number, distribute evenly across descriptions
                                const totalHours = editedHours[rateType] as unknown as number;
                                const hoursPerDesc = editedDescriptionsForType.length > 0 ? totalHours / editedDescriptionsForType.length : 0;
                                editedHoursForType = editedDescriptionsForType.map(() => hoursPerDesc);
                              }
                            } else {
                              // No edited hours, use actual hours from entries (not rounded, not distributed)
                              // This preserves the exact hours from each entry so they stay consistent when reopening
                              editedHoursForType = entriesForType.map(e => Number(e.hours) || 0);
                              
                              // Ensure arrays have same length as descriptions
                              // If more descriptions than entries, pad with zeros
                              while (editedHoursForType.length < editedDescriptionsForType.length) {
                                editedHoursForType.push(0);
                              }
                              // If fewer descriptions than entries, sum extra entries into the last description
                              if (editedHoursForType.length > editedDescriptionsForType.length) {
                                const extraHours = editedHoursForType.slice(editedDescriptionsForType.length).reduce((sum, h) => sum + h, 0);
                                editedHoursForType = editedHoursForType.slice(0, editedDescriptionsForType.length);
                                if (editedHoursForType.length > 0) {
                                  editedHoursForType[editedHoursForType.length - 1] += extraHours;
                                }
                              }
                            }
                            
                            return (
                              <div key={rateType} style={{ marginBottom: '20px', padding: '12px', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '6px' }}>
                                <div style={{ marginBottom: '12px' }}>
                                  <h4 style={{ fontSize: '13px', fontWeight: '600', color: '#c770f0', margin: 0 }}>
                                    {rateType}
                                </h4>
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                  {editedDescriptionsForType.map((desc, index) => (
                                    <div key={index} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                                      <textarea
                                        value={desc}
                                        onChange={(e) => {
                                          const newDescs = [...editedDescriptionsForType];
                                          newDescs[index] = e.target.value;
                                          setEditedDescriptions({ ...editedDescriptions, [rateType]: newDescs });
                                          setIsTicketEdited(true);
                                        }}
                                        style={{
                                          ...inputStyle,
                                          flex: 1,
                                          minHeight: '60px',
                                          resize: 'vertical',
                                          fontFamily: 'inherit',
                                          overflowY: 'auto',
                                          overflowX: 'hidden',
                                          scrollbarWidth: 'thin',
                                          scrollbarColor: 'rgba(199, 112, 240, 0.3) transparent',
                                        }}
                                        className="service-ticket-textarea"
                                        placeholder="Enter description..."
                                      />
                                      <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                          <label style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap' }}>Hours</label>
                                          <input
                                            type="number"
                                            step="0.5"
                                            min="0"
                                            value={editedHoursForType[index] || 0}
                                            onChange={(e) => {
                                              const newHours = [...editedHoursForType];
                                              newHours[index] = parseFloat(e.target.value) || 0;
                                              setEditedHours({ ...editedHours, [rateType]: newHours });
                                              setIsTicketEdited(true);
                                            }}
                                            style={{
                                              ...inputStyle,
                                              width: '70px',
                                              padding: '4px 8px',
                                              textAlign: 'left',
                                            }}
                                          />
                                        </div>
                                        <button
                                          onClick={() => {
                                            const newDescs = editedDescriptionsForType.filter((_, i) => i !== index);
                                            const newHours = editedHoursForType.filter((_, i) => i !== index);
                                            setEditedDescriptions({ ...editedDescriptions, [rateType]: newDescs });
                                            setEditedHours({ ...editedHours, [rateType]: newHours });
                                            setIsTicketEdited(true);
                                          }}
                                          style={{
                                            padding: '6px 12px',
                                            backgroundColor: 'transparent',
                                            color: '#ef5350',
                                            border: '1px solid rgba(239, 83, 80, 0.3)',
                                            borderRadius: '4px',
                                            fontSize: '11px',
                                            cursor: 'pointer',
                                            whiteSpace: 'nowrap',
                                            alignSelf: 'flex-end',
                                          }}
                                        >
                                          Remove
                                        </button>
                                      </div>
                                    </div>
                                  ))}
                                  <button
                                    onClick={() => {
                                      const newDescs = [...editedDescriptionsForType, ''];
                                      const newHours = [...editedHoursForType, 0];
                                      setEditedDescriptions({ ...editedDescriptions, [rateType]: newDescs });
                                      setEditedHours({ ...editedHours, [rateType]: newHours });
                                      setIsTicketEdited(true);
                                    }}
                                    style={{
                                      padding: '6px 12px',
                                      backgroundColor: 'rgba(199, 112, 240, 0.2)',
                                      color: '#c770f0',
                                      border: '1px solid rgba(199, 112, 240, 0.3)',
                                      borderRadius: '4px',
                                      fontSize: '11px',
                                      cursor: 'pointer',
                                      alignSelf: 'flex-start',
                                    }}
                                  >
                                    + Add Description
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                      </div>
                      {isTicketEdited && (
                        <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.2)' }}>
                          <button
                            onClick={async () => {
                              if (!currentTicketRecordId) return;
                              
                              const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
                              const { error } = await supabase
                                .from(tableName)
                                .update({
                                  is_edited: true,
                                  edited_descriptions: editedDescriptions,
                                  edited_hours: editedHours,
                                })
                                .eq('id', currentTicketRecordId);
                              
                              if (error) {
                                console.error('Error saving edited ticket:', error);
                                alert('Failed to save edited ticket data.');
                              } else {
                                alert('Service ticket descriptions and hours saved successfully. Time entry changes will no longer update this ticket.');
                                queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
                              }
                            }}
                            style={{
                              padding: '10px 20px',
                              backgroundColor: '#c770f0',
                              color: 'white',
                              border: 'none',
                              borderRadius: '6px',
                              fontSize: '13px',
                              fontWeight: '600',
                              cursor: 'pointer',
                            }}
                          >
                            Save Edited Descriptions & Hours
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Hours Summary Section */}
                    <div style={sectionStyle}>
                      <h3 style={sectionTitleStyle}>Hours Summary</h3>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
                        {Object.entries(selectedTicket.hoursByRateType)
                          .filter(([rateType, hours]) => hours > 0)
                          .sort(([rateTypeA], [rateTypeB]) => {
                            const orderA = getRateTypeSortOrder(rateTypeA);
                            const orderB = getRateTypeSortOrder(rateTypeB);
                            return orderA - orderB;
                          })
                          .map(([rateType, hours]) => {
                            const entriesForType = selectedTicket.entries.filter(
                              (e) => (e.rate_type || 'Shop Time') === rateType
                            );
                            // Sum actual hours first, then round the total up to nearest 0.5
                            const actualTotal = entriesForType.reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
                            const originalTotal = roundToHalfHour(actualTotal);
                            // Use edited hours if available (sum array if it's an array), then round to nearest 0.5
                            let displayHours = originalTotal;
                            if (editedHours[rateType] !== undefined) {
                              if (Array.isArray(editedHours[rateType])) {
                                const editedTotal = editedHours[rateType].reduce((sum, h) => sum + (h || 0), 0);
                                displayHours = roundToHalfHour(editedTotal);
                              } else {
                                displayHours = roundToHalfHour(editedHours[rateType] as unknown as number);
                              }
                            }
                            return (
                              <div key={rateType} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.7)', fontWeight: '500' }}>{rateType}:</span>
                                <span style={{ fontSize: '14px', color: '#fff', fontWeight: '700' }}>{displayHours.toFixed(2)}</span>
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
                            {(() => {
                              const editedTotal = Object.values(editedHours).reduce((sum, hoursArray) => {
                                if (Array.isArray(hoursArray)) {
                                  return sum + hoursArray.reduce((arrSum, h) => arrSum + (h || 0), 0);
                                } else {
                                  return sum + (hoursArray as unknown as number || 0);
                                }
                              }, 0);
                              if (editedTotal > 0) {
                                return roundToHalfHour(editedTotal).toFixed(2);
                              } else {
                                // Sum actual hours first, then round the total up to nearest 0.5
                                const actualTotal = selectedTicket.entries.reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
                                return roundToHalfHour(actualTotal).toFixed(2);
                              }
                            })()}
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
                                description: 'Mileage',
                                quantity: 1,
                                rate: 1,
                                unit: 'km',
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
                                style={{
                                  ...inputStyle,
                                  backgroundColor: 'rgba(255,255,255,0.15)',
                                  color: '#fff',
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
                                <option value="Travel" style={{ backgroundColor: '#1a1a2e', color: '#fff' }}>Mileage</option>
                                <option value="Subsistence" style={{ backgroundColor: '#1a1a2e', color: '#fff' }}>Per Diem</option>
                                <option value="Equipment" style={{ backgroundColor: '#1a1a2e', color: '#fff' }}>Equipment Billout</option>
                                <option value="Expenses" style={{ backgroundColor: '#1a1a2e', color: '#fff' }}>Other</option>
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
                  onClick={() => { 
                    setSelectedTicket(null); 
                    setEditableTicket(null);
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
                    // Create a modified ticket with the editable values and edited descriptions/hours
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
                        location_code: editableTicket.locationCode,
                        po_number: editableTicket.poNumber,
                        approver_name: editableTicket.approverName,
                      },
                      // Apply edited hours if available (sum arrays to get totals)
                      hoursByRateType: Object.keys(selectedTicket.hoursByRateType).reduce((acc, rateType) => {
                        if (editedHours[rateType] !== undefined) {
                          if (Array.isArray(editedHours[rateType])) {
                            acc[rateType as keyof typeof acc] = editedHours[rateType].reduce((sum, h) => sum + (h || 0), 0);
                          } else {
                            acc[rateType as keyof typeof acc] = editedHours[rateType] as unknown as number;
                          }
                        } else {
                          acc[rateType as keyof typeof acc] = selectedTicket.hoursByRateType[rateType as keyof typeof selectedTicket.hoursByRateType];
                        }
                        return acc;
                      }, { ...selectedTicket.hoursByRateType }),
                      // Create modified entries with edited descriptions
                      entries: Object.entries(selectedTicket.hoursByRateType)
                        .filter(([rateType]) => selectedTicket.hoursByRateType[rateType as keyof typeof selectedTicket.hoursByRateType] > 0)
                        .flatMap(([rateType]) => {
                          const editedDescs = editedDescriptions[rateType];
                          if (editedDescs && editedDescs.length > 0) {
                            // Use edited descriptions and hours
                            const editedHoursForType = editedHours[rateType];
                            const hoursArray = Array.isArray(editedHoursForType) 
                              ? editedHoursForType 
                              : editedHoursForType !== undefined 
                                ? [editedHoursForType as unknown as number] 
                                : [];
                            
                            return editedDescs.map((desc, idx) => ({
                              ...selectedTicket.entries[0], // Use first entry as template
                              id: `edited-${rateType}-${idx}`,
                              description: desc,
                              rate_type: rateType,
                              hours: hoursArray[idx] !== undefined 
                                ? hoursArray[idx] 
                                : (hoursArray.length > 0 ? hoursArray[0] / editedDescs.length : 0),
                            }));
                          } else {
                            // Use original entries for this rate type
                            return selectedTicket.entries.filter(
                              (e) => (e.rate_type || 'Shop Time') === rateType
                            );
                          }
                        }),
                    };
                    // Recalculate total hours from edited hours
                    modifiedTicket.totalHours = Object.values(modifiedTicket.hoursByRateType).reduce((sum, h) => sum + h, 0);
                    await handleExportExcel(modifiedTicket);
                    // Refresh the ticket list to show updated ticket number
                    queryClient.invalidateQueries({ queryKey: ['billableEntries'] });
                    queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
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
                    // Create a modified ticket with the editable values and edited descriptions/hours
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
                        location_code: editableTicket.locationCode,
                        po_number: editableTicket.poNumber,
                        approver_name: editableTicket.approverName,
                      },
                      // Apply edited hours if available (sum arrays to get totals)
                      hoursByRateType: Object.keys(selectedTicket.hoursByRateType).reduce((acc, rateType) => {
                        if (editedHours[rateType] !== undefined) {
                          if (Array.isArray(editedHours[rateType])) {
                            acc[rateType as keyof typeof acc] = editedHours[rateType].reduce((sum, h) => sum + (h || 0), 0);
                          } else {
                            acc[rateType as keyof typeof acc] = editedHours[rateType] as unknown as number;
                          }
                        } else {
                          acc[rateType as keyof typeof acc] = selectedTicket.hoursByRateType[rateType as keyof typeof selectedTicket.hoursByRateType];
                        }
                        return acc;
                      }, { ...selectedTicket.hoursByRateType }),
                      // Create modified entries with edited descriptions
                      entries: Object.entries(selectedTicket.hoursByRateType)
                        .filter(([rateType]) => selectedTicket.hoursByRateType[rateType as keyof typeof selectedTicket.hoursByRateType] > 0)
                        .flatMap(([rateType]) => {
                          const editedDescs = editedDescriptions[rateType];
                          if (editedDescs && editedDescs.length > 0) {
                            // Use edited descriptions and hours
                            const editedHoursForType = editedHours[rateType];
                            const hoursArray = Array.isArray(editedHoursForType) 
                              ? editedHoursForType 
                              : editedHoursForType !== undefined 
                                ? [editedHoursForType as unknown as number] 
                                : [];
                            
                            return editedDescs.map((desc, idx) => ({
                              ...selectedTicket.entries[0], // Use first entry as template
                              id: `edited-${rateType}-${idx}`,
                              description: desc,
                              rate_type: rateType,
                              hours: hoursArray[idx] !== undefined 
                                ? hoursArray[idx] 
                                : (hoursArray.length > 0 ? hoursArray[0] / editedDescs.length : 0),
                            }));
                          } else {
                            // Use original entries for this rate type
                            return selectedTicket.entries.filter(
                              (e) => (e.rate_type || 'Shop Time') === rateType
                            );
                          }
                        }),
                    };
                    // Recalculate total hours from edited hours
                    modifiedTicket.totalHours = Object.values(modifiedTicket.hoursByRateType).reduce((sum, h) => sum + h, 0);
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

