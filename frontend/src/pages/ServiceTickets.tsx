import { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { serviceTicketsService, customersService, employeesService, serviceTicketExpensesService, projectsService, timeEntriesService } from '../services/supabaseServices';
import { groupEntriesIntoTickets, formatTicketDate, generateTicketDisplayId, ServiceTicket, getRateTypeSortOrder, applyHeaderOverridesToTicket, buildApproverPoAfe, getProjectHeaderFields, getTicketBillingKey, buildBillingKey, buildGroupingKey } from '../utils/serviceTickets';
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
  rejected: { label: 'Rejected', color: '#ef5350', icon: '✕' },
  pdf_exported: { label: 'PDF Exported', color: '#8b5cf6', icon: '📄' },
  qbo_created: { label: 'QBO Invoice', color: '#f59e0b', icon: '💰' },
  sent_to_cnrl: { label: 'Sent to CNRL', color: '#ec4899', icon: '📧' },
  cnrl_approved: { label: 'CNRL Approved', color: '#10b981', icon: '✅' },
  submitted_to_cnrl: { label: 'Submitted', color: '#059669', icon: '🎉' },
} as const;

type WorkflowStatus = keyof typeof WORKFLOW_STATUSES;

/** Format a date-only string (YYYY-MM-DD) as local date to avoid timezone shifting the day */
function formatDateOnlyLocal(dateStr: string): string {
  if (!dateStr) return '';
  const datePart = dateStr.split('T')[0].split(' ')[0];
  const parts = datePart.split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return dateStr;
  const [y, m, d] = parts;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

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
  // Admin can filter by employee; defaults to '' (All Employees) so they can see everyone's drafts
  // Filter tabs: 'draft' (Not Submitted), 'submitted' (Pending Approval), 'approved' (Finalized), 'all'
  // Admin defaults to Submitted tab on first open; non-admin to Drafts
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const tabRefsMap = useRef<Record<string, HTMLButtonElement | null>>({});
  const [tabIndicatorStyle, setTabIndicatorStyle] = useState<{ left: number; width: number } | null>(null);
  const [activeTab, setActiveTab] = useState<'draft' | 'submitted' | 'approved' | 'all'>(() =>
    isAdmin ? 'submitted' : 'draft'
  );
  const hasSetAdminDefaultTab = useRef(false);
  const prevIsAdminRef = useRef(isAdmin);
  useEffect(() => {
    if (isAdmin && !hasSetAdminDefaultTab.current) {
      hasSetAdminDefaultTab.current = true;
      setActiveTab('submitted');
    }
    // When admin toggle changes (developer switching roles), invalidate queries to refetch with correct permissions
    if (prevIsAdminRef.current !== isAdmin) {
      prevIsAdminRef.current = isAdmin;
      queryClient.invalidateQueries({ queryKey: ['billableEntries'] });
      queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
    }
  }, [isAdmin, queryClient]);
  const [showDiscarded, setShowDiscarded] = useState(false);

  // Clear bulk selection when switching tabs or trash view (selection is per tab)
  useEffect(() => {
    setSelectedTicketIds(new Set());
  }, [activeTab, showDiscarded]);

  // Update sliding tab indicator position
  const updateTabIndicator = () => {
    const btn = tabRefsMap.current[activeTab];
    const container = tabsContainerRef.current;
    if (!btn || !container) return;
    const crect = container.getBoundingClientRect();
    const brect = btn.getBoundingClientRect();
    setTabIndicatorStyle({
      left: brect.left - crect.left,
      width: brect.width,
    });
  };
  useEffect(() => {
    updateTabIndicator();
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateTabIndicator)
      : null;
    if (ro && tabsContainerRef.current) ro.observe(tabsContainerRef.current);
    const onResize = () => updateTabIndicator();
    window.addEventListener('resize', onResize);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [activeTab]);

  // Sorting state - persisted per user in localStorage (all tabs including approved use this)
  const [sortField, setSortField] = useState<'ticketNumber' | 'date' | 'customerName' | 'userName' | 'totalHours'>(() => {
    const saved = localStorage.getItem(`serviceTickets_sortField_${user?.id}`);
    return (saved as any) || 'date';
  });
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(() => {
    const saved = localStorage.getItem(`serviceTickets_sortDirection_${user?.id}`);
    return (saved as 'asc' | 'desc') || 'desc';
  });
  // Use saved sort for all tabs including approved (user can sort by any column asc/desc)
  const effectiveSortField = sortField;
  const effectiveSortDirection = sortDirection;
  
  // Ticket preview state
  const [selectedTicket, setSelectedTicket] = useState<ServiceTicket | null>(null);
  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
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
  const [pendingDeleteExpenseIds, setPendingDeleteExpenseIds] = useState<Set<string>>(new Set());
  const [pendingAddExpenses, setPendingAddExpenses] = useState<Array<{
    expense_type: 'Travel' | 'Subsistence' | 'Expenses' | 'Equipment';
    description: string;
    quantity: number;
    rate: number;
    unit?: string;
    tempId?: string;
  }>>([]);
  
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
    approver: string;
    poAfe: string;
    cc: string;
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
  // Per-entry edit overrides: { entryId: { description, st, tt, ft, so, fo } }
  // Only entries that differ from their time entry are stored.
  type EntryOverride = { description: string; st: number; tt: number; ft: number; so: number; fo: number };
  const [editedEntryOverrides, setEditedEntryOverrides] = useState<Record<string, EntryOverride>>({});
  // Snapshot of rows as derived from live time entries (before any edits) for comparison
  const originalTimeEntryRowsRef = useRef<ServiceRow[]>([]);
  // Refs to track initial values when ticket opened (for highlighting pending changes)
  type EditableTicketSnapshot = NonNullable<typeof editableTicket>;
  const initialEditableTicketRef = useRef<EditableTicketSnapshot | null>(null);
  const initialServiceRowsRef = useRef<ServiceRow[]>([]);
  const [isLockedForEditing, setIsLockedForEditing] = useState(false); // True when admin has approved
  const [showLockNotification, setShowLockNotification] = useState(false);
  const [lockNotificationEntered, setLockNotificationEntered] = useState(false);
  const [lockNotificationExiting, setLockNotificationExiting] = useState(false);
  const lockNotificationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockNotificationExitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ticketPanelBackdropRef = useRef<HTMLDivElement>(null);
  const ticketPanelMouseDownOnBackdropRef = useRef(false);
  const justSavedRef = useRef(false); // Skip sync effect overwriting service rows for a moment after save

  const showLockedReason = () => {
    if (!isLockedForEditing) return;
    if (lockNotificationTimeoutRef.current) clearTimeout(lockNotificationTimeoutRef.current);
    if (lockNotificationExitRef.current) clearTimeout(lockNotificationExitRef.current);
    setLockNotificationExiting(false);
    setLockNotificationEntered(false);
    setShowLockNotification(true);
    lockNotificationTimeoutRef.current = setTimeout(() => {
      lockNotificationTimeoutRef.current = null;
      setLockNotificationExiting(true);
      lockNotificationExitRef.current = setTimeout(() => {
        lockNotificationExitRef.current = null;
        setShowLockNotification(false);
        setLockNotificationExiting(false);
        setLockNotificationEntered(false);
      }, 300);
    }, 4500);
  };

  useEffect(() => {
    return () => {
      if (lockNotificationTimeoutRef.current) clearTimeout(lockNotificationTimeoutRef.current);
      if (lockNotificationExitRef.current) clearTimeout(lockNotificationExitRef.current);
    };
  }, []);

  useEffect(() => {
    if (!showLockNotification) return;
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => setLockNotificationEntered(true));
    });
    return () => cancelAnimationFrame(id);
  }, [showLockNotification]);

  const [isSavingTicket, setIsSavingTicket] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [showRejectNoteModal, setShowRejectNoteModal] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [pendingChangesVersion, setPendingChangesVersion] = useState(0);

  const OPENED_NEW_IDS_KEY = 'ionex_serviceTickets_openedNewIds';
  const [openedNewTicketIds, setOpenedNewTicketIds] = useState<Set<string>>(() => {
    try {
      const s = localStorage.getItem(OPENED_NEW_IDS_KEY);
      return s ? new Set(JSON.parse(s)) : new Set();
    } catch {
      return new Set();
    }
  });
  const addOpenedNewTicketId = (id: string) => {
    setOpenedNewTicketIds(prev => {
      const next = new Set(prev).add(id);
      try {
        localStorage.setItem(OPENED_NEW_IDS_KEY, JSON.stringify([...next]));
      } catch { /* ignore */ }
      return next;
    });
  };

  // Create new ticket panel state
  const [showCreatePanel, setShowCreatePanel] = useState(false);
  const [isCreatingTicket, setIsCreatingTicket] = useState(false);
  const [createCustomerId, setCreateCustomerId] = useState<string>('');
  const [createProjectId, setCreateProjectId] = useState<string>('');
  const [createData, setCreateData] = useState({
    customerName: '',
    address: '',
    cityState: '',
    zipCode: '',
    phone: '',
    email: '',
    contactName: '',
    serviceLocation: '',
    locationCode: '',
    poNumber: '',
    approver: '',
    poAfe: '',
    cc: '',
    other: '',
    techName: '',
    projectNumber: '',
    date: new Date().toISOString().split('T')[0],
  });
  const [createServiceRows, setCreateServiceRows] = useState<ServiceRow[]>([
    { id: 'new-1', description: '', st: 0, tt: 0, ft: 0, so: 0, fo: 0 },
  ]);
  const [createExpenses, setCreateExpenses] = useState<Array<{
    tempId: string;
    expense_type: 'Travel' | 'Subsistence' | 'Expenses' | 'Equipment';
    description: string;
    quantity: number;
    rate: number;
    unit?: string;
  }>>([]);
  const [createEditingExpense, setCreateEditingExpense] = useState<{
    expense_type: 'Travel' | 'Subsistence' | 'Expenses' | 'Equipment';
    description: string;
    quantity: number;
    rate: number;
    unit?: string;
  } | null>(null);
  const [showInlineCreateCustomer, setShowInlineCreateCustomer] = useState(false);
  const [inlineCustomerName, setInlineCustomerName] = useState('');
  const [isCreatingCustomer, setIsCreatingCustomer] = useState(false);
  const [showInlineCreateProject, setShowInlineCreateProject] = useState(false);
  const [inlineProjectName, setInlineProjectName] = useState('');
  const [inlineProjectNumber, setInlineProjectNumber] = useState('');
  const [isCreatingProject, setIsCreatingProject] = useState(false);

  // Round to nearest 0.5 hour (always round up)
  const roundToHalfHour = (hours: number): number => {
    return Math.ceil(hours * 2) / 2;
  };

  // Compare hours with tolerance to avoid false "pending" after save/reopen (floating-point drift)
  const hoursEq = (a: number, b: number): boolean => {
    if (a === b) return true;
    const tol = 1e-6;
    return Math.abs((a || 0) - (b || 0)) < tol;
  };

  // Normalize for comparison so legacy autosave-era data (empty vs undefined, whitespace, number vs string) doesn't cause false "pending"
  const normStr = (v: unknown): string => String(v ?? '').trim();

  const performSave = async (): Promise<boolean> => {
    if (!selectedTicket) return false;
    setIsSavingTicket(true);
    try {
      // Ensure we have a ticket record (handles race when user saves before open completes)
      let recordId = currentTicketRecordId;
      if (!recordId) {
        try {
          recordId = await getOrCreateTicketRecord(selectedTicket);
          setCurrentTicketRecordId(recordId);
        } catch (e) {
          console.error('Failed to get or create ticket record:', e);
          alert('Failed to save: could not find or create ticket record.');
          return false;
        }
      }

      const legacy = serviceRowsToLegacyFormat(serviceRows);
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
      const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';

      // Persist header_overrides and location FIRST so header edits always save (critical for draft tickets)
      // Preserve _grouping_key and _billing_key so record stays matched to ticket when user edits PO/AFE/CC
      if (editableTicket && selectedTicket) {
        const newLocation = editableTicket.serviceLocation?.trim() || '';
        const ticketGroupingKey = selectedTicket.id ? getTicketBillingKeyLocal(selectedTicket.id) : '_::_::_';
        const ticketBillingKey = buildBillingKey(
          selectedTicket.entryApprover ?? '',
          selectedTicket.entryPoAfe ?? '',
          selectedTicket.entryCc ?? ''
        );
        const { error: overrideError } = await supabase
          .from(tableName)
          .update({
            location: newLocation,
            header_overrides: {
              customer_name: editableTicket.customerName ?? '',
              address: editableTicket.address ?? '',
              city_state: editableTicket.cityState ?? '',
              zip_code: editableTicket.zipCode ?? '',
              phone: editableTicket.phone ?? '',
              email: editableTicket.email ?? '',
              contact_name: editableTicket.contactName ?? '',
              service_location: editableTicket.serviceLocation ?? '',
              location_code: editableTicket.locationCode ?? '',
              po_number: editableTicket.poNumber ?? '',
              approver: editableTicket.approver ?? '',
              po_afe: editableTicket.poAfe ?? '',
              cc: editableTicket.cc ?? '',
              other: editableTicket.other ?? '',
              tech_name: editableTicket.techName ?? '',
              project_number: editableTicket.projectNumber ?? '',
              date: editableTicket.date ?? '',
              _grouping_key: ticketGroupingKey,
              _billing_key: ticketBillingKey,
            },
          })
          .eq('id', recordId);
        if (overrideError) {
          console.error('Header overrides save failed:', overrideError);
          alert('Failed to save header edits (customer info, approver, PO/AFE/CC, etc.). Ensure migration_add_service_ticket_header_overrides has been run.');
          return false;
        }
      }

      // Per-entry overrides: only store rows that differ from live time entries
      const entryOverrides = computeEntryOverrides(serviceRows, originalTimeEntryRowsRef.current);
      const hasOverrides = Object.keys(entryOverrides).length > 0;

      // Core fields (service rows, hours, amounts)
      const { error } = await supabase
        .from(tableName)
        .update({
          is_edited: hasOverrides,
          edited_descriptions: legacy.descriptions,
          edited_hours: legacy.hours,
          edited_entry_overrides: hasOverrides ? entryOverrides : null,
          total_hours: totalEditedHours,
          total_amount: totalAmount,
        })
        .eq('id', recordId);
      if (error) {
        console.error('Error saving edited ticket:', error);
        alert('Failed to save service rows/hours.');
        return false;
      }
      setEditedEntryOverrides(entryOverrides);
      setIsTicketEdited(hasOverrides);

      // Header edits are saved to header_overrides only. Time entries are NOT updated.
      // Apply pending expense deletes (expenses marked for removal)
      const hadPendingExpenseChanges = pendingDeleteExpenseIds.size > 0 || pendingAddExpenses.length > 0;
      for (const expenseId of pendingDeleteExpenseIds) {
        await serviceTicketExpensesService.delete(expenseId);
      }
      if (pendingDeleteExpenseIds.size > 0) setPendingDeleteExpenseIds(new Set());
      // Apply pending expense adds (new expenses not yet saved)
      if (recordId && pendingAddExpenses.length > 0) {
        for (const exp of pendingAddExpenses) {
          await serviceTicketExpensesService.create({
            service_ticket_id: recordId,
            expense_type: exp.expense_type,
            description: exp.description,
            quantity: exp.quantity,
            rate: exp.rate,
            unit: exp.unit,
          });
        }
        setPendingAddExpenses([]);
      }
      if (recordId && hadPendingExpenseChanges) {
        await loadExpenses(recordId);
      }
      setIsTicketEdited(false);
      justSavedRef.current = true;
      setTimeout(() => { justSavedRef.current = false; }, 2000);
      await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
      await queryClient.refetchQueries({ queryKey: ['existingServiceTickets'] });
      // Update initial snapshots so pending highlights and Save Changes button clear after save
      if (editableTicket) initialEditableTicketRef.current = { ...editableTicket };
      initialServiceRowsRef.current = serviceRows.map(r => ({ ...r }));
      setPendingChangesVersion(v => v + 1);
      return true;
    } finally {
      setIsSavingTicket(false);
    }
  };

  const buildApprovalHeaderOverrides = (ticket: ServiceTicket): Record<string, string | number> => {
    const cityState = ticket.customerInfo.city && ticket.customerInfo.state
      ? `${ticket.customerInfo.city}, ${ticket.customerInfo.state}`
      : ticket.customerInfo.city || ticket.customerInfo.state || '';
    const approverPoAfeCc = ((): { approver: string; po_afe: string; cc: string } => {
      const fromEntry = ticket.entryApprover || ticket.entryPoAfe || ticket.entryCc;
      if (fromEntry) {
        return {
          approver: ticket.entryApprover ?? '',
          po_afe: ticket.entryPoAfe ?? ticket.customerInfo.po_number ?? '',
          cc: ticket.entryCc ?? '',
        };
      }
      const fromProject = ticket.projectApprover || ticket.projectPoAfe || ticket.projectCc;
      if (fromProject) {
        return {
          approver: ticket.projectApprover ?? ticket.customerInfo.approver_name ?? '',
          po_afe: ticket.projectPoAfe ?? ticket.customerInfo.po_number ?? '',
          cc: ticket.projectCc ?? '',
        };
      }
      return {
        approver: ticket.customerInfo.approver_name ?? '',
        po_afe: ticket.customerInfo.po_number ?? '',
        cc: '',
      };
    })();
    const groupingKey = ticket.id ? getTicketBillingKey(ticket.id) : '_::_::_';
    return {
      customer_name: ticket.customerInfo.name ?? '',
      address: ticket.customerInfo.address ?? '',
      city_state: cityState,
      zip_code: ticket.customerInfo.zip_code ?? '',
      phone: ticket.customerInfo.phone ?? '',
      email: ticket.customerInfo.email ?? '',
      contact_name: ticket.customerInfo.contact_name ?? '',
      service_location: ticket.entryLocation || ticket.projectLocation || ticket.customerInfo.service_location || '',
      location_code: ticket.customerInfo.location_code ?? '',
      po_number: ticket.customerInfo.po_number ?? '',
      ...approverPoAfeCc,
      other: ticket.projectOther ?? '',
      tech_name: ticket.userName ?? '',
      project_number: ticket.projectNumber ?? '',
      date: ticket.date ?? '',
      rate_rt: ticket.rates.rt,
      rate_tt: ticket.rates.tt,
      rate_ft: ticket.rates.ft,
      rate_shop_ot: ticket.rates.shop_ot,
      rate_field_ot: ticket.rates.field_ot,
      _grouping_key: groupingKey,
      _billing_key: buildBillingKey(approverPoAfeCc.approver, approverPoAfeCc.po_afe, approverPoAfeCc.cc),
    };
  };

  const closePanel = () => {
    setShowCloseConfirm(false);
    setSelectedTicket(null);
    setEditableTicket(null);
    setSubmitError(null);
    setServiceRows([]);
    setEditedDescriptions({});
    setEditedHours({});
    setEditedEntryOverrides({});
    setIsTicketEdited(false);
    setPendingDeleteExpenseIds(new Set());
    setPendingAddExpenses([]);
    setPendingChangesVersion(v => v + 1); // force hasPendingChanges to re-evaluate on next open
    initialEditableTicketRef.current = null;
    initialServiceRowsRef.current = [];
    originalTimeEntryRowsRef.current = [];
  };

  const hasPendingChanges = useMemo(() => {
    if (!editableTicket || !initialEditableTicketRef.current) return false;
    const init = initialEditableTicketRef.current;
    const headerDirty = (Object.keys(editableTicket) as (keyof EditableTicketSnapshot)[]).some(k => normStr(editableTicket[k]) !== normStr(init[k]));
    const initRows = initialServiceRowsRef.current;
    const rowCountChanged = serviceRows.length !== initRows.length;
    const serviceDirty = rowCountChanged || serviceRows.some((row, i) => {
      if (i >= initRows.length) return true;
      const inital = initRows[i];
      if (!inital) return true;
      return normStr(row.description) !== normStr(inital.description)
        || !hoursEq(row.st, inital.st) || !hoursEq(row.tt, inital.tt) || !hoursEq(row.ft, inital.ft)
        || !hoursEq(row.so, inital.so) || !hoursEq(row.fo, inital.fo);
    });
    const hasPendingExpenseDeletes = pendingDeleteExpenseIds.size > 0;
    const hasPendingExpenseAdds = pendingAddExpenses.length > 0;
    return headerDirty || serviceDirty || hasPendingExpenseDeletes || hasPendingExpenseAdds;
  }, [editableTicket, serviceRows, pendingChangesVersion, pendingDeleteExpenseIds.size, pendingAddExpenses.length]);
  
  // Legacy state for backward compatibility (used in some exports)
  const [editedDescriptions, setEditedDescriptions] = useState<Record<string, string[]>>({});
  const [editedHours, setEditedHours] = useState<Record<string, number[]>>({});
  
  // Generated ticket number for display
  const [displayTicketNumber, setDisplayTicketNumber] = useState<string>('');
  
  // Bulk selection state
  const [selectedTicketIds, setSelectedTicketIds] = useState<Set<string>>(new Set());
  const [isBulkExporting, setIsBulkExporting] = useState(false);

  // Convert time entries to service rows (description + 5 hour columns)
  // Reverse order so oldest/first-created entries appear at top
  const entriesToServiceRows = (entries: ServiceTicket['entries']): ServiceRow[] => {
    return [...entries].reverse().map((entry, index) => {
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

  // Build service rows by merging live time entries with per-entry overrides.
  // Entries without overrides use live data. Entries with overrides use saved edits.
  // Manually added rows (id starts with "new-") are appended from overrides.
  const buildRowsWithOverrides = (entries: ServiceTicket['entries'], overrides: Record<string, EntryOverride>): ServiceRow[] => {
    const baseRows = entriesToServiceRows(entries);
    const mergedRows = baseRows.map(row => {
      const ov = overrides[row.id];
      if (ov) {
        return { ...row, description: ov.description, st: ov.st, tt: ov.tt, ft: ov.ft, so: ov.so, fo: ov.fo };
      }
      return row;
    });
    // Append manually added rows (new-xxx) from overrides
    const existingIds = new Set(baseRows.map(r => r.id));
    Object.entries(overrides).forEach(([id, ov]) => {
      if (!existingIds.has(id)) {
        mergedRows.push({ id, description: ov.description, st: ov.st, tt: ov.tt, ft: ov.ft, so: ov.so, fo: ov.fo });
      }
    });
    return mergedRows;
  };

  // Compare a service row to its original time entry row - returns true if they differ
  const rowDiffersFromOriginal = (row: ServiceRow, originalRow: ServiceRow | undefined): boolean => {
    if (!originalRow) return true; // manually added row
    return row.description !== originalRow.description ||
      row.st !== originalRow.st || row.tt !== originalRow.tt || row.ft !== originalRow.ft ||
      row.so !== originalRow.so || row.fo !== originalRow.fo;
  };

  // Compute per-entry overrides from current service rows vs. original time entry rows
  const computeEntryOverrides = (currentRows: ServiceRow[], originalRows: ServiceRow[]): Record<string, EntryOverride> => {
    const originalMap = new Map(originalRows.map(r => [r.id, r]));
    const overrides: Record<string, EntryOverride> = {};
    for (const row of currentRows) {
      const orig = originalMap.get(row.id);
      if (rowDiffersFromOriginal(row, orig)) {
        overrides[row.id] = { description: row.description, st: row.st, tt: row.tt, ft: row.ft, so: row.so, fo: row.fo };
      }
    }
    return overrides;
  };

  // Update service rows and recompute per-entry edit state
  const updateServiceRows = (newRows: ServiceRow[]) => {
    setServiceRows(newRows);
    const overrides = computeEntryOverrides(newRows, originalTimeEntryRowsRef.current);
    setEditedEntryOverrides(overrides);
    setIsTicketEdited(Object.keys(overrides).length > 0);
    const legacy = serviceRowsToLegacyFormat(newRows);
    setEditedDescriptions(legacy.descriptions);
    setEditedHours(legacy.hours);
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
      const existingRecord = findMatchingTicketRecord(ticket);
      
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
          const existing = findMatchingTicketRecord(ticket);
          if (existing) {
            ticketExpenses = await serviceTicketExpensesService.getByTicketId(existing.id);
          }
        } catch (error) {
          console.error('Error loading expenses for export:', error);
          ticketExpenses = [];
        }
      }
      await downloadPdfFromHtml(ticketWithNumber, ticketExpenses);

      // Mark ticket as PDF exported in workflow
      await serviceTicketsService.markPdfExported(existingRecord.id, null, isDemoMode);

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
      const existingRecord = findMatchingTicketRecord(ticket);
      
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
          const existing = findMatchingTicketRecord(ticket);
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
          
          const ov = (existingRecord as { header_overrides?: Record<string, string | number> })?.header_overrides ?? undefined;
          const ticketWithOverrides = ov ? applyHeaderOverridesToTicket(ticket, ov) : ticket;
          const ticketWithNumber = { ...ticketWithOverrides, ticketNumber };
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
      const existing = findMatchingTicketRecord(ticket);
          
      let ticketRecordId: string;
      // Empty entries array (standalone tickets) should NOT be treated as demo
      const isDemoTicket = ticket.entries.length > 0 && ticket.entries.every(entry => entry.is_demo === true);
      
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
        const headerOverrides = buildApprovalHeaderOverrides(ticket);
        // Persist hours at approval so ticket retains them even if time entries are later deleted
        const serviceRows = entriesToServiceRows(ticket.entries);
        const legacy = serviceRowsToLegacyFormat(serviceRows);
        const rtRate = ticket.rates.rt ?? 0;
        const ttRate = ticket.rates.tt ?? 0;
        const ftRate = ticket.rates.ft ?? 0;
        const shopOtRate = ticket.rates.shop_ot ?? 0;
        const fieldOtRate = ticket.rates.field_ot ?? 0;
        const totalAmount = (ticket.hoursByRateType['Shop Time'] ?? 0) * rtRate
          + (ticket.hoursByRateType['Travel Time'] ?? 0) * ttRate
          + (ticket.hoursByRateType['Field Time'] ?? 0) * ftRate
          + (ticket.hoursByRateType['Shop Overtime'] ?? 0) * shopOtRate
          + (ticket.hoursByRateType['Field Overtime'] ?? 0) * fieldOtRate;
        const approvalHours = ticket.totalHours > 0 ? {
          totalHours: ticket.totalHours,
          totalAmount,
          editedHours: legacy.hours,
          editedDescriptions: legacy.descriptions,
        } : undefined;
        await serviceTicketsService.updateTicketNumber(ticketRecordId, ticketNumber, isDemoTicket, user?.id, headerOverrides, approvalHours);
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
        
        const headerOverrides = buildApprovalHeaderOverrides(ticket);
        const record = await serviceTicketsService.createTicketRecord({
          ticketNumber: ticketNumber,
          employeeInitials: ticket.userInitials,
          year,
          sequenceNumber,
          date: ticket.date,
          customerId: ticket.customerId !== 'unassigned' ? ticket.customerId : undefined,
          userId: ticket.userId,
          projectId: ticket.projectId,
          location: ticket.location || '',
          totalHours: ticket.totalHours,
          totalAmount,
          isDemo: isDemoTicket,
          approvedByAdminId: user?.id,
          headerOverrides,
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
      const existing = findMatchingTicketRecord(ticket);

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
          const existing = findMatchingTicketRecord(t);
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
          const existing = findMatchingTicketRecord(t);
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

  // Bulk delete permanently from trash (admin only) - called after in-app confirm
  const handleBulkDeletePermanently = async () => {
    const ticketsToDelete = Array.from(selectedTicketIds)
      .map(id => getTicketById(id))
      .filter(Boolean) as (ServiceTicket & { displayTicketNumber?: string })[];
    if (ticketsToDelete.length === 0) return;

    setShowBulkDeleteConfirm(false);
    try {
      for (const ticket of ticketsToDelete) {
        const record = findMatchingTicketRecord(ticket);
        if (record?.id) {
          await serviceTicketsService.deletePermanently(record.id, isDemoMode);
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets', isDemoMode] });
      await queryClient.invalidateQueries({ queryKey: ['billableEntries'] });
      await queryClient.refetchQueries({ queryKey: ['existingServiceTickets', isDemoMode] });
      queryClient.invalidateQueries({ queryKey: ['rejectedTicketsCount'] });
      queryClient.invalidateQueries({ queryKey: ['resubmittedTicketsCount'] });
      setSelectedTicketIds(new Set());
    } catch (error) {
      console.error('Error bulk deleting:', error);
      alert('Failed to delete tickets.');
    }
  };

  // Bulk restore from trash
  const handleBulkRestore = async () => {
    const ticketsToRestore = Array.from(selectedTicketIds)
      .map(id => getTicketById(id))
      .filter(Boolean) as (ServiceTicket & { displayTicketNumber?: string })[];
    if (ticketsToRestore.length === 0) return;

    try {
      const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
      for (const ticket of ticketsToRestore) {
        const record = findMatchingTicketRecord(ticket);
        if (record?.id) {
          await supabase.from(tableName).update({
            is_discarded: false,
            restored_at: new Date().toISOString(),
            workflow_status: 'draft',
            rejected_at: null,
            rejection_notes: null,
            approved_by_admin_id: null,
            ticket_number: null,
            sequence_number: null,
            year: null,
          }).eq('id', record.id);
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets', isDemoMode] });
      await queryClient.refetchQueries({ queryKey: ['existingServiceTickets', isDemoMode] });
      queryClient.invalidateQueries({ queryKey: ['rejectedTicketsCount'] });
      queryClient.invalidateQueries({ queryKey: ['resubmittedTicketsCount'] });
      setSelectedTicketIds(new Set());
    } catch (error) {
      console.error('Error bulk restoring:', error);
      alert('Failed to restore tickets.');
    }
  };

  // Bulk move to trash
  const handleBulkMoveToTrash = async () => {
    const ticketsToTrash = Array.from(selectedTicketIds)
      .map(id => getTicketById(id))
      .filter(Boolean) as (ServiceTicket & { displayTicketNumber?: string })[];
    if (ticketsToTrash.length === 0) return;
    if (!confirm(`Move ${ticketsToTrash.length} ticket${ticketsToTrash.length > 1 ? 's' : ''} to trash? They can be restored from the Show Trash view.`)) return;

    try {
      const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
      for (const ticket of ticketsToTrash) {
        const record = findMatchingTicketRecord(ticket);
        if (record?.id) {
          await supabase.from(tableName).update({
            is_discarded: true,
            ticket_number: null,
            sequence_number: null,
            year: null,
            approved_by_admin_id: null,
          }).eq('id', record.id);
        } else if (ticket.customerId && ticket.customerId !== 'unassigned') {
          const billingKey = ticket.id ? getTicketBillingKeyLocal(ticket.id) : '_::_::_';
          const created = await serviceTicketsService.getOrCreateTicket({
            date: ticket.date,
            userId: ticket.userId,
            customerId: ticket.customerId,
            projectId: ticket.projectId,
            location: ticket.location || '',
            billingKey,
          }, isDemoMode);
          await supabase.from(tableName).update({
            is_discarded: true,
            ticket_number: null,
            sequence_number: null,
            year: null,
            approved_by_admin_id: null,
          }).eq('id', created.id);
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets', isDemoMode] });
      await queryClient.refetchQueries({ queryKey: ['existingServiceTickets', isDemoMode] });
      setSelectedTicketIds(new Set());
    } catch (error) {
      console.error('Error bulk moving to trash:', error);
      alert('Failed to move tickets to trash.');
    }
  };

  // Fetch billable entries (filtered by demo mode)
  // Non-admins only see their own entries; admins can filter by selectedUserId
  const { data: billableEntries, isLoading: isLoadingEntries, error: entriesError } = useQuery({
    queryKey: ['billableEntries', startDate, endDate, selectedCustomerId, selectedUserId, isDemoMode, isAdmin, user?.id],
    queryFn: () => serviceTicketsService.getBillableEntries({
      startDate,
      endDate,
      customerId: selectedCustomerId || undefined,
      userId: isAdmin ? (selectedUserId || undefined) : (user?.id ?? undefined),
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

  // Fetch projects for create ticket panel
  const { data: allProjects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => projectsService.getAll(),
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

  // All users can access this page - non-admins will only see their own tickets

  // Group entries into tickets (with employee rates)
  // Fetch existing ticket numbers and edited hours for display (scoped to date range for performance)
  // Non-admins only fetch their own tickets; admins fetch all
  const { data: existingTickets } = useQuery({
    queryKey: ['existingServiceTickets', isDemoMode, startDate, endDate, isAdmin, user?.id],
    queryFn: async () => {
      const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
      let query = supabase
        .from(tableName)
        .select(`
          id, ticket_number, sequence_number, date, user_id, customer_id, project_id, location, is_edited, edited_hours, edited_entry_overrides, total_hours, workflow_status, approved_by_admin_id, is_discarded, restored_at, rejected_at, rejection_notes, header_overrides,
          approved_by_admin:users!service_tickets_approved_by_admin_id_fkey(first_name, last_name)
        `)
        .gte('date', startDate)
        .lte('date', endDate);
      if (!isAdmin && user?.id) {
        query = query.eq('user_id', user.id);
      }
      const { data, error } = await query;
      if (error) {
        // If the join fails (column doesn't exist yet), try without the join
        let fallbackQuery = supabase
          .from(tableName)
          .select('id, ticket_number, sequence_number, date, user_id, customer_id, project_id, location, is_edited, edited_hours, edited_entry_overrides, total_hours, workflow_status, approved_by_admin_id, is_discarded, restored_at, rejected_at, rejection_notes, header_overrides')
          .gte('date', startDate)
          .lte('date', endDate);
        if (!isAdmin && user?.id) {
          fallbackQuery = fallbackQuery.eq('user_id', user.id);
        }
        const { data: fallbackData, error: fallbackError } = await fallbackQuery;
        if (fallbackError) throw fallbackError;
        return fallbackData;
      }
      return data;
    },
  });

  /**
   * Service tickets come from two sources:
   *
   * DRAFTS (from time entries):
   *   Built live from billable time entries. Editable. Grouped by date+user+customer+project+po_afe.
   *   If a draft DB record exists (workflow_status = 'draft' or 'rejected'), it's linked via _matchedRecordId.
   *
   * LOCKED (from DB - submitted or approved):
   *   Once submitted or approved, the ticket is built entirely from the DB record.
   *   Time entries no longer affect it. Hours from edited_hours/total_hours, header from header_overrides.
   *
   * A "locked" record is any DB record where:
   *   - ticket_number is set (approved), OR
   *   - workflow_status is not 'draft' and not 'rejected' (submitted)
   *
   * Locked records claim their matching base ticket so it doesn't also appear as a draft.
   */
  const tickets = useMemo(() => {
    const baseTickets = billableEntries ? groupEntriesIntoTickets(billableEntries, employees) : [];
    const existing = existingTickets ?? [];

    // --- Helpers ---
    // Core match: date + user + customer + project + location (matches grouping hierarchy)
    const getRecordLocation = (rec: (typeof existing)[number]): string =>
      ((rec as any).location ?? '').trim().toLowerCase();

    const getBaseTicketLocation = (bt: ServiceTicket): string =>
      (bt.location ?? bt.entryLocation ?? '').trim().toLowerCase();

    const getRecordPoAfe = (rec: (typeof existing)[number]): string => {
      const ov = (rec.header_overrides as Record<string, string> | null) ?? {};
      return (ov.po_afe ?? '').trim();
    };

    const getBaseTicketPoAfe = (bt: ServiceTicket): string =>
      (bt.entryPoAfe ?? bt.projectPoAfe ?? '').trim();

    const baseTicketMatchesRecord = (bt: ServiceTicket, rec: (typeof existing)[number]) =>
      bt.date === rec.date &&
      bt.userId === rec.user_id &&
      (rec.customer_id === bt.customerId || (!rec.customer_id && bt.customerId === 'unassigned')) &&
      ((rec.project_id || '') === (bt.projectId || '') || !rec.project_id) &&
      // Location: if both have a value, they must match
      ((!getRecordLocation(rec) || !getBaseTicketLocation(bt)) || getRecordLocation(rec) === getBaseTicketLocation(bt));

    // Full match: project + location + PO/AFE (hierarchical)
    const baseTicketFullMatchesRecord = (bt: ServiceTicket, rec: (typeof existing)[number]) => {
      if (!baseTicketMatchesRecord(bt, rec)) return false;
      const recPo = getRecordPoAfe(rec);
      const btPo = getBaseTicketPoAfe(bt);
      if (recPo && btPo && recPo !== btPo) return false;
      return true;
    };

    // --- Classify DB records ---
    const isLockedRecord = (rec: (typeof existing)[number]) => {
      if ((rec as any).is_discarded) return false;
      if (!rec.customer_id) return false;
      if (rec.ticket_number) return true; // approved
      const ws = (rec.workflow_status || 'draft') as string;
      return ws !== 'draft' && ws !== 'rejected'; // submitted
    };

    const lockedRecords = existing.filter(isLockedRecord);
    const draftRecords = existing.filter(rec =>
      rec.customer_id && !rec.ticket_number && !(rec as any).is_discarded &&
      ((rec.workflow_status || 'draft') === 'draft' || rec.workflow_status === 'rejected')
    );

    // --- Claim base tickets for locked records (so they don't appear as drafts) ---
    // Hierarchy: project > location > PO/AFE. Prefer full match, fall back to core match.
    const claimedBaseTicketIds = new Set<string>();
    const claimedBaseTicketByRecordId = new Map<string, ServiceTicket>();
    for (const rec of lockedRecords) {
      const bt = baseTickets.find(
        b => !claimedBaseTicketIds.has(b.id) && baseTicketFullMatchesRecord(b, rec)
      ) ?? baseTickets.find(
        b => !claimedBaseTicketIds.has(b.id) && baseTicketMatchesRecord(b, rec)
      );
      if (bt) {
        claimedBaseTicketIds.add(bt.id);
        claimedBaseTicketByRecordId.set(rec.id, bt);
      }
    }

    // --- Link draft records to base tickets (1:1, tracked) ---
    // Hierarchy: project > location > PO/AFE. Prefer full match, fall back to core match.
    const usedDraftRecordIds = new Set<string>();
    const findDraftRecordForBaseTicket = (bt: ServiceTicket) => {
      const found = draftRecords.find(
        rec => !usedDraftRecordIds.has(rec.id) && baseTicketFullMatchesRecord(bt, rec)
      ) ?? draftRecords.find(
        rec => !usedDraftRecordIds.has(rec.id) && baseTicketMatchesRecord(bt, rec)
      );
      if (found) usedDraftRecordIds.add(found.id);
      return found;
    };

    // --- Build locked ticket from DB record ---
    // Both submitted and approved are built entirely from DB (entries from matched base ticket for display, hours from edited_hours/total_hours).
    // Time entries do not affect locked ticket hours, but entries are attached for modal display when no saved data exists.
    const buildLockedTicketFromRecord = (st: (typeof existing)[number]) => {
      // Attach matched time entries for display in modal (especially for legacy tickets with no saved row data)
      const matchedBaseTicket = claimedBaseTicketByRecordId.get(st.id);
      const matchedEntries = matchedBaseTicket?.entries ?? [];
      const editedHours = (st.edited_hours as Record<string, number | number[]>) || {};
      const hoursByRateType: ServiceTicket['hoursByRateType'] = {
        'Shop Time': 0, 'Shop Overtime': 0, 'Travel Time': 0, 'Field Time': 0, 'Field Overtime': 0,
      };
      Object.keys(editedHours).forEach(rateType => {
        const hours = editedHours[rateType];
        if (rateType in hoursByRateType) {
          (hoursByRateType as any)[rateType] = Array.isArray(hours)
            ? hours.reduce((s: number, h: number) => s + (h || 0), 0) : (hours as number) || 0;
        }
      });
      let totalHours = Object.values(hoursByRateType).reduce((s, h) => s + h, 0);
      if (totalHours === 0 && (st as { total_hours?: number }).total_hours != null) {
        const dbTotal = Number((st as { total_hours?: number }).total_hours) || 0;
        if (dbTotal > 0) {
          hoursByRateType['Shop Time'] = dbTotal;
          totalHours = dbTotal;
        }
      }
      const customer = customers?.find((c: any) => c.id === st.customer_id);
      const customerName = customer?.name || 'Unknown Customer';
      const emp = employees?.find((e: any) => e.user_id === st.user_id);
      const firstName = emp?.user?.first_name || '';
      const lastName = emp?.user?.last_name || '';
      const userName = `${firstName} ${lastName}`.trim() || 'Unknown';
      const userInitials = (firstName && lastName) ? `${firstName[0]}${lastName[0]}`.toUpperCase() : 'XX';
      const project = allProjects?.find((p: any) => p.id === (st as any).project_id) ?? null;
      const ovForProject = (st as { header_overrides?: Record<string, string> })?.header_overrides;
      const projectNumber = ovForProject?.project_number ?? project?.project_number ?? '';
      const projectName = project?.name ?? '';
      const out: ServiceTicket & { _matchedRecordId: string } = {
        id: st.id,
        date: st.date,
        customerId: st.customer_id,
        projectId: (st as any).project_id,
        location: (st as any).location ?? '',
        customerName,
        customerInfo: {
          name: customerName,
          contact_name: customer?.contact_name,
          email: customer?.email,
          phone: customer?.phone,
          address: customer?.address,
          city: customer?.city,
          state: customer?.state,
          zip_code: customer?.zip_code,
          po_number: customer?.po_number,
          approver_name: customer?.approver_name,
          location_code: customer?.location_code,
          service_location: customer?.service_location ?? ((st as any).location ?? ''),
        },
        userId: st.user_id,
        userName,
        userInitials,
        projectNumber,
        projectName,
        ticketNumber: st.ticket_number || undefined,
        totalHours,
        entries: matchedEntries,
        hoursByRateType,
        rates: matchedBaseTicket?.rates ?? { rt: 0, tt: 0, ft: 0, shop_ot: 0, field_ot: 0 },
        _matchedRecordId: st.id,
        // Copy project/entry-level fields from matched base ticket for header display
        ...(matchedBaseTicket ? {
          projectLocation: matchedBaseTicket.projectLocation,
          projectApprover: matchedBaseTicket.projectApprover,
          projectPoAfe: matchedBaseTicket.projectPoAfe,
          projectCc: matchedBaseTicket.projectCc,
          projectOther: matchedBaseTicket.projectOther,
          projectApproverPoAfe: matchedBaseTicket.projectApproverPoAfe,
          entryLocation: matchedBaseTicket.entryLocation,
          entryApprover: matchedBaseTicket.entryApprover,
          entryPoAfe: matchedBaseTicket.entryPoAfe,
          entryCc: matchedBaseTicket.entryCc,
          entryOther: matchedBaseTicket.entryOther,
        } : {}),
      };
      const ov = (st as { header_overrides?: Record<string, string | number> })?.header_overrides;
      return ov ? applyHeaderOverridesToTicket(out, ov) : out;
    };

    // --- Assemble ---
    // Draft tickets: from time entries (not claimed by locked records) + orphaned draft records (manual edits, no time entries)
    const draftTickets: (ServiceTicket & { _matchedRecordId?: string | null })[] = [];
    for (const bt of baseTickets) {
      if (claimedBaseTicketIds.has(bt.id)) continue;
      const draftRec = findDraftRecordForBaseTicket(bt);
      
      // If draft record has saved hours (manual edits), use those instead of time entry hours
      if (draftRec && (draftRec.is_edited || (draftRec as any).edited_entry_overrides)) {
        const savedOverrides = (draftRec as any).edited_entry_overrides as Record<string, { st: number; tt: number; ft: number; so: number; fo: number }> | null;
        const editedHours = (draftRec.edited_hours as Record<string, number | number[]>) || {};
        
        // Calculate hours from per-entry overrides if available
        let hoursByRateType = { ...bt.hoursByRateType };
        let totalHours = bt.totalHours;
        
        if (savedOverrides && Object.keys(savedOverrides).length > 0) {
          // Build hours from base entries + overrides (same logic as buildRowsWithOverrides)
          const baseEntryHours = { 'Shop Time': 0, 'Travel Time': 0, 'Field Time': 0, 'Shop Overtime': 0, 'Field Overtime': 0 };
          const overrideHours = { st: 0, tt: 0, ft: 0, so: 0, fo: 0 };
          const overrideIds = new Set(Object.keys(savedOverrides));
          
          // Sum hours from base entries that are NOT overridden
          bt.entries.forEach(entry => {
            if (!overrideIds.has(entry.id)) {
              const rateType = entry.rate_type as keyof typeof baseEntryHours;
              if (rateType in baseEntryHours) {
                baseEntryHours[rateType] += entry.hours || 0;
              }
            }
          });
          
          // Sum hours from overrides (including manual rows)
          Object.values(savedOverrides).forEach(ov => {
            overrideHours.st += ov.st || 0;
            overrideHours.tt += ov.tt || 0;
            overrideHours.ft += ov.ft || 0;
            overrideHours.so += ov.so || 0;
            overrideHours.fo += ov.fo || 0;
          });
          
          hoursByRateType = {
            'Shop Time': baseEntryHours['Shop Time'] + overrideHours.st,
            'Travel Time': baseEntryHours['Travel Time'] + overrideHours.tt,
            'Field Time': baseEntryHours['Field Time'] + overrideHours.ft,
            'Shop Overtime': baseEntryHours['Shop Overtime'] + overrideHours.so,
            'Field Overtime': baseEntryHours['Field Overtime'] + overrideHours.fo,
          };
          totalHours = Object.values(hoursByRateType).reduce((sum, h) => sum + h, 0);
        } else if (Object.keys(editedHours).length > 0) {
          // Legacy: use edited_hours from DB
          hoursByRateType = { 'Shop Time': 0, 'Shop Overtime': 0, 'Travel Time': 0, 'Field Time': 0, 'Field Overtime': 0 };
          Object.keys(editedHours).forEach(rateType => {
            const hours = editedHours[rateType];
            if (rateType in hoursByRateType) {
              (hoursByRateType as any)[rateType] = Array.isArray(hours)
                ? hours.reduce((s: number, h: number) => s + (h || 0), 0) : (hours as number) || 0;
            }
          });
          totalHours = Object.values(hoursByRateType).reduce((sum, h) => sum + h, 0);
        }
        
        draftTickets.push({ ...bt, hoursByRateType, totalHours, _matchedRecordId: draftRec.id });
      } else {
        draftTickets.push({ ...bt, _matchedRecordId: draftRec?.id ?? null });
      }
    }
    
    // Add orphaned draft records (draft records with saved data but no matching time entries)
    // This preserves tickets when time entries are deleted but the ticket has saved edits/hours
    const orphanedDraftRecords = draftRecords.filter(rec => {
      if (usedDraftRecordIds.has(rec.id)) return false;
      // Include if has any saved data worth preserving:
      // 1. Per-entry overrides (manual rows added via new system)
      const hasOverrides = (rec as any).edited_entry_overrides != null && Object.keys((rec as any).edited_entry_overrides as object).length > 0;
      // 2. Legacy is_edited flag
      const isLegacyEdited = rec.is_edited === true;
      // 3. Has saved edited_hours (from previous saves)
      const hasEditedHours = rec.edited_hours != null && Object.keys(rec.edited_hours as object).length > 0;
      // 4. Has total_hours recorded (ticket was saved with hours at some point)
      const hasTotalHours = (rec as { total_hours?: number }).total_hours != null && Number((rec as { total_hours?: number }).total_hours) > 0;
      // 5. Is the currently-selected ticket (preserve while user is editing, even if no saved data yet)
      const isCurrentlySelected = currentTicketRecordId != null && rec.id === currentTicketRecordId;
      return hasOverrides || isLegacyEdited || hasEditedHours || hasTotalHours || isCurrentlySelected;
    });
    for (const rec of orphanedDraftRecords) {
      const orphanTicket = buildLockedTicketFromRecord(rec);
      draftTickets.push(orphanTicket);
    }

    // Locked tickets: from DB records (submitted + approved)
    const lockedTickets = lockedRecords.map(buildLockedTicketFromRecord);

    return [...draftTickets, ...lockedTickets];
  }, [billableEntries, employees, existingTickets, customers, allProjects, currentTicketRecordId]);

  // Live hours computed from serviceRows when a ticket is selected
  const selectedTicketId = selectedTicket?.id;
  const liveHoursForSelectedTicket = useMemo((): { st: number; tt: number; ft: number; so: number; fo: number; total: number } | null => {
    if (!selectedTicketId) return null;
    // Return live totals even if serviceRows is empty (shows 0.00)
    const st = serviceRows.reduce((sum, r) => sum + (r.st || 0), 0);
    const tt = serviceRows.reduce((sum, r) => sum + (r.tt || 0), 0);
    const ft = serviceRows.reduce((sum, r) => sum + (r.ft || 0), 0);
    const so = serviceRows.reduce((sum, r) => sum + (r.so || 0), 0);
    const fo = serviceRows.reduce((sum, r) => sum + (r.fo || 0), 0);
    return { st, tt, ft, so, fo, total: st + tt + ft + so + fo };
  }, [selectedTicketId, serviceRows]);

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

  /** Extract billing key from ticket.id (approver::poAfe::cc) */
  const getTicketBillingKeyLocal = (ticketId: string): string => getTicketBillingKey(ticketId);

  /**
   * Find a matching existing ticket record for a computed ticket.
   * Match by _matchedRecordId first (set during ticket build), then by ticket.id (standalone = record id), then by date+user+customer+project.
   */
  const findMatchingTicketRecord = (ticket: { id?: string; _matchedRecordId?: string; date: string; userId: string; customerId: string; projectId?: string; location?: string; entryLocation?: string }) => {
    if ((ticket as { _matchedRecordId?: string })._matchedRecordId && existingTickets) {
      const byMatched = existingTickets.find(et => et.id === (ticket as { _matchedRecordId?: string })._matchedRecordId);
      if (byMatched && !(byMatched as any).is_discarded) return byMatched;
    }
    if (ticket.id && existingTickets) {
      const byId = existingTickets.find(et => et.id === ticket.id);
      if (byId) return (existingTickets.find(et => et.id === ticket.id && !(et as any).is_discarded) || byId) as typeof byId;
    }
    const ticketLoc = (ticket.location ?? ticket.entryLocation ?? '').trim().toLowerCase();
    const baseFilter = (et: NonNullable<typeof existingTickets>[number]) => {
      const recLoc = ((et as any).location ?? '').trim().toLowerCase();
      return et.date === ticket.date &&
        et.user_id === ticket.userId &&
        (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned')) &&
        ((et.project_id || '') === (ticket.projectId || '') || !et.project_id) &&
        // Location must match (both empty = match, both have value = must be equal)
        ((!recLoc && !ticketLoc) || recLoc === ticketLoc);
    };
    const matches = existingTickets?.filter(et => baseFilter(et)) || [];
    // Fallback: if no location-filtered match, try without location (for legacy records)
    const found = matches.find(et => !(et as any).is_discarded) || matches[0] || (() => {
      const fallbackFilter = (et: NonNullable<typeof existingTickets>[number]) =>
        et.date === ticket.date &&
        et.user_id === ticket.userId &&
        (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned')) &&
        ((et.project_id || '') === (ticket.projectId || '') || !et.project_id);
      const fallbackMatches = existingTickets?.filter(et => fallbackFilter(et)) || [];
      return fallbackMatches.find(et => !(et as any).is_discarded) || fallbackMatches[0];
    })();
    return found || null;
  };

  // Get or create service ticket record ID when a ticket is selected
  const getOrCreateTicketRecord = async (ticket: ServiceTicket): Promise<string> => {
    // Try to find existing ticket record
    const existing = findMatchingTicketRecord(ticket);

    if (existing) {
      return existing.id;
    }

    // For admins, create with a ticket number (approval flow)
    if (isAdmin) {
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

      const headerOverrides = buildApprovalHeaderOverrides(ticket);
      const record = await serviceTicketsService.createTicketRecord({
        ticketNumber,
        employeeInitials: ticket.userInitials,
        year,
        sequenceNumber,
        date: ticket.date,
        customerId: ticket.customerId !== 'unassigned' ? ticket.customerId : undefined,
        userId: ticket.userId,
        projectId: ticket.projectId,
        location: ticket.location || '',
        totalHours: ticket.totalHours,
        totalAmount,
        approvedByAdminId: user?.id,
        headerOverrides,
      });

      return record.id;
    }

    // For non-admins, create a draft record without a ticket number
    const billingKey = ticket.id ? getTicketBillingKeyLocal(ticket.id) : '_::_::_';
    // Pass entry values so new records get correct approver/po_afe/cc (billingKey only has po_afe for grouping)
    const headerOverrides = (ticket.entryApprover != null || ticket.entryPoAfe != null || ticket.entryCc != null || ticket.entryOther != null)
      ? {
          approver: ticket.entryApprover ?? '',
          po_afe: ticket.entryPoAfe ?? '',
          cc: ticket.entryCc ?? '',
          other: ticket.entryOther ?? '',
          service_location: ticket.entryLocation ?? ticket.location ?? '',
        }
      : undefined;
    const record = await serviceTicketsService.getOrCreateTicket({
      date: ticket.date,
      userId: ticket.userId,
      customerId: ticket.customerId === 'unassigned' ? null : ticket.customerId,
      projectId: ticket.projectId,
      location: ticket.location || '',
      billingKey,
      headerOverrides,
    }, isDemoMode);

    return record.id;
  };

  // Match tickets with existing ticket numbers or generate preview
  // Apply header_overrides so admin-edited approved tickets show correct data in list and when opened
  const ticketsWithNumbers = useMemo(() => {
    return tickets.map(ticket => {
      // Check if this is a demo ticket (all entries are demo; empty = not demo)
      const isDemoTicket = ticket.entries.length > 0 && ticket.entries.every(entry => entry.is_demo === true);
      
      // Use pre-matched record from merge (avoids duplicate ticket numbers when one record matched multiple base tickets)
      const matchedId = (ticket as { _matchedRecordId?: string | null })._matchedRecordId;
      const existing = (matchedId && existingTickets
        ? existingTickets.find(et => et.id === matchedId)
        : matchedId === null
          ? null
          : findMatchingTicketRecord(ticket)) ?? undefined;
      const isDiscarded = !!(existing as any)?.is_discarded;
      const ov = (existing as { header_overrides?: Record<string, string | number> })?.header_overrides;
      // Apply header_overrides when present (user or admin saved overrides).
      // For drafts, ov reflects user's saved overrides; for approved, admin edits.
      const isDraftNoNumber = !existing?.ticket_number;
      const ticketWithOverrides = ov ? applyHeaderOverridesToTicket(ticket, ov) : ticket;
      
      // If there's an existing ticket number and NOT trashed, use it (even for demo tickets)
      // Trashed tickets must never display a ticket ID
      if (existing?.ticket_number && !isDiscarded) {
        return {
          ...ticketWithOverrides,
          displayTicketNumber: existing.ticket_number
        };
      }
      
      // Otherwise (no ticket number, or trashed), show XXX placeholder
      const yearPart = ticket.date ? String(parseInt(ticket.date.slice(0, 4), 10) % 100) : '';
      return {
        ...ticketWithOverrides,
        displayTicketNumber: `${ticket.userInitials}_${yearPart}XXX`
      };
    });
  }, [tickets, existingTickets, isAdmin]);

  // Filter and sort tickets
  const filteredTickets = useMemo(() => {
    let result = ticketsWithNumbers;
    
    // Non-admin users can only see their own tickets
    if (!isAdmin && user?.id) {
      result = result.filter(t => t.userId === user.id);
    }
    
    // Filter by date range (applies to all tickets including standalone)
    if (startDate) {
      result = result.filter(t => t.date >= startDate);
    }
    if (endDate) {
      result = result.filter(t => t.date <= endDate);
    }
    
    // Filter out discarded tickets unless showDiscarded is active
    result = result.filter(t => {
      const existing = findMatchingTicketRecord(t);
      const isDiscarded = !!(existing as any)?.is_discarded;

      if (!showDiscarded) {
        return !isDiscarded; // Normal view: hide all discarded tickets
      } else {
        return isDiscarded; // Discarded view: show all discarded tickets
      }
    });
    
    if (selectedCustomerId) {
      result = result.filter(t => t.customerId === selectedCustomerId);
    }

    // Filter by employee (admin only)
    if (isAdmin && selectedUserId) {
      result = result.filter(t => t.userId === selectedUserId);
    }
    
    // Filter by Tab (Status Group) - skip when viewing trash (show all trashed from draft/submitted/approved)
    if (!showDiscarded && activeTab && activeTab !== 'all') {
      result = result.filter(t => {
        const existing = findMatchingTicketRecord(t);
        const hasTicketNumber = !!existing?.ticket_number;
        const workflowStatus = existing?.workflow_status || 'draft';
        
        if (activeTab === 'draft') {
          // Hide zero-hour tickets from drafts
          if ((t.totalHours ?? 0) <= 0) return false;
          // Drafts: Not submitted (workflow not approved) and no ticket number
          return !hasTicketNumber && (workflowStatus === 'draft' || workflowStatus === 'rejected');
        } else if (activeTab === 'submitted') {
          // Submitted: Submitted by user (workflow approved) but no ticket number assigned by admin yet
          return !hasTicketNumber && workflowStatus !== 'draft' && workflowStatus !== 'rejected';
        } else if (activeTab === 'approved') {
          // Approved: Ticket number has been assigned (Finalized)
          return hasTicketNumber;
        }
        return true;
      });
    }
    
    // Sort tickets (restored first; then new/rejected/resubmitted by tab; then by sort field)
    result = [...result].sort((a, b) => {
      // Restored tickets (from trash) always at top until interacted with
      const aRec = findMatchingTicketRecord(a);
      const bRec = findMatchingTicketRecord(b);
      const aRestored = !showDiscarded && !!(aRec as any)?.restored_at;
      const bRestored = !showDiscarded && !!(bRec as any)?.restored_at;
      if (aRestored && !bRestored) return -1;
      if (!aRestored && bRestored) return 1;

      if (activeTab === 'draft' && !showDiscarded) {
        const aNew = !aRec && (a.entries?.length ?? 0) > 0;
        const bNew = !bRec && (b.entries?.length ?? 0) > 0;
        if (aNew && !bNew) return -1;
        if (!aNew && bNew) return 1;
        const aRej = aRec?.workflow_status === 'rejected';
        const bRej = bRec?.workflow_status === 'rejected';
        if (aRej && !bRej) return -1;
        if (!aRej && bRej) return 1;
      }
      if (activeTab === 'submitted') {
        const aResub = !!aRec?.rejected_at;
        const bResub = !!bRec?.rejected_at;
        if (aResub && !bResub) return -1;
        if (!aResub && bResub) return 1;
      }
      let aVal: string | number;
      let bVal: string | number;
      
      switch (effectiveSortField) {
        case 'ticketNumber': {
          // Sort by initials prefix alphabetically, then by sequence number within each prefix
          // e.g. AR_26001, AR_26002, DB_26001, DB_26003, HV_26001, MW_26001...
          const aTicket = a.displayTicketNumber || a.ticketNumber || '';
          const bTicket = b.displayTicketNumber || b.ticketNumber || '';
          const aPrefix = (aTicket.match(/^([A-Za-z]+)/) || ['', ''])[1].toUpperCase();
          const bPrefix = (bTicket.match(/^([A-Za-z]+)/) || ['', ''])[1].toUpperCase();
          if (aPrefix !== bPrefix) {
            aVal = aPrefix;
            bVal = bPrefix;
          } else {
            // Same prefix: sort by sequence_number if available, else parse from ticket number
            const aSeq = (aRec as { sequence_number?: number })?.sequence_number;
            const bSeq = (bRec as { sequence_number?: number })?.sequence_number;
            if (aSeq != null && bSeq != null) {
              aVal = aSeq;
              bVal = bSeq;
            } else {
              const parseNum = (s: string) => {
                const m = (s || '').match(/(\d+)$/);
                return m ? parseInt(m[1], 10) : 0;
              };
              aVal = parseNum(aTicket);
              bVal = parseNum(bTicket);
            }
          }
          break;
        }
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
      
      if (aVal < bVal) return effectiveSortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return effectiveSortDirection === 'asc' ? 1 : -1;
      return 0;
    });
    
    return result;
  }, [ticketsWithNumbers, selectedCustomerId, selectedUserId, activeTab, existingTickets, sortField, sortDirection, isAdmin, user?.id, showDiscarded, startDate, endDate]);

  // Close panel when selected ticket is no longer in filtered list; refresh when ticket data changes (e.g. entry deleted from calendar)
  // After save, skip sync for 2s so we don't overwrite service rows (refetch can produce different ticket structure)
  useEffect(() => {
    if (justSavedRef.current) return;
    if (selectedTicket) {
      let freshTicket = filteredTickets.find(t => t.id === selectedTicket.id);
      if (!freshTicket && currentTicketRecordId) {
        freshTicket = filteredTickets.find(t => findMatchingTicketRecord(t)?.id === currentTicketRecordId);
      }
      if (!freshTicket) {
        setSelectedTicket(null);
        setCurrentTicketRecordId(null);
      } else if (freshTicket !== selectedTicket) {
        const wouldClearEntries = freshTicket.entries.length === 0 && selectedTicket.entries.length > 0;
        if (wouldClearEntries) return;
        setSelectedTicket(freshTicket);
        // Update original time entry rows and rebuild with any per-entry overrides
        const freshBaseRows = entriesToServiceRows(freshTicket.entries);
        originalTimeEntryRowsRef.current = freshBaseRows.map(r => ({ ...r }));
        const currentOverrides = editedEntryOverrides;
        if (Object.keys(currentOverrides).length > 0) {
          const mergedRows = buildRowsWithOverrides(freshTicket.entries, currentOverrides);
          setServiceRows(mergedRows);
          initialServiceRowsRef.current = mergedRows.map(r => ({ ...r }));
        } else {
          setServiceRows(freshBaseRows);
          initialServiceRowsRef.current = freshBaseRows.map(r => ({ ...r }));
        }
      }
    }
  }, [activeTab, showDiscarded, filteredTickets, selectedTicket, currentTicketRecordId]);

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


  // Open create ticket panel
  const openCreatePanel = () => {
    const techName = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '';
    setCreateCustomerId('');
    setCreateProjectId('');
    setCreateData({
      customerName: '',
      address: '',
      cityState: '',
      zipCode: '',
      phone: '',
      email: '',
      contactName: '',
      serviceLocation: '',
      locationCode: '',
      poNumber: '',
      approver: '',
      poAfe: '',
      cc: '',
      other: '',
      techName,
      projectNumber: '',
      date: new Date().toISOString().split('T')[0],
    });
    setCreateServiceRows([{ id: 'new-1', description: '', st: 0, tt: 0, ft: 0, so: 0, fo: 0 }]);
    setCreateExpenses([]);
    setCreateEditingExpense(null);
    setShowInlineCreateCustomer(false);
    setInlineCustomerName('');
    setShowInlineCreateProject(false);
    setInlineProjectName('');
    setInlineProjectNumber('');
    setShowCreatePanel(true);
  };

  // Handle customer selection in create panel - auto-populate fields
  const handleCreateCustomerSelect = (customerId: string) => {
    setCreateCustomerId(customerId);
    setCreateProjectId('');
    if (!customerId) {
      setCreateData(prev => ({
        ...prev,
        customerName: '',
        address: '',
        cityState: '',
        zipCode: '',
        phone: '',
        email: '',
        contactName: '',
        serviceLocation: '',
        locationCode: '',
        poNumber: '',
        approver: '',
        poAfe: '',
        cc: '',
        other: '',
        projectNumber: '',
      }));
      return;
    }
    const customer = customers?.find((c: any) => c.id === customerId);
    if (customer) {
      setCreateData(prev => ({
        ...prev,
        customerName: customer.name || '',
        address: customer.address || '',
        cityState: [customer.city, customer.state].filter(Boolean).join(', '),
        zipCode: customer.zip_code || '',
        phone: customer.phone || '',
        email: customer.email || '',
        contactName: customer.contact_name || '',
        serviceLocation: customer.service_location || '',
        locationCode: customer.location_code || '',
        poNumber: customer.po_number || '',
        approver: customer.approver_name || '',
        poAfe: '',
        cc: '',
        other: '',
        projectNumber: '',
      }));
    }
  };

  // Handle project selection in create panel - auto-populate project fields
  const handleCreateProjectSelect = (projectId: string) => {
    setCreateProjectId(projectId);
    if (!projectId) {
      setCreateData(prev => ({ ...prev, projectNumber: '', serviceLocation: prev.serviceLocation, approver: prev.approver, poAfe: prev.poAfe, cc: prev.cc, other: '' }));
      return;
    }
    const project = allProjects?.find((p: any) => p.id === projectId);
    if (project) {
      const fields = getProjectHeaderFields(project);
      setCreateData(prev => ({
        ...prev,
        projectNumber: project.project_number || '',
        serviceLocation: project.location || prev.serviceLocation,
        approver: fields.approver || prev.approver,
        poAfe: fields.poAfe || prev.poAfe,
        cc: fields.cc || prev.cc,
        other: fields.other || prev.other,
      }));
    }
  };

  // Inline create customer
  const handleInlineCreateCustomer = async () => {
    if (!inlineCustomerName.trim()) return;
    setIsCreatingCustomer(true);
    try {
      const newCustomer = await customersService.create({ name: inlineCustomerName.trim() });
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      await queryClient.refetchQueries({ queryKey: ['customers'] });
      setCreateCustomerId(newCustomer.id);
      setCreateData(prev => ({ ...prev, customerName: newCustomer.name || '' }));
      setShowInlineCreateCustomer(false);
      setInlineCustomerName('');
    } catch (err) {
      console.error('Error creating customer:', err);
      alert('Failed to create customer. ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsCreatingCustomer(false);
    }
  };

  // Inline create project
  const handleInlineCreateProject = async () => {
    if (!inlineProjectName.trim() || !createCustomerId || !user?.id) return;
    setIsCreatingProject(true);
    try {
      const newProject = await projectsService.create({
        name: inlineProjectName.trim(),
        project_number: inlineProjectNumber.trim() || null,
        customer_id: createCustomerId,
        status: 'active',
      }, user.id);
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      await queryClient.refetchQueries({ queryKey: ['projects'] });
      setCreateProjectId(newProject.id);
      const fields = getProjectHeaderFields(newProject);
      setCreateData(prev => ({
        ...prev,
        projectNumber: newProject.project_number || '',
        serviceLocation: newProject.location || prev.serviceLocation,
        approver: fields.approver || prev.approver,
        poAfe: fields.poAfe || prev.poAfe,
        cc: fields.cc || prev.cc,
        other: fields.other || prev.other,
      }));
      setShowInlineCreateProject(false);
      setInlineProjectName('');
      setInlineProjectNumber('');
    } catch (err) {
      console.error('Error creating project:', err);
      alert('Failed to create project. ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsCreatingProject(false);
    }
  };

  // Projects filtered by selected customer
  const createProjectOptions = useMemo(() => {
    if (!allProjects || !createCustomerId) return [];
    return allProjects
      .filter((p: any) => p.customer_id === createCustomerId && p.status === 'active')
      .map((p: any) => ({ value: p.id, label: `${p.project_number || ''} - ${p.name}`.replace(/^ - /, '') }));
  }, [allProjects, createCustomerId]);

  // Save new ticket
  const handleCreateTicketSave = async () => {
    if (!user?.id) return;
    if (!createCustomerId) { alert('Please select a customer.'); return; }
    if (!createData.date) { alert('Please select a date.'); return; }

    setIsCreatingTicket(true);
    try {
      const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';

      // Get employee initials
      let employeeInitials: string | null = null;
      if (user.firstName && user.lastName) {
        employeeInitials = `${user.firstName[0]}${user.lastName[0]}`.toUpperCase();
      }

      // Create the ticket record
      const { data: newTicket, error: createError } = await supabase
        .from(tableName)
        .insert({
          date: createData.date,
          user_id: user.id,
          customer_id: createCustomerId,
          project_id: createProjectId || null,
          workflow_status: 'draft',
          employee_initials: employeeInitials,
          is_edited: true,
          header_overrides: {
            customer_name: createData.customerName,
            address: createData.address,
            city_state: createData.cityState,
            zip_code: createData.zipCode,
            phone: createData.phone,
            email: createData.email,
            contact_name: createData.contactName,
            service_location: createData.serviceLocation,
            location_code: createData.locationCode,
            po_number: createData.poNumber,
            approver: createData.approver ?? '',
            po_afe: createData.poAfe ?? '',
            cc: createData.cc ?? '',
            other: createData.other,
            tech_name: createData.techName,
            project_number: createData.projectNumber,
            date: createData.date,
          },
        })
        .select('id')
        .single();

      if (createError) throw createError;
      const ticketId = newTicket.id;

      // Save service rows as edited_descriptions & edited_hours
      const editedDescriptions: Record<string, string[]> = {};
      const editedHours: Record<string, number[]> = {};
      const rateTypes = [
        { key: 'st', label: 'Shop Time' },
        { key: 'tt', label: 'Travel Time' },
        { key: 'ft', label: 'Field Time' },
        { key: 'so', label: 'Shop Overtime' },
        { key: 'fo', label: 'Field Overtime' },
      ];

      for (const row of createServiceRows) {
        for (const rt of rateTypes) {
          const hours = row[rt.key as keyof ServiceRow] as number;
          if (hours > 0) {
            if (!editedDescriptions[rt.label]) {
              editedDescriptions[rt.label] = [];
              editedHours[rt.label] = [];
            }
            editedDescriptions[rt.label].push(row.description);
            (editedHours[rt.label] as number[]).push(hours);
          }
        }
      }

      await supabase
        .from(tableName)
        .update({ edited_descriptions: editedDescriptions, edited_hours: editedHours })
        .eq('id', ticketId);

      // Save expenses
      if (createExpenses.length > 0) {
        for (const exp of createExpenses) {
          await serviceTicketExpensesService.create({
            service_ticket_id: ticketId,
            expense_type: exp.expense_type,
            description: exp.description,
            quantity: exp.quantity,
            rate: exp.rate,
            unit: exp.unit || '',
          });
        }
      }

      await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
      await queryClient.invalidateQueries({ queryKey: ['billableEntries'] });
      setShowCreatePanel(false);
    } catch (err) {
      console.error('Error creating ticket:', err);
      alert('Failed to create service ticket. ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsCreatingTicket(false);
    }
  };

  return (
    <div>
      {/* Bulk delete permanently confirm modal - top level so it shows when no panel open */}
      {showBulkDeleteConfirm && selectedTicketIds.size > 0 && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10001,
            backgroundColor: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={() => setShowBulkDeleteConfirm(false)}
        >
          <div
            style={{
              backgroundColor: 'var(--bg-primary)',
              borderRadius: '8px',
              padding: '24px',
              maxWidth: '420px',
              width: '100%',
              boxShadow: '0 4px 24px rgba(0,0,0,0.2)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <p style={{ margin: '0 0 12px', color: 'var(--text-primary)', fontSize: '15px', fontWeight: '600' }}>
              Permanently delete {selectedTicketIds.size} ticket{selectedTicketIds.size > 1 ? 's' : ''}?
            </p>
            <p style={{ margin: '0 0 20px', color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.5 }}>
              This will remove the tickets and their time entries from the database. This cannot be undone.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                className="button button-secondary"
                onClick={() => setShowBulkDeleteConfirm(false)}
                style={{ padding: '8px 16px' }}
              >
                Cancel
              </button>
              <button
                className="button button-danger"
                onClick={() => handleBulkDeletePermanently()}
                style={{ padding: '8px 16px', backgroundColor: '#dc2626', borderColor: '#dc2626' }}
              >
                Delete Permanently
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>
          Service Tickets
        </h2>
        <button
          className="button button-primary"
          onClick={openCreatePanel}
          style={{ padding: '10px 20px', fontSize: '14px', fontWeight: '600' }}
        >
          + Create Service Ticket
        </button>
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: '16px', padding: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '16px', flexWrap: 'wrap' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', flex: 1, minWidth: 0 }}>
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
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', marginLeft: 'auto', marginBottom: '9px' }}>
            <button
              type="button"
              onClick={() => setShowDiscarded(!showDiscarded)}
              style={{
                padding: '8px 16px',
                fontSize: '13px',
                fontWeight: '600',
                color: showDiscarded ? 'white' : '#ef5350',
                backgroundColor: showDiscarded ? '#ef5350' : 'transparent',
                border: '1px solid #ef5350',
                borderRadius: '6px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              🗑️ Show Trash
            </button>
          </div>
        </div>
      </div>

      {/* Status Tabs */}
      <div
        ref={tabsContainerRef}
        style={{ position: 'relative', display: 'flex', gap: '4px', marginBottom: '24px', borderBottom: '1px solid var(--border-color)', paddingBottom: '0' }}
      >
        {[
          { id: 'draft', label: 'Drafts' },
          { id: 'submitted', label: 'Submitted' },
          { id: 'approved', label: 'Approved' },
          { id: 'all', label: 'All Tickets' }
        ].map(tab => (
          <button
            key={tab.id}
            ref={(el) => { tabRefsMap.current[tab.id] = el; }}
            onClick={() => {
              setActiveTab(tab.id as any);
              if (showDiscarded) setShowDiscarded(false);
            }}
            style={{
              padding: '10px 20px',
              border: 'none',
              backgroundColor: 'transparent',
              color: activeTab === tab.id ? 'var(--primary-color)' : 'var(--text-secondary)',
              fontWeight: activeTab === tab.id ? '600' : '500',
              cursor: 'pointer',
              borderBottom: '2px solid transparent',
              marginBottom: '-1px',
              transition: 'color 0.2s ease, font-weight 0.2s ease',
            }}
          >
            {tab.label}
          </button>
        ))}
        {tabIndicatorStyle && (
          <div
            style={{
              position: 'absolute',
              bottom: '-1px',
              left: tabIndicatorStyle.left,
              width: tabIndicatorStyle.width,
              height: '2px',
              backgroundColor: 'var(--primary-color)',
              transition: 'left 0.3s ease, width 0.3s ease',
            }}
          />
        )}
      </div>

      {/* Trashed banner */}
      {showDiscarded && (
        <div style={{
          padding: '10px 16px',
          marginBottom: '12px',
          backgroundColor: 'rgba(239, 83, 80, 0.08)',
          border: '1px solid rgba(239, 83, 80, 0.3)',
          borderRadius: '8px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <span style={{ fontSize: '13px', color: '#ef5350', fontWeight: '600' }}>
            Viewing trashed tickets
          </span>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            &mdash; These tickets are hidden from the default view. {isAdmin ? 'Open a ticket to Restore or Delete permanently. Select multiple to bulk restore or delete.' : 'Open a ticket and click Restore Ticket to move it back.'}
          </span>
        </div>
      )}

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
            {showDiscarded ? 'No trashed tickets found for the selected filters.' : 'No billable time entries found for the selected filters.'}
          </p>
        </div>
      ) : (
        <>
        {/* Bulk Action Bar - only visible to admins */}
        {isAdmin && selectedTicketIds.size > 0 && (
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
              {showDiscarded ? (
                <>
                  <button
                    onClick={() => setShowBulkDeleteConfirm(true)}
                    style={{
                      padding: '8px 16px',
                      backgroundColor: 'transparent',
                      color: '#fca5a5',
                      border: '1px solid #fca5a5',
                      borderRadius: '6px',
                      fontSize: '13px',
                      fontWeight: '500',
                      cursor: 'pointer',
                    }}
                  >
                    Delete Permanently
                  </button>
                  <button
                    onClick={handleBulkRestore}
                    style={{
                      padding: '8px 16px',
                      backgroundColor: '#10b981',
                      color: 'white',
                      border: 'none',
                      borderRadius: '6px',
                      fontSize: '13px',
                      fontWeight: '500',
                      cursor: 'pointer',
                    }}
                  >
                    Restore Selected
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={handleBulkUnassignTicketNumbers}
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
                    ✗ Unapprove Selected
                  </button>
                  {activeTab !== 'approved' && (
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
                    ✓ Approve Selected
                  </button>
                  )}
                  <button
                    onClick={handleBulkMoveToTrash}
                    disabled={isBulkExporting}
                    style={{
                      padding: '8px 16px',
                      backgroundColor: '#6b7280',
                      color: 'white',
                      border: 'none',
                      borderRadius: '6px',
                      fontSize: '13px',
                      fontWeight: '500',
                      cursor: isBulkExporting ? 'not-allowed' : 'pointer',
                      opacity: isBulkExporting ? 0.6 : 1,
                    }}
                  >
                    🗑️ Move to Trash
                  </button>
                </>
              )}
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
                {isAdmin && (
                  <th style={{ padding: '16px', textAlign: 'center', width: '50px' }}>
                    <input
                      type="checkbox"
                      checked={filteredTickets.length > 0 && selectedTicketIds.size === filteredTickets.length}
                      onChange={toggleSelectAll}
                      style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--primary-color)' }}
                      title="Select all"
                    />
                  </th>
                )}
                <th 
                  onClick={() => handleSort('ticketNumber')}
                  style={{ padding: '16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', cursor: 'pointer', userSelect: 'none' }}
                >
                  Ticket ID {effectiveSortField === 'ticketNumber' && (effectiveSortDirection === 'asc' ? '▲' : '▼')}
                </th>
                <th 
                  onClick={() => handleSort('date')}
                  style={{ padding: '16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', cursor: 'pointer', userSelect: 'none' }}
                >
                  Date {effectiveSortField === 'date' && (effectiveSortDirection === 'asc' ? '▲' : '▼')}
                </th>
                <th 
                  onClick={() => handleSort('customerName')}
                  style={{ padding: '16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', cursor: 'pointer', userSelect: 'none' }}
                >
                  Customer {effectiveSortField === 'customerName' && (effectiveSortDirection === 'asc' ? '▲' : '▼')}
                </th>
                <th 
                  onClick={() => handleSort('userName')}
                  style={{ padding: '16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', cursor: 'pointer', userSelect: 'none' }}
                >
                  Tech {effectiveSortField === 'userName' && (effectiveSortDirection === 'asc' ? '▲' : '▼')}
                </th>
                <th 
                  onClick={() => handleSort('totalHours')}
                  style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', cursor: 'pointer', userSelect: 'none' }}
                >
                  Total Hours {effectiveSortField === 'totalHours' && (effectiveSortDirection === 'asc' ? '▲' : '▼')}
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
                {/* Workflow column - only visible to admins in Approved tab, hidden in trash view */}
                {isAdmin && !showDiscarded && activeTab === 'approved' && (
                  <th style={{ padding: '16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                    Workflow
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {filteredTickets.map((ticket) => {
                const handleRowClick = async () => {
                  // Check if ticket is frozen (admin approved OR user submitted - must not overwrite with live customer)
                  const existingRecord = findMatchingTicketRecord(ticket);
                  const isAdminApproved = !!existingRecord?.ticket_number;
                  const ws = (existingRecord as { workflow_status?: string })?.workflow_status;
                  const isFrozen = isAdminApproved || (ws && !['draft', 'rejected'].includes(ws));
                  const isDiscarded = !!(existingRecord as any)?.is_discarded;
                  // Non-admins: lock when discarded, admin-approved, or user-submitted (workflow='approved' without ticket_number)
                  const isUserSubmitted = !isAdminApproved && ws === 'approved';
                  setIsLockedForEditing(isDiscarded || (isAdminApproved && !isAdmin) || (isUserSubmitted && !isAdmin));
                  
                  setSelectedTicket(ticket);
                  setPendingDeleteExpenseIds(new Set());
                  setPendingAddExpenses([]);
                  // Remove New badge once ticket is opened - persist so it stays gone across page visits
                  if (!existingRecord && ticket.entries?.length > 0) {
                    addOpenedNewTicketId(ticket.id);
                  }
                  const initialEditable = {
                    customerName: ticket.customerInfo.name || '',
                    address: ticket.customerInfo.address || '',
                    cityState: ticket.customerInfo.city && ticket.customerInfo.state 
                      ? `${ticket.customerInfo.city}, ${ticket.customerInfo.state}`
                      : ticket.customerInfo.city || ticket.customerInfo.state || '',
                    zipCode: ticket.customerInfo.zip_code || '',
                    phone: ticket.customerInfo.phone || '',
                    email: ticket.customerInfo.email || '',
                    contactName: ticket.customerInfo.contact_name || '',
                    serviceLocation: ticket.entryLocation || ticket.projectLocation || ticket.customerInfo.service_location || '',
                    locationCode: ticket.customerInfo.location_code || '',
                    poNumber: ticket.customerInfo.po_number || '',
                    ...((): { approver: string; poAfe: string; cc: string; other: string } => {
                      // Prioritize time entry values over project - NO PARSING, each field stays in its own field
                      const fromEntry = ticket.entryApprover || ticket.entryPoAfe || ticket.entryCc || ticket.entryOther;
                      if (fromEntry) {
                        return {
                          approver: ticket.entryApprover || '',
                          poAfe: ticket.entryPoAfe || ticket.customerInfo.po_number || '',
                          cc: ticket.entryCc || '',
                          other: ticket.entryOther ?? ticket.projectOther ?? '',
                        };
                      }
                      const fromProject = ticket.projectApprover || ticket.projectPoAfe || ticket.projectCc;
                      if (fromProject) {
                        return {
                          approver: ticket.projectApprover || '',
                          poAfe: ticket.projectPoAfe || ticket.customerInfo.po_number || '',
                          cc: ticket.projectCc || '',
                          other: ticket.projectOther || '',
                        };
                      }
                      return {
                        approver: '',
                        poAfe: ticket.customerInfo.po_number || '',
                        cc: '',
                        other: ticket.projectOther || '',
                      };
                    })(),
                    techName: ticket.userName || '',
                    projectNumber: ticket.projectNumber || '',
                    date: ticket.date || '',
                  };
                  // Apply header_overrides from existingRecord immediately to avoid flash of default before override
                  const ov = (existingRecord?.header_overrides as Record<string, string | number> | null) ?? {};
                  const useOverride = (ovVal: string | number | undefined, fallback: string) => {
                    const s = (ovVal != null ? String(ovVal).trim() : '');
                    return (s !== '' && s !== '_') ? s : fallback;
                  };
                  const isPlaceholder = (v: string) => !v || v === '_';
                  const ovApprover = ('approver' in ov) ? String(ov.approver ?? '').trim() : initialEditable.approver;
                  const ovPoAfe = ('po_afe' in ov) ? String(ov.po_afe ?? '').trim() : initialEditable.poAfe;
                  const ovCc = ('cc' in ov) ? String(ov.cc ?? '').trim() : initialEditable.cc;
                  const ovOther = ('other' in ov) ? String(ov.other ?? '').trim() : initialEditable.other;
                  const emptyIfUnderscore = (v: string) => (v === '_' ? '' : v);
                  const [finalApprover, finalPoAfe, finalCc, finalOther] = (isFrozen || Object.keys(ov).length > 0)
                    ? [
                        emptyIfUnderscore(isPlaceholder(ovApprover) && initialEditable.approver ? initialEditable.approver : ovApprover),
                        emptyIfUnderscore(isPlaceholder(ovPoAfe) && initialEditable.poAfe ? initialEditable.poAfe : ovPoAfe),
                        emptyIfUnderscore(isPlaceholder(ovCc) && initialEditable.cc ? initialEditable.cc : ovCc),
                        emptyIfUnderscore(isPlaceholder(ovOther) && initialEditable.other ? initialEditable.other : ovOther),
                      ]
                    : [
                        emptyIfUnderscore(initialEditable.approver),
                        emptyIfUnderscore(initialEditable.poAfe),
                        emptyIfUnderscore(initialEditable.cc),
                        emptyIfUnderscore(initialEditable.other),
                      ];
                  const initialToShow = (isFrozen || Object.keys(ov).length > 0)
                    ? {
                        ...initialEditable,
                        customerName: useOverride(ov.customer_name, initialEditable.customerName),
                        address: useOverride(ov.address, initialEditable.address),
                        cityState: useOverride(ov.city_state, initialEditable.cityState),
                        zipCode: useOverride(ov.zip_code, initialEditable.zipCode),
                        phone: useOverride(ov.phone, initialEditable.phone),
                        email: useOverride(ov.email, initialEditable.email),
                        contactName: useOverride(ov.contact_name, initialEditable.contactName),
                        serviceLocation: useOverride(ov.service_location, initialEditable.serviceLocation),
                        locationCode: useOverride(ov.location_code, initialEditable.locationCode),
                        poNumber: useOverride(ov.po_number, initialEditable.poNumber),
                        approver: finalApprover,
                        poAfe: finalPoAfe,
                        cc: finalCc,
                        other: finalOther,
                        techName: useOverride(ov.tech_name, initialEditable.techName),
                        projectNumber: useOverride(ov.project_number, initialEditable.projectNumber),
                        date: useOverride(ov.date, initialEditable.date),
                      }
                    : initialEditable;
                  setEditableTicket(initialToShow);
                  initialEditableTicketRef.current = { ...initialToShow };
                  
                  // Set display ticket number (will be XXX until exported)
                  setDisplayTicketNumber(ticket.displayTicketNumber);

                  // Show initial service rows immediately from entries (refined when edited data loads)
                  const initialRows = entriesToServiceRows(ticket.entries);
                  // Store the original time entry rows for per-entry edit comparison
                  originalTimeEntryRowsRef.current = initialRows.map(r => ({ ...r }));
                  setServiceRows(initialRows);
                  initialServiceRowsRef.current = initialRows.map(r => ({ ...r }));
                  setEditedEntryOverrides({});

                  // Load expenses and edited data for this ticket
                  try {
                    const hadNoRecord = !findMatchingTicketRecord(ticket);
                    const ticketRecordId = await getOrCreateTicketRecord(ticket);
                    setCurrentTicketRecordId(ticketRecordId);
                    // Don't refetch when opening a new ticket - it can cause the panel to auto-close.
                    // Mark as stale so data refreshes on next navigation or user action.
                    if (hadNoRecord) {
                      queryClient.invalidateQueries({
                        queryKey: ['existingServiceTickets', isDemoMode],
                        refetchType: 'none',
                      });
                    }
                    // Clear restored_at when user interacts (opens ticket) so green indicator goes away
                    const rec = findMatchingTicketRecord(ticket);
                    if ((rec as any)?.restored_at) {
                      const tbl = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
                      supabase.from(tbl).update({ restored_at: null }).eq('id', ticketRecordId).then(() => {
                        queryClient.invalidateQueries({
                          queryKey: ['existingServiceTickets', isDemoMode],
                          refetchType: 'none',
                        });
                      });
                    }
                    // Load expenses and ticket record in parallel for faster panel open
                    const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
                    const [_, ticketRecordResult] = await Promise.all([
                      loadExpenses(ticketRecordId),
                      (async () => {
                        const { data: dataWithOverrides, error: selectError } = await supabase
                          .from(tableName)
                          .select('is_edited, edited_descriptions, edited_hours, edited_entry_overrides, header_overrides, updated_at')
                          .eq('id', ticketRecordId)
                          .single();
                        if (selectError) {
                          const { data: dataWithout } = await supabase
                            .from(tableName)
                            .select('is_edited, edited_descriptions, edited_hours, updated_at')
                            .eq('id', ticketRecordId)
                            .single();
                          return dataWithout ? { ...dataWithout, header_overrides: null, edited_entry_overrides: null } : null;
                        }
                        return dataWithOverrides;
                      })(),
                    ]);
                    const ticketRecord = ticketRecordResult;
                    
                    // Use whichever was last saved: time entry or service ticket header_overrides
                    // Approved tickets: always use header_overrides (we never push to entries, so entries are stale)
                    const ov = (ticketRecord?.header_overrides as Record<string, string | number> | null) ?? {};
                    const hasApprovedTicketNumber = !!existingRecord?.ticket_number;
                    const entryMaxUpdated = ticket.entries?.length
                      ? Math.max(...ticket.entries.map((e) => e.updated_at ? new Date(e.updated_at).getTime() : 0))
                      : 0;
                    const ticketUpdated = ticketRecord?.updated_at ? new Date(ticketRecord.updated_at).getTime() : 0;
                    // Draft/rejected: use entry values when entries were updated more recently than the ticket record.
                    // When the user saves header overrides, ticket record is updated -> use header_overrides.
                    // Approved: always use header_overrides.
                    const useEntryValues = !hasApprovedTicketNumber && (entryMaxUpdated > ticketUpdated);
                    
                    const useOverride = (ovVal: string | number | undefined, fallback: string) => {
                      const s = (ovVal != null ? String(ovVal).trim() : '');
                      return (s !== '' && s !== '_') ? s : fallback;
                    };
                    let merged: typeof initialEditable;
                    if (isFrozen || Object.keys(ov).length > 0) {
                      // For approver/po_afe/cc/other: approved tickets always use header_overrides; draft/rejected use last-saved
                      // NO PARSING - each field stays in its own field
                      const ovApprover = ('approver' in ov) ? String(ov.approver ?? '').trim() : initialEditable.approver;
                      const ovPoAfe = ('po_afe' in ov) ? String(ov.po_afe ?? '').trim() : initialEditable.poAfe;
                      const ovCc = ('cc' in ov) ? String(ov.cc ?? '').trim() : initialEditable.cc;
                      const ovOther = ('other' in ov) ? String(ov.other ?? '').trim() : initialEditable.other;
                      // When header_overrides has placeholders (_ or empty) but entries have real values, prefer entries (fixes records created with billingKey-only data)
                      const isPlaceholder = (v: string) => !v || v === '_';
                      const emptyIfUnderscore = (v: string) => (v === '_' ? '' : v);
                      const [finalApprover, finalPoAfe, finalCc, finalOther] = useEntryValues
                        ? [
                            emptyIfUnderscore(initialEditable.approver),
                            emptyIfUnderscore(initialEditable.poAfe),
                            emptyIfUnderscore(initialEditable.cc),
                            emptyIfUnderscore(initialEditable.other),
                          ]
                        : [
                            emptyIfUnderscore(isPlaceholder(ovApprover) && initialEditable.approver ? initialEditable.approver : ovApprover),
                            emptyIfUnderscore(isPlaceholder(ovPoAfe) && initialEditable.poAfe ? initialEditable.poAfe : ovPoAfe),
                            emptyIfUnderscore(isPlaceholder(ovCc) && initialEditable.cc ? initialEditable.cc : ovCc),
                            emptyIfUnderscore(isPlaceholder(ovOther) && initialEditable.other ? initialEditable.other : ovOther),
                          ];
                      merged = {
                        customerName: useOverride(ov.customer_name, initialEditable.customerName),
                        address: useOverride(ov.address, initialEditable.address),
                        cityState: useOverride(ov.city_state, initialEditable.cityState),
                        zipCode: useOverride(ov.zip_code, initialEditable.zipCode),
                        phone: useOverride(ov.phone, initialEditable.phone),
                        email: useOverride(ov.email, initialEditable.email),
                        contactName: useOverride(ov.contact_name, initialEditable.contactName),
                        serviceLocation: useOverride(ov.service_location, initialEditable.serviceLocation),
                        locationCode: useOverride(ov.location_code, initialEditable.locationCode),
                        poNumber: useOverride(ov.po_number, initialEditable.poNumber),
                        approver: finalApprover,
                        poAfe: finalPoAfe,
                        cc: finalCc,
                        other: finalOther,
                        techName: useOverride(ov.tech_name, initialEditable.techName),
                        projectNumber: useOverride(ov.project_number, initialEditable.projectNumber),
                        date: useOverride(ov.date, initialEditable.date),
                      };
                    } else {
                      merged = initialEditable;
                    }
                    setEditableTicket(merged);
                    initialEditableTicketRef.current = { ...merged };

                    // Frozen tickets: apply frozen rates from header_overrides so amounts use snapshot, not live rates
                    if (isFrozen && ov && (typeof ov.rate_rt === 'number' || typeof ov.rate_tt === 'number' || typeof ov.rate_ft === 'number')) {
                      const displayTicket = applyHeaderOverridesToTicket(ticket, ov);
                      setSelectedTicket(displayTicket);
                    }
                    
                    // Per-entry overrides: merge live time entries with saved edits
                    const savedOverrides = (ticketRecord?.edited_entry_overrides as Record<string, EntryOverride> | null) ?? {};
                    const hasPerEntryOverrides = Object.keys(savedOverrides).length > 0;
                    
                    if (hasPerEntryOverrides) {
                      // Build rows from live entries + per-entry overrides
                      const mergedRows = buildRowsWithOverrides(ticket.entries, savedOverrides);
                      setServiceRows(mergedRows);
                      initialServiceRowsRef.current = mergedRows.map(r => ({ ...r }));
                      setEditedEntryOverrides(savedOverrides);
                      setIsTicketEdited(true);
                      // Update legacy format for backward compat
                      const legacy = serviceRowsToLegacyFormat(mergedRows);
                      setEditedDescriptions(legacy.descriptions);
                      setEditedHours(legacy.hours);
                    } else {
                      // Load rows from edited_descriptions/edited_hours if available
                      // This covers: (a) is_edited=true legacy tickets, (b) locked tickets with snapshot data
                      // (e.g. approved tickets from before per-entry tracking that have edited_hours but is_edited=false)
                      const loadedDescriptions = (ticketRecord?.edited_descriptions as Record<string, string[]>) || {};
                      const loadedHours = (ticketRecord?.edited_hours as Record<string, number | number[]>) || {};
                      const hasLegacyData = Object.keys(loadedDescriptions).length > 0 || Object.keys(loadedHours).length > 0;
                      
                      if (hasLegacyData) {
                        const rowMap = new Map<string, ServiceRow>();
                        let rowIndex = 0;
                        // Build rows from descriptions if available
                        if (Object.keys(loadedDescriptions).length > 0) {
                          Object.keys(loadedDescriptions).forEach(rateType => {
                            const descs = loadedDescriptions[rateType] || [];
                            const hrs = loadedHours[rateType];
                            const hoursArray = Array.isArray(hrs) ? hrs : (hrs !== undefined ? [hrs as number] : []);
                            descs.forEach((desc, i) => {
                              const hours = hoursArray[i] || 0;
                              const key = `${desc}-${rowIndex++}`;
                              const row: ServiceRow = {
                                id: key, description: desc,
                                st: rateType === 'Shop Time' ? hours : 0,
                                tt: rateType === 'Travel Time' ? hours : 0,
                                ft: rateType === 'Field Time' ? hours : 0,
                                so: rateType === 'Shop Overtime' ? hours : 0,
                                fo: rateType === 'Field Overtime' ? hours : 0,
                              };
                              rowMap.set(key, row);
                            });
                          });
                        } else {
                          // No descriptions but has hours - build rows from hours only
                          Object.keys(loadedHours).forEach(rateType => {
                            const hrs = loadedHours[rateType];
                            const hoursArray = Array.isArray(hrs) ? hrs : (hrs !== undefined ? [hrs as number] : []);
                            hoursArray.forEach((hours, i) => {
                              if (hours > 0) {
                                const key = `${rateType}-${rowIndex++}`;
                                const row: ServiceRow = {
                                  id: key, description: '',
                                  st: rateType === 'Shop Time' ? hours : 0,
                                  tt: rateType === 'Travel Time' ? hours : 0,
                                  ft: rateType === 'Field Time' ? hours : 0,
                                  so: rateType === 'Shop Overtime' ? hours : 0,
                                  fo: rateType === 'Field Overtime' ? hours : 0,
                                };
                                rowMap.set(key, row);
                              }
                            });
                          });
                        }
                        const loadedRows = Array.from(rowMap.values());
                        if (loadedRows.length > 0) {
                          setServiceRows(loadedRows);
                          initialServiceRowsRef.current = loadedRows.map(r => ({ ...r }));
                          setIsTicketEdited(!!ticketRecord?.is_edited);
                          setEditedDescriptions(loadedDescriptions);
                          setEditedHours(
                            Object.keys(loadedHours).reduce((acc, rateType) => {
                              const hrs = loadedHours[rateType];
                              acc[rateType] = Array.isArray(hrs) ? hrs : [hrs as number];
                              return acc;
                            }, {} as Record<string, number[]>)
                          );
                        } else {
                          // Legacy data exists but produced no rows - use entries
                          setIsTicketEdited(false);
                          const initialRows = entriesToServiceRows(ticket.entries);
                          setServiceRows(initialRows);
                          initialServiceRowsRef.current = initialRows.map(r => ({ ...r }));
                          setEditedDescriptions({});
                          setEditedHours({});
                          setEditedEntryOverrides({});
                        }
                      } else {
                        // No saved data at all - use live time entries
                        setIsTicketEdited(false);
                        const initialRows = entriesToServiceRows(ticket.entries);
                        setServiceRows(initialRows);
                        initialServiceRowsRef.current = initialRows.map(r => ({ ...r }));
                        setEditedDescriptions({});
                        setEditedHours({});
                        setEditedEntryOverrides({});
                      }
                    }
                  } catch (error) {
                    console.error('Error loading ticket data:', error);
                    setExpenses([]);
                    setIsTicketEdited(false);
                    const fallbackRows = entriesToServiceRows(ticket.entries);
                    setServiceRows(fallbackRows);
                    initialServiceRowsRef.current = fallbackRows.map(r => ({ ...r }));
                    setEditedDescriptions({});
                    setEditedHours({});
                    setEditedEntryOverrides({});
                  }
                };

                const rowExisting = findMatchingTicketRecord(ticket);
                const isRejected = !showDiscarded && rowExisting?.workflow_status === 'rejected';
                const isResubmitted = !showDiscarded && activeTab === 'submitted' && !!rowExisting?.rejected_at;
                const isRestored = !showDiscarded && !!(rowExisting as any)?.restored_at;
                const isNew = !showDiscarded && activeTab === 'draft' && !rowExisting && ticket.entries?.length > 0 && !openedNewTicketIds.has(ticket.id);
                const rowBg = selectedTicketIds.has(ticket.id)
                  ? 'rgba(37, 99, 235, 0.1)'
                  : showDiscarded ? 'rgba(239, 83, 80, 0.04)'
                  : isRejected ? 'rgba(239, 83, 80, 0.08)'
                  : isResubmitted ? 'rgba(234, 179, 8, 0.15)'
                  : isRestored ? 'rgba(16, 185, 129, 0.06)'
                  : isNew ? 'rgba(37, 99, 235, 0.06)'
                  : 'transparent';
                const rowHoverBg = selectedTicketIds.has(ticket.id)
                  ? 'rgba(37, 99, 235, 0.2)'
                  : isRejected ? 'rgba(239, 83, 80, 0.12)'
                  : isResubmitted ? 'rgba(234, 179, 8, 0.22)'
                  : isRestored ? 'rgba(16, 185, 129, 0.1)'
                  : isNew ? 'rgba(37, 99, 235, 0.1)'
                  : 'var(--hover-bg)';
                return (
                <tr
                  key={ticket.id}
                  style={{
                    borderBottom: '1px solid var(--border-color)',
                    borderLeft: isRejected ? '4px solid #ef5350' : (isResubmitted ? '4px solid #eab308' : (isRestored ? '4px solid #10b981' : (isNew ? '4px solid #2563eb' : undefined))),
                    transition: 'background-color 0.2s',
                    cursor: 'pointer',
                    backgroundColor: rowBg,
                    opacity: showDiscarded ? 0.75 : 1,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = rowHoverBg;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = rowBg;
                  }}
                  onClick={handleRowClick}
                >
                  {isAdmin && (
                    <td style={{ padding: '16px', textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedTicketIds.has(ticket.id)}
                        onChange={() => toggleTicketSelection(ticket.id)}
                        style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--primary-color)' }}
                      />
                    </td>
                  )}
                  <td style={{ padding: '16px', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: '13px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {ticket.displayTicketNumber}
                      {isRejected && (
                        <span style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          fontSize: '10px',
                          fontWeight: '700',
                          fontFamily: 'system-ui, sans-serif',
                          color: '#ef5350',
                          backgroundColor: 'rgba(239, 83, 80, 0.15)',
                          border: '1px solid rgba(239, 83, 80, 0.4)',
                          borderRadius: '4px',
                          textTransform: 'uppercase',
                          letterSpacing: '0.5px',
                        }} title="Rejected – needs attention">Rejected</span>
                      )}
                      {showDiscarded && (
                        <span style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          fontSize: '10px',
                          fontWeight: '700',
                          fontFamily: 'system-ui, sans-serif',
                          color: '#ef5350',
                          backgroundColor: 'rgba(239, 83, 80, 0.12)',
                          border: '1px solid rgba(239, 83, 80, 0.3)',
                          borderRadius: '4px',
                          textTransform: 'uppercase',
                          letterSpacing: '0.5px',
                        }}>🗑️ Trashed</span>
                      )}
                      {isResubmitted && (
                        <span style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          fontSize: '10px',
                          fontWeight: '700',
                          fontFamily: 'system-ui, sans-serif',
                          color: '#b45309',
                          backgroundColor: 'rgba(234, 179, 8, 0.2)',
                          border: '1px solid rgba(234, 179, 8, 0.5)',
                          borderRadius: '4px',
                          textTransform: 'uppercase',
                          letterSpacing: '0.5px',
                        }} title="Resubmitted after rejection">Resubmitted</span>
                      )}
                      {isRestored && (
                        <span style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          fontSize: '10px',
                          fontWeight: '700',
                          fontFamily: 'system-ui, sans-serif',
                          color: '#10b981',
                          backgroundColor: 'rgba(16, 185, 129, 0.15)',
                          border: '1px solid rgba(16, 185, 129, 0.4)',
                          borderRadius: '4px',
                          textTransform: 'uppercase',
                          letterSpacing: '0.5px',
                        }} title="Recently restored from trash – opens when clicked">Restored</span>
                      )}
                      {isNew && (
                        <span style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          fontSize: '10px',
                          fontWeight: '700',
                          fontFamily: 'system-ui, sans-serif',
                          color: '#2563eb',
                          backgroundColor: 'rgba(37, 99, 235, 0.15)',
                          border: '1px solid rgba(37, 99, 235, 0.4)',
                          borderRadius: '4px',
                          textTransform: 'uppercase',
                          letterSpacing: '0.5px',
                        }} title="New ticket from time entries – not yet opened">New</span>
                      )}
                    </div>
                  </td>
                  <td style={{ padding: '16px', color: 'var(--text-primary)' }}>
                    {formatDateOnlyLocal(ticket.date)}
                  </td>
                  <td style={{ padding: '16px', color: 'var(--text-primary)', fontWeight: '500' }}>
                    {ticket.customerName}
                  </td>
                  <td style={{ padding: '16px', color: 'var(--text-primary)' }}>
                    {ticket.userName}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-primary)', fontWeight: '600' }}>
                    {(() => {
                      // When this ticket is selected, show live total from service rows
                      if (selectedTicketId === ticket.id && liveHoursForSelectedTicket) {
                        return liveHoursForSelectedTicket.total.toFixed(2);
                      }
                      return ticket.totalHours.toFixed(2);
                    })()}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {(() => {
                      if (selectedTicketId === ticket.id && liveHoursForSelectedTicket) {
                        return liveHoursForSelectedTicket.st.toFixed(2);
                      }
                      return ticket.hoursByRateType['Shop Time'].toFixed(2);
                    })()}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {(() => {
                      if (selectedTicketId === ticket.id && liveHoursForSelectedTicket) {
                        return liveHoursForSelectedTicket.tt.toFixed(2);
                      }
                      return ticket.hoursByRateType['Travel Time'].toFixed(2);
                    })()}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {(() => {
                      if (selectedTicketId === ticket.id && liveHoursForSelectedTicket) {
                        return liveHoursForSelectedTicket.ft.toFixed(2);
                      }
                      return ticket.hoursByRateType['Field Time'].toFixed(2);
                    })()}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {(() => {
                      if (selectedTicketId === ticket.id && liveHoursForSelectedTicket) {
                        return liveHoursForSelectedTicket.so.toFixed(2);
                      }
                      return ticket.hoursByRateType['Shop Overtime'].toFixed(2);
                    })()}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {(() => {
                      if (selectedTicketId === ticket.id && liveHoursForSelectedTicket) {
                        return liveHoursForSelectedTicket.fo.toFixed(2);
                      }
                      return ticket.hoursByRateType['Field Overtime'].toFixed(2);
                    })()}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                    {showDiscarded ? (
                      <button
                        className="button"
                        onClick={async (e) => {
                          e.stopPropagation();
                          const record = findMatchingTicketRecord(ticket);
                          if (!record?.id) return;
                          try {
                            const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
                            await supabase.from(tableName).update({
            is_discarded: false,
            restored_at: new Date().toISOString(),
            workflow_status: 'draft',
            rejected_at: null,
            rejection_notes: null,
            approved_by_admin_id: null,
            ticket_number: null,
            sequence_number: null,
            year: null,
          }).eq('id', record.id);
                            await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets', isDemoMode] });
                            await queryClient.refetchQueries({ queryKey: ['existingServiceTickets', isDemoMode] });
                            queryClient.invalidateQueries({ queryKey: ['rejectedTicketsCount'] });
                            queryClient.invalidateQueries({ queryKey: ['resubmittedTicketsCount'] });
                          } catch (err) {
                            console.error('Error restoring ticket:', err);
                            alert('Failed to restore ticket.');
                          }
                        }}
                        style={{
                          padding: '6px 16px',
                          fontSize: '13px',
                          backgroundColor: '#10b981',
                          color: 'white',
                          border: 'none',
                          cursor: 'pointer',
                        }}
                      >
                        Restore
                      </button>
                    ) : (() => {
                      const existing = findMatchingTicketRecord(ticket);
                      
                      // Check both ticket_number and workflow_status for approval
                      const hasTicketNumber = !!existing?.ticket_number;
                      // Consider any status other than 'draft' (and 'rejected') as user-approved/submitted
                      const workflowStatus = existing?.workflow_status || 'draft';
                      const isWorkflowApproved = workflowStatus !== 'draft' && workflowStatus !== 'rejected';
                      const isApproved = hasTicketNumber || isWorkflowApproved;
                      
                      if (isAdmin) {
                        // Admin flow: assign/unassign ticket numbers
                        // Show different states: fully approved (has ticket#) vs user-approved (workflow only)
                        if (hasTicketNumber) {
                          return (
                            <button
                              className="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleUnassignTicketNumber(ticket);
                              }}
                              style={{
                                padding: '6px 16px',
                                fontSize: '13px',
                                backgroundColor: '#10b981',
                                color: 'white',
                                border: 'none',
                                cursor: 'pointer',
                              }}
                              title="Click to unapprove"
                            >
                              ✓ Approved
                            </button>
                          );
                        } else if (isWorkflowApproved) {
                          // User has approved but no ticket number assigned yet
                          return (
                            <button
                              className="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleAssignTicketNumber(ticket);
                              }}
                              style={{
                                padding: '6px 16px',
                                fontSize: '13px',
                                backgroundColor: '#3b82f6',
                                color: 'white',
                                border: 'none',
                                cursor: 'pointer',
                              }}
                              title="User approved - click to assign ticket number"
                            >
                              ✓ User Approved
                            </button>
                          );
                        } else {
                          return (
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
                        }
                      } else {
                        // Non-admin flow
                        // If admin has approved (has ticket number), show locked approved state
                        if (hasTicketNumber) {
                          return (
                            <button
                              className="button"
                              disabled
                              style={{
                                padding: '6px 16px',
                                fontSize: '13px',
                                backgroundColor: '#10b981',
                                color: 'white',
                                border: 'none',
                                cursor: 'not-allowed',
                                opacity: 0.9,
                              }}
                              title="Approved by admin"
                            >
                              ✓ Approved
                            </button>
                          );
                        }
                        // User can toggle workflow_status
                        return (
                          <button
                            className="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                const billingKey = ticket.id ? getTicketBillingKeyLocal(ticket.id) : '_::_::_';
                                const ticketRecord = await serviceTicketsService.getOrCreateTicket({
                                  date: ticket.date,
                                  userId: ticket.userId,
                                  customerId: ticket.customerId === 'unassigned' ? null : ticket.customerId,
                                  projectId: ticket.projectId,
                                  location: ticket.location || '',
                                  billingKey,
                                }, isDemoMode);
                                const newStatus = isApproved ? 'draft' : 'approved';
                                // When submitting (not withdrawing), snapshot hours/descriptions/header to DB
                                // Don't set is_edited=true just for submitting - only actual per-entry edits count
                                if (newStatus !== 'draft' && ticket.entries?.length > 0) {
                                  const rows = entriesToServiceRows(ticket.entries);
                                  const legacy = serviceRowsToLegacyFormat(rows);
                                  let totalEditedHours = 0;
                                  rows.forEach(row => { totalEditedHours += row.st + row.tt + row.ft + row.so + row.fo; });
                                  const headerOverrides = buildApprovalHeaderOverrides(ticket);
                                  const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
                                  await supabase.from(tableName).update({
                                    edited_descriptions: legacy.descriptions,
                                    edited_hours: legacy.hours,
                                    total_hours: totalEditedHours,
                                    header_overrides: headerOverrides,
                                  }).eq('id', ticketRecord.id);
                                }
                                await serviceTicketsService.updateWorkflowStatus(ticketRecord.id, newStatus, isDemoMode);
                                queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
                              } catch (error) {
                                console.error('Error updating ticket status:', error);
                              }
                            }}
                            style={{
                              padding: '6px 16px',
                              fontSize: '13px',
                              backgroundColor: isApproved ? '#3b82f6' : undefined,
                              color: isApproved ? 'white' : undefined,
                              border: 'none',
                              cursor: 'pointer',
                            }}
                            title={isApproved ? "Click to withdraw submission" : "Click to submit for approval"}
                          >
                            {isApproved ? 'Withdraw' : 'Submit'}
                          </button>
                        );
                      }
                    })()}
                  </td>
                  {/* Workflow status cell - only visible to admins in Approved tab, hidden in trash view. Only show "Approved" when ticket has an assigned ID. */}
                  {isAdmin && !showDiscarded && activeTab === 'approved' && (
                    <td style={{ padding: '16px', textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                      {(() => {
                        const existing = findMatchingTicketRecord(ticket);
                        const hasTicketNumber = !!existing?.ticket_number;
                        const workflowStatus = (existing?.workflow_status || 'draft') as WorkflowStatus;
                        const statusInfo = WORKFLOW_STATUSES[workflowStatus] || WORKFLOW_STATUSES.draft;
                        const effectiveLabel = (workflowStatus === 'approved' && !hasTicketNumber)
                          ? 'Pending'
                          : statusInfo.label;
                        const effectiveColor = (workflowStatus === 'approved' && !hasTicketNumber)
                          ? '#6b7280'
                          : statusInfo.color;
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
                              backgroundColor: `${effectiveColor}20`,
                              color: effectiveColor,
                              whiteSpace: 'nowrap',
                            }}
                            title={hasTicketNumber ? `Status: ${statusInfo.label}` : 'No ticket ID assigned yet'}
                          >
                            {effectiveLabel === 'Pending' ? '⏳' : statusInfo.icon} {effectiveLabel}
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
          ref={ticketPanelBackdropRef}
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
          onMouseDown={(e) => {
            ticketPanelMouseDownOnBackdropRef.current = e.target === ticketPanelBackdropRef.current;
          }}
          onMouseUp={(e) => {
            if (ticketPanelMouseDownOnBackdropRef.current && e.target === ticketPanelBackdropRef.current) {
              if (hasPendingChanges) setShowCloseConfirm(true);
              else closePanel();
            }
            ticketPanelMouseDownOnBackdropRef.current = false;
          }}
        >
          <div
            style={{
              backgroundColor: 'var(--bg-primary)',
              borderRadius: '12px',
              maxWidth: '900px',
              width: '100%',
              height: '90vh',
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
                  if (hasPendingChanges) setShowCloseConfirm(true);
                  else closePanel();
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

            <div
              style={{ padding: '24px', position: 'relative' }}
              onClick={isLockedForEditing ? showLockedReason : undefined}
              role={isLockedForEditing ? 'button' : undefined}
              aria-label={isLockedForEditing ? 'Ticket is locked; click to see why' : undefined}
            >
              {/* Rejection note at top when user opens a rejected ticket in Drafts */}
              {selectedTicket && (() => {
                const rec = findMatchingTicketRecord(selectedTicket);
                const isRejected = rec?.workflow_status === 'rejected';
                const notes = (rec as { rejection_notes?: string | null })?.rejection_notes;
                if (!isRejected || !(notes && String(notes).trim())) return null;
                return (
                  <div
                    style={{
                      backgroundColor: 'rgba(239, 83, 80, 0.15)',
                      border: '1px solid #ef5350',
                      borderRadius: '8px',
                      padding: '12px 16px',
                      marginBottom: '16px',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '10px',
                    }}
                  >
                    <span style={{ fontSize: '18px' }}>⚠️</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: '700', color: '#ef5350', marginBottom: '4px' }}>Rejection reason</div>
                      <div style={{ fontSize: '14px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>
                        {String(notes).trim()}
                      </div>
                    </div>
                  </div>
                );
              })()}
              {/* Admin editing approved ticket - info banner (edits don't affect time entries) */}
              {isAdmin && !isLockedForEditing && selectedTicket && (() => {
                const rec = findMatchingTicketRecord(selectedTicket);
                const hasTicketNumber = !!rec?.ticket_number;
                const isDiscarded = !!(rec as any)?.is_discarded;
                if (!hasTicketNumber || isDiscarded) return null;
                return (
                  <div style={{
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    border: '1px solid #3b82f6',
                    borderRadius: '8px',
                    padding: '12px 16px',
                    marginBottom: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                  }}>
                    <span style={{ fontSize: '18px' }}>✏️</span>
                    <div>
                      <div style={{ fontWeight: '600', color: '#3b82f6' }}>Admin edit</div>
                      <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                        You can edit this approved ticket. Changes are saved to this ticket only. Time entries are not updated.
                      </div>
                    </div>
                  </div>
                );
              })()}
              {/* Locked banner - when ticket is admin-approved or trashed (non-admin) */}
              {isLockedForEditing && selectedTicket && (() => {
                const lockRec = findMatchingTicketRecord(selectedTicket);
                const isTrashed = !!(lockRec as any)?.is_discarded;
                const isSubmittedLock = !isTrashed && lockRec?.workflow_status === 'approved' && !lockRec?.ticket_number;
                const lockColor = isTrashed ? '#ef5350' : isSubmittedLock ? '#3b82f6' : '#10b981';
                const lockBg = isTrashed ? 'rgba(239, 83, 80, 0.08)' : isSubmittedLock ? 'rgba(59, 130, 246, 0.1)' : 'rgba(16, 185, 129, 0.1)';
                return (
                  <div style={{
                    backgroundColor: lockBg,
                    border: `1px solid ${lockColor}`,
                    borderRadius: '8px',
                    padding: '12px 16px',
                    marginBottom: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                  }}>
                    <span style={{ fontSize: '18px' }}>🔒</span>
                    <div>
                      <div style={{ fontWeight: '600', color: lockColor }}>
                        {isTrashed ? 'Ticket in Trash' : isSubmittedLock ? 'Ticket Submitted' : 'Ticket Approved'}
                      </div>
                      <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                        {isTrashed
                          ? 'This ticket is in trash and view-only. Click Restore Ticket to make changes.'
                          : isSubmittedLock
                            ? 'This ticket has been submitted for approval. Withdraw the submission to make changes.'
                            : 'This ticket has been approved by an admin and can no longer be edited.'}
                      </div>
                    </div>
                  </div>
                );
              })()}
              {/* Toast when user tries to edit while locked */}
              {showLockNotification && (
                <div
                  style={{
                    position: 'fixed',
                    bottom: '24px',
                    left: '50%',
                    transform: lockNotificationExiting
                      ? 'translateX(-50%) translateY(-24px)'
                      : lockNotificationEntered
                        ? 'translateX(-50%) translateY(0)'
                        : 'translateX(-50%) translateY(24px)',
                    opacity: lockNotificationExiting ? 0 : lockNotificationEntered ? 1 : 0,
                    transition: 'opacity 0.3s ease, transform 0.3s ease',
                    zIndex: 10000,
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                    padding: '14px 20px',
                    maxWidth: '90vw',
                    width: '360px',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '12px',
                  }}
                  role="alert"
                >
                  <span style={{ fontSize: '20px', flexShrink: 0 }}>🔒</span>
                  <div>
                    <div style={{ fontWeight: '600', marginBottom: '4px', color: 'var(--text-primary)' }}>
                      Cannot edit this ticket
                    </div>
                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                      {(() => {
                        const notifRec = selectedTicket ? findMatchingTicketRecord(selectedTicket) : null;
                        const isTrashedNotif = !!(notifRec as any)?.is_discarded;
                        const isSubmittedNotif = !isTrashedNotif && notifRec?.workflow_status === 'approved' && !notifRec?.ticket_number;
                        if (isTrashedNotif) return 'This ticket is in trash. Click Restore Ticket to make changes.';
                        if (isSubmittedNotif) return 'This ticket has been submitted for approval and is locked. Withdraw the submission to make changes.';
                        return 'This ticket has been approved by an admin and is locked. Contact an administrator if you need to make changes.';
                      })()}
                    </div>
                  </div>
                </div>
              )}
              
              {/* Editable input style */}
              {(() => {
                const inputStyle: React.CSSProperties = {
                  width: '100%',
                  padding: '8px 12px',
                  backgroundColor: isLockedForEditing ? 'var(--bg-secondary)' : 'var(--bg-tertiary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px',
                  color: isLockedForEditing ? 'var(--text-secondary)' : 'var(--text-primary)',
                  fontSize: '14px',
                  outline: 'none',
                  cursor: isLockedForEditing ? 'not-allowed' : 'text',
                  opacity: isLockedForEditing ? 0.7 : 1,
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
                const pendingChangeHighlight: React.CSSProperties = {
                  backgroundColor: 'rgba(255, 193, 7, 0.22)',
                  borderColor: 'rgba(255, 152, 0, 0.75)',
                  boxShadow: 'inset 0 0 0 1px rgba(255, 152, 0, 0.35)',
                };
                const isHeaderFieldDirty = (field: keyof EditableTicketSnapshot): boolean => {
                  if (!editableTicket || !initialEditableTicketRef.current) return false;
                  return normStr(editableTicket[field]) !== normStr(initialEditableTicketRef.current[field]);
                };
                const isServiceRowDirty = (i: number): boolean => {
                  const init = initialServiceRowsRef.current;
                  if (!init || i >= serviceRows.length) return false;
                  if (i >= init.length) return true;
                  const cur = serviceRows[i];
                  const inital = init[i];
                  if (!inital) return true;
                  return normStr(cur.description) !== normStr(inital.description)
                  || !hoursEq(cur.st, inital.st) || !hoursEq(cur.tt, inital.tt) || !hoursEq(cur.ft, inital.ft)
                  || !hoursEq(cur.so, inital.so) || !hoursEq(cur.fo, inital.fo);
                };

                return (
                  <>
                    {/* No auto-save notice */}
                    <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                      Changes here are not saved automatically. Click Save Changes at the bottom to save your edits.
                    </p>
                    {/* Customer & Service Info Section */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
                      {/* Customer Info */}
                      <div style={sectionStyle}>
                        <h3 style={sectionTitleStyle}>Customer Information</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                          <div>
                            <label style={labelStyle}>Customer Name</label>
                            <input
                              style={{ ...inputStyle, ...(isHeaderFieldDirty('customerName') ? pendingChangeHighlight : {}) }}
                              value={editableTicket.customerName}
                              onChange={(e) => !isLockedForEditing && setEditableTicket({ ...editableTicket, customerName: e.target.value })}
                              readOnly={isLockedForEditing}
                            />
                          </div>
                          <div>
                            <label style={labelStyle}>Address</label>
                            <input
                              style={{ ...inputStyle, ...(isHeaderFieldDirty('address') ? pendingChangeHighlight : {}) }}
                              value={editableTicket.address}
                              onChange={(e) => !isLockedForEditing && setEditableTicket({ ...editableTicket, address: e.target.value })}
                              readOnly={isLockedForEditing}
                            />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={labelStyle}>City, Province</label>
                              <input
                                style={{ ...inputStyle, ...(isHeaderFieldDirty('cityState') ? pendingChangeHighlight : {}) }}
                                value={editableTicket.cityState}
                                onChange={(e) => !isLockedForEditing && setEditableTicket({ ...editableTicket, cityState: e.target.value })}
                                readOnly={isLockedForEditing}
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>Postal Code</label>
                              <input
                                style={{ ...inputStyle, ...(isHeaderFieldDirty('zipCode') ? pendingChangeHighlight : {}) }}
                                value={editableTicket.zipCode}
                                onChange={(e) => !isLockedForEditing && setEditableTicket({ ...editableTicket, zipCode: e.target.value })}
                                readOnly={isLockedForEditing}
                              />
                            </div>
                          </div>
                          <div>
                            <label style={labelStyle}>Contact Name</label>
                            <input
                              style={{ ...inputStyle, ...(isHeaderFieldDirty('contactName') ? pendingChangeHighlight : {}) }}
                              value={editableTicket.contactName}
                              onChange={(e) => !isLockedForEditing && setEditableTicket({ ...editableTicket, contactName: e.target.value })}
                              readOnly={isLockedForEditing}
                            />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={labelStyle}>Phone</label>
                              <input
                                style={{ ...inputStyle, ...(isHeaderFieldDirty('phone') ? pendingChangeHighlight : {}) }}
                                value={editableTicket.phone}
                                onChange={(e) => !isLockedForEditing && setEditableTicket({ ...editableTicket, phone: e.target.value })}
                                readOnly={isLockedForEditing}
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>Email</label>
                              <input
                                style={{ ...inputStyle, ...(isHeaderFieldDirty('email') ? pendingChangeHighlight : {}) }}
                                value={editableTicket.email}
                                onChange={(e) => !isLockedForEditing && setEditableTicket({ ...editableTicket, email: e.target.value })}
                                readOnly={isLockedForEditing}
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
                              style={{ ...inputStyle, ...(isHeaderFieldDirty('techName') ? pendingChangeHighlight : {}) }}
                              value={editableTicket.techName}
                              onChange={(e) => !isLockedForEditing && setEditableTicket({ ...editableTicket, techName: e.target.value })}
                              readOnly={isLockedForEditing}
                            />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={labelStyle}>Project Number</label>
                              <input
                                style={{ ...inputStyle, ...(isHeaderFieldDirty('projectNumber') ? pendingChangeHighlight : {}) }}
                                value={editableTicket.projectNumber}
                                onChange={(e) => !isLockedForEditing && setEditableTicket({ ...editableTicket, projectNumber: e.target.value })}
                                readOnly={isLockedForEditing}
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>Date</label>
                              <input
                                type="date"
                                style={{ ...inputStyle, ...(isHeaderFieldDirty('date') ? pendingChangeHighlight : {}) }}
                                value={editableTicket.date}
                                onChange={(e) => !isLockedForEditing && setEditableTicket({ ...editableTicket, date: e.target.value })}
                                readOnly={isLockedForEditing}
                              />
                            </div>
                          </div>
                          <div>
                            <label style={labelStyle}>Service Location</label>
                            <input
                              style={{ ...inputStyle, ...(isHeaderFieldDirty('serviceLocation') ? pendingChangeHighlight : {}) }}
                              value={editableTicket.serviceLocation}
                              onChange={(e) => !isLockedForEditing && setEditableTicket({ ...editableTicket, serviceLocation: e.target.value })}
                              readOnly={isLockedForEditing}
                            />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '8px' }}>
                            <div>
                              <label style={labelStyle}>PO/AFE/CC (Cost Center)</label>
                              <input
                                style={{ ...inputStyle, ...(isHeaderFieldDirty('poAfe') ? pendingChangeHighlight : {}) }}
                                value={editableTicket.poAfe}
                                onChange={(e) => !isLockedForEditing && setEditableTicket({ ...editableTicket, poAfe: e.target.value })}
                                readOnly={isLockedForEditing}
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>Approver</label>
                              <input
                                style={{ ...inputStyle, ...(isHeaderFieldDirty('approver') ? pendingChangeHighlight : {}) }}
                                value={editableTicket.approver}
                                onChange={(e) => !isLockedForEditing && setEditableTicket({ ...editableTicket, approver: e.target.value })}
                                readOnly={isLockedForEditing}
                              />
                            </div>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={labelStyle}>Coding</label>
                              <input
                                style={{ ...inputStyle, ...(isHeaderFieldDirty('cc') ? pendingChangeHighlight : {}) }}
                                value={editableTicket.cc}
                                onChange={(e) => !isLockedForEditing && setEditableTicket({ ...editableTicket, cc: e.target.value })}
                                readOnly={isLockedForEditing}
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>Other</label>
                              <input
                                style={{ ...inputStyle, ...(isHeaderFieldDirty('other') ? pendingChangeHighlight : {}) }}
                                value={editableTicket.other}
                                onChange={(e) => !isLockedForEditing && setEditableTicket({ ...editableTicket, other: e.target.value })}
                                readOnly={isLockedForEditing}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Service Description Section - Row-based with 5 hour columns */}
                    <div style={sectionStyle}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                        <h3 style={sectionTitleStyle}>Service Description</h3>
                        {!isLockedForEditing && (
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
                              updateServiceRows(newRows);
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
                            + Add Row
                          </button>
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
                        {serviceRows.map((row, index) => {
                          const isEntryOverridden = !!editedEntryOverrides[row.id];
                          const isManualRow = row.id.startsWith('new-');
                          return (
                          <div 
                            key={row.id} 
                            style={{ 
                              display: 'grid', 
                              gridTemplateColumns: '1fr 55px 55px 55px 55px 55px 40px',
                              gap: '8px',
                              alignItems: 'center',
                              padding: '8px',
                              backgroundColor: isServiceRowDirty(index) ? 'rgba(255, 193, 7, 0.22)' : isEntryOverridden ? 'rgba(255, 152, 0, 0.06)' : 'var(--bg-tertiary)',
                              border: isServiceRowDirty(index) ? '1px solid rgba(255, 152, 0, 0.75)' : isEntryOverridden ? '1px solid rgba(255, 152, 0, 0.25)' : '1px solid transparent',
                              borderRadius: '6px',
                              position: 'relative',
                            }}
                          >
                            <textarea
                              value={row.description}
                              onChange={(e) => {
                                if (isLockedForEditing) { showLockedReason(); return; }
                                const newRows = [...serviceRows];
                                newRows[index] = { ...row, description: e.target.value };
                                updateServiceRows(newRows);
                              }}
                              readOnly={isLockedForEditing}
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
                                if (isLockedForEditing) { showLockedReason(); return; }
                                const newRows = [...serviceRows];
                                newRows[index] = { ...row, st: parseFloat(e.target.value) || 0 };
                                updateServiceRows(newRows);
                              }}
                              readOnly={isLockedForEditing}
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
                                if (isLockedForEditing) { showLockedReason(); return; }
                                const newRows = [...serviceRows];
                                newRows[index] = { ...row, tt: parseFloat(e.target.value) || 0 };
                                updateServiceRows(newRows);
                              }}
                              readOnly={isLockedForEditing}
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
                                if (isLockedForEditing) { showLockedReason(); return; }
                                const newRows = [...serviceRows];
                                newRows[index] = { ...row, ft: parseFloat(e.target.value) || 0 };
                                updateServiceRows(newRows);
                              }}
                              readOnly={isLockedForEditing}
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
                                if (isLockedForEditing) { showLockedReason(); return; }
                                const newRows = [...serviceRows];
                                newRows[index] = { ...row, so: parseFloat(e.target.value) || 0 };
                                updateServiceRows(newRows);
                              }}
                              readOnly={isLockedForEditing}
                              style={{
                                ...inputStyle,
                                padding: '6px 4px',
                                textAlign: 'center',
                                fontSize: '13px',
                                backgroundColor: isLockedForEditing ? 'var(--bg-secondary)' : 'rgba(255, 152, 0, 0.1)',
                              }}
                              title="Shop Overtime"
                            />
                            <input
                              type="number"
                              step="0.5"
                              min="0"
                              value={row.fo || ''}
                              onChange={(e) => {
                                if (isLockedForEditing) { showLockedReason(); return; }
                                const newRows = [...serviceRows];
                                newRows[index] = { ...row, fo: parseFloat(e.target.value) || 0 };
                                updateServiceRows(newRows);
                              }}
                              readOnly={isLockedForEditing}
                              style={{
                                ...inputStyle,
                                padding: '6px 4px',
                                textAlign: 'center',
                                fontSize: '13px',
                                backgroundColor: isLockedForEditing ? 'var(--bg-secondary)' : 'rgba(255, 152, 0, 0.1)',
                              }}
                              title="Field Overtime"
                            />
                            {!isLockedForEditing && (
                            <button
                              onClick={() => {
                                const newRows = serviceRows.filter((_, i) => i !== index);
                                updateServiceRows(newRows);
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
                            )}
                          </div>
                          );
                        })}
                        
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
                            {serviceRows.reduce((sum, r) => sum + (r.st || 0), 0).toFixed(2)}
                          </span>
                          <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)', textAlign: 'center' }}>
                            {serviceRows.reduce((sum, r) => sum + (r.tt || 0), 0).toFixed(2)}
                          </span>
                          <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)', textAlign: 'center' }}>
                            {serviceRows.reduce((sum, r) => sum + (r.ft || 0), 0).toFixed(2)}
                          </span>
                          <span style={{ fontSize: '13px', fontWeight: '700', color: '#ff9800', textAlign: 'center' }}>
                            {serviceRows.reduce((sum, r) => sum + (r.so || 0), 0).toFixed(2)}
                          </span>
                          <span style={{ fontSize: '13px', fontWeight: '700', color: '#ff9800', textAlign: 'center' }}>
                            {serviceRows.reduce((sum, r) => sum + (r.fo || 0), 0).toFixed(2)}
                          </span>
                          <span style={{ fontSize: '14px', fontWeight: '700', color: 'var(--primary-color)', textAlign: 'center' }}>
                            {serviceRows.reduce((sum, r) => 
                              sum + (r.st || 0) + (r.tt || 0) + (r.ft || 0) + (r.so || 0) + (r.fo || 0), 0).toFixed(2)}
                          </span>
                        </div>
                        
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
                        
                        {/* EDITED notice - below legend. Only show when entries actually differ from time entries */}
                        {isTicketEdited && Object.keys(editedEntryOverrides).length > 0 && (
                          <div style={{ marginTop: '12px' }}>
                            <span style={{ 
                              fontSize: '11px', 
                              color: '#ff9800', 
                              padding: '4px 8px', 
                              backgroundColor: 'rgba(255, 152, 0, 0.1)', 
                              borderRadius: '4px',
                              fontWeight: '600'
                            }}>
                              {Object.keys(editedEntryOverrides).length} {Object.keys(editedEntryOverrides).length === 1 ? 'entry' : 'entries'} manually edited — new time entries will still appear
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Expenses Section */}
                    <div style={sectionStyle}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                        <h3 style={sectionTitleStyle}>Travel / Subsistence / Expenses / Equipment</h3>
                        {currentTicketRecordId && !isLockedForEditing && (
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
                      
                      {expenses.filter((e) => !(e.id && pendingDeleteExpenseIds.has(e.id))).length === 0 && pendingAddExpenses.length === 0 && !editingExpense && (
                        <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>
                          No expenses added yet.
                        </p>
                      )}

                      {editingExpense && currentTicketRecordId && (
                        <div style={{
                          backgroundColor: 'rgba(255, 152, 0, 0.08)',
                          border: '1px solid rgba(255, 152, 0, 0.35)',
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
                                if (!currentTicketRecordId) {
                                  alert('Cannot add expense: ticket record not ready. Please close and reopen the ticket.');
                                  return;
                                }
                                try {
                                  if (editingExpense.id) {
                                    await updateExpenseMutation.mutateAsync({
                                      id: editingExpense.id,
                                      expense_type: editingExpense.expense_type,
                                      description: editingExpense.description.trim(),
                                      quantity: Number(editingExpense.quantity) || 0,
                                      rate: Number(editingExpense.rate) || 0,
                                      unit: editingExpense.unit?.trim() || undefined,
                                    });
                                    setEditingExpense(null);
                                  } else {
                                    setPendingAddExpenses((prev) => [
                                      ...prev,
                                      {
                                        expense_type: editingExpense.expense_type,
                                        description: editingExpense.description.trim(),
                                        quantity: Number(editingExpense.quantity) || 0,
                                        rate: Number(editingExpense.rate) || 0,
                                        unit: editingExpense.unit?.trim() || undefined,
                                        tempId: `pending-${Date.now()}-${prev.length}`,
                                      },
                                    ]);
                                    setEditingExpense(null);
                                  }
                                } catch (err: unknown) {
                                  console.error('Expense save error:', err);
                                  // Extract message from Error, Supabase error object, or plain string
                                  const raw = err instanceof Error
                                    ? err.message
                                    : (err && typeof err === 'object' && 'message' in err)
                                      ? String((err as { message: unknown }).message)
                                      : (err && typeof err === 'object' && 'details' in err)
                                        ? String((err as { details: unknown }).details)
                                        : JSON.stringify(err);
                                  let message = raw || 'Failed to save expense. Please try again.';
                                  if (typeof message === 'string' && (message.includes('row-level security') || message.includes('policy') || message.includes('permission') || message.includes('403') || message.includes('violates'))) {
                                    message = "Permission denied — RLS policy blocked the insert. Ensure the expense migration has been applied and your user has access to this ticket's expenses.";
                                  }
                                  alert(`Failed to save expense:\n${message}`);
                                }
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

                      {[...expenses.filter((e) => !(e.id && pendingDeleteExpenseIds.has(e.id))), ...pendingAddExpenses.map((e) => ({ ...e, id: e.tempId }))].map((expense) => (
                        <div
                          key={expense.id ?? expense.description + expense.expense_type}
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
                          {!isLockedForEditing && (
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              onClick={() => {
                                if (expense.id?.startsWith('pending-')) {
                                  setPendingAddExpenses((prev) => prev.filter((e) => e.tempId !== expense.id));
                                  setEditingExpense({ expense_type: expense.expense_type, description: expense.description, quantity: expense.quantity, rate: expense.rate, unit: expense.unit });
                                } else {
                                  setEditingExpense({ ...expense });
                                }
                              }}
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
                              onClick={() => {
                                if (expense.id?.startsWith('pending-')) {
                                  setPendingAddExpenses((prev) => prev.filter((e) => e.tempId !== expense.id));
                                } else if (expense.id) {
                                  const id = expense.id;
                                  setPendingDeleteExpenseIds((prev) => new Set(prev).add(id));
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
                          )}
                        </div>
                      ))}

                      {([...expenses.filter((e) => !(e.id && pendingDeleteExpenseIds.has(e.id))), ...pendingAddExpenses].length > 0) && (
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
                            ${[...expenses.filter((e) => !(e.id && pendingDeleteExpenseIds.has(e.id))), ...pendingAddExpenses].reduce((sum, e) => sum + (e.quantity * e.rate), 0).toFixed(2)}
                          </span>
                        </div>
                      )}
                    </div>
                  </>
                );
              })()}

              {/* Workflow Status Section - only visible to admins, hidden when ticket is trashed */}
              {isAdmin && (() => {
                const existing = findMatchingTicketRecord(selectedTicket);
                if ((existing as any)?.is_discarded) return null;
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

              {/* Unsaved changes confirm modal */}
              {showCloseConfirm && (
                <div
                  style={{
                    position: 'fixed',
                    inset: 0,
                    zIndex: 10001,
                    backgroundColor: 'rgba(0,0,0,0.5)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  onClick={() => setShowCloseConfirm(false)}
                >
                  <div
                    style={{
                      backgroundColor: 'var(--bg-primary)',
                      borderRadius: '8px',
                      padding: '24px',
                      maxWidth: '400px',
                      boxShadow: '0 4px 24px rgba(0,0,0,0.2)',
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p style={{ margin: '0 0 20px', color: 'var(--text-primary)', fontSize: '15px' }}>
                      You have unsaved changes. Do you want to save before closing?
                    </p>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                      <button
                        className="button button-secondary"
                        onClick={() => setShowCloseConfirm(false)}
                        style={{ padding: '8px 16px' }}
                      >
                        Cancel
                      </button>
                      <button
                        className="button button-secondary"
                        onClick={() => closePanel()}
                        style={{ padding: '8px 16px' }}
                      >
                        Don&apos;t Save
                      </button>
                      <button
                        className="button button-primary"
                        onClick={async () => {
                          const ok = await performSave();
                          if (ok) {
                            closePanel();
                          }
                        }}
                        disabled={isSavingTicket}
                        style={{ padding: '8px 16px' }}
                      >
                        {isSavingTicket ? 'Saving...' : 'Save and Close'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Reject with notes modal (admin) */}
              {showRejectNoteModal && selectedTicket && (
                <div
                  style={{
                    position: 'fixed',
                    inset: 0,
                    zIndex: 10001,
                    backgroundColor: 'rgba(0,0,0,0.5)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  onClick={() => setShowRejectNoteModal(false)}
                >
                  <div
                    style={{
                      backgroundColor: 'var(--bg-primary)',
                      borderRadius: '8px',
                      padding: '24px',
                      maxWidth: '420px',
                      width: '100%',
                      boxShadow: '0 4px 24px rgba(0,0,0,0.2)',
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p style={{ margin: '0 0 12px', color: 'var(--text-primary)', fontSize: '15px', fontWeight: '600' }}>
                      Reject this ticket?
                    </p>
                    <p style={{ margin: '0 0 12px', color: 'var(--text-secondary)', fontSize: '13px' }}>
                      It will move back to Drafts for the user to revise. Add a reason (optional):
                    </p>
                    <textarea
                      value={rejectNote}
                      onChange={(e) => setRejectNote(e.target.value)}
                      placeholder="Reason for rejection..."
                      rows={4}
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        borderRadius: '6px',
                        border: '1px solid var(--border-color)',
                        backgroundColor: 'var(--bg-secondary)',
                        color: 'var(--text-primary)',
                        fontSize: '14px',
                        resize: 'vertical',
                        marginBottom: '16px',
                        boxSizing: 'border-box',
                      }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                      <button
                        className="button button-secondary"
                        onClick={() => setShowRejectNoteModal(false)}
                        style={{ padding: '8px 16px' }}
                      >
                        Cancel
                      </button>
                      <button
                        className="button"
                        disabled={isApproving}
                        onClick={async () => {
                          setIsApproving(true);
                          try {
                            const billingKey = selectedTicket.id ? getTicketBillingKeyLocal(selectedTicket.id) : '_::_::_';
                            const record = await serviceTicketsService.getOrCreateTicket({
                              date: selectedTicket.date,
                              userId: selectedTicket.userId,
                              customerId: selectedTicket.customerId === 'unassigned' ? null : selectedTicket.customerId,
                              projectId: selectedTicket.projectId,
                              location: selectedTicket.location || '',
                              billingKey,
                            }, isDemoMode);
                            await serviceTicketsService.updateWorkflowStatus(record.id, 'rejected', isDemoMode, rejectNote.trim() || null);
                            queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
                            queryClient.invalidateQueries({ queryKey: ['rejectedTicketsCount'] });
                            queryClient.invalidateQueries({ queryKey: ['resubmittedTicketsCount'] });
                            setShowRejectNoteModal(false);
                            closePanel();
                          } catch (e) {
                            console.error(e);
                          } finally {
                            setIsApproving(false);
                          }
                        }}
                        style={{ padding: '8px 16px', backgroundColor: '#ef5350', color: 'white', border: 'none' }}
                      >
                        {isApproving ? 'Rejecting...' : 'Reject'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {hasPendingChanges && (
                <div style={{
                  marginTop: '16px',
                  marginBottom: '4px',
                  padding: '12px 16px',
                  backgroundColor: 'rgba(255, 152, 0, 0.1)',
                  border: '1px solid #ff9800',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-primary)', fontWeight: '600' }}>
                    Amber highlight = unsaved changes
                  </span>
                </div>
              )}
              {/* Action Buttons - Close on far left, others on right */}
              <div style={{ marginTop: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <button
                    className="button button-secondary"
                    onClick={() => { 
                      if (hasPendingChanges) {
                        setShowCloseConfirm(true);
                      } else {
                        closePanel();
                      }
                    }}
                    style={{ padding: '10px 24px' }}
                    disabled={isExportingExcel || isExportingPdf}
                  >
                    Close
                  </button>
                  {/* Trash button - only when NOT in trash (Restore moves to right when in trash) */}
                  {selectedTicket && (() => {
                    const existingRecord = findMatchingTicketRecord(selectedTicket);
                    const isCurrentlyDiscarded = !!(existingRecord as any)?.is_discarded;
                    if (isCurrentlyDiscarded) return null;
                    return (
                      <button
                        onClick={async () => {
                          if (!currentTicketRecordId) return;
                          if (!confirm('Trash this service ticket? It will be hidden from the default view but can be restored later.')) return;
                          setIsDiscarding(true);
                          try {
                            const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
                            const updatePayload: Record<string, unknown> = { is_discarded: true, ticket_number: null, sequence_number: null, year: null, approved_by_admin_id: null };
                            const { error } = await supabase
                              .from(tableName)
                              .update(updatePayload)
                              .eq('id', currentTicketRecordId);
                            if (error) throw error;
                            await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets', isDemoMode] });
                            await queryClient.refetchQueries({ queryKey: ['existingServiceTickets', isDemoMode] });
                            closePanel();
                          } catch (err) {
                            console.error('Error trashing ticket:', err);
                            alert('Failed to trash ticket.');
                          } finally {
                            setIsDiscarding(false);
                          }
                        }}
                        disabled={isDiscarding || !currentTicketRecordId}
                        style={{
                          padding: '10px 24px',
                          backgroundColor: 'transparent',
                          color: '#ef5350',
                          border: '1px solid #ef5350',
                          borderRadius: '6px',
                          fontSize: '13px',
                          fontWeight: '600',
                          cursor: isDiscarding ? 'wait' : 'pointer',
                        }}
                      >
                        {isDiscarding ? 'Trashing...' : '🗑️ Trash'}
                      </button>
                    );
                  })()}
                </div>
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                {hasPendingChanges && !isLockedForEditing && (
                  <button
                    onClick={async () => {
                      await performSave();
                    }}
                    disabled={isSavingTicket}
                    style={{
                      padding: '10px 24px',
                      backgroundColor: '#ff9800',
                      color: 'white',
                      border: 'none',
                      borderRadius: '6px',
                      fontSize: '13px',
                      fontWeight: '600',
                      cursor: isSavingTicket ? 'wait' : 'pointer',
                    }}
                  >
                    {isSavingTicket ? 'Saving...' : 'Save Changes'}
                  </button>
                )}
                {selectedTicket && (() => {
                  const existingTicketRecord = findMatchingTicketRecord(selectedTicket);
                  const isCurrentlyDiscarded = !!(existingTicketRecord as any)?.is_discarded;

                  // When in trash: show Restore Ticket and (for admins) Delete Permanently
                  if (isCurrentlyDiscarded) {
                    return (
                      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                        <button
                          onClick={async () => {
                            if (!currentTicketRecordId) return;
                            setIsDiscarding(true);
                            try {
                              const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
                              const { error } = await supabase
                                .from(tableName)
                                .update({
                                  is_discarded: false,
                                  restored_at: new Date().toISOString(),
                                  workflow_status: 'draft',
                                  rejected_at: null,
                                  rejection_notes: null,
                                  approved_by_admin_id: null,
                                  ticket_number: null,
                                  sequence_number: null,
                                  year: null,
                                })
                                .eq('id', currentTicketRecordId);
                              if (error) throw error;
                              await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets', isDemoMode] });
                              await queryClient.refetchQueries({ queryKey: ['existingServiceTickets', isDemoMode] });
                              queryClient.invalidateQueries({ queryKey: ['rejectedTicketsCount'] });
                              queryClient.invalidateQueries({ queryKey: ['resubmittedTicketsCount'] });
                              closePanel();
                            } catch (err) {
                              console.error('Error restoring ticket:', err);
                              alert('Failed to restore ticket.');
                            } finally {
                              setIsDiscarding(false);
                            }
                          }}
                          disabled={isDiscarding || !currentTicketRecordId}
                          style={{
                            padding: '10px 24px',
                            backgroundColor: '#10b981',
                            color: 'white',
                            border: '1px solid #10b981',
                            borderRadius: '6px',
                            fontSize: '13px',
                            fontWeight: '600',
                            cursor: isDiscarding ? 'wait' : 'pointer',
                          }}
                        >
                          {isDiscarding ? 'Restoring...' : 'Restore Ticket'}
                        </button>
                        {isAdmin && (
                          <button
                            onClick={async () => {
                              if (!currentTicketRecordId) return;
                              if (!confirm('Permanently delete this service ticket? This will remove the ticket and its time entries from the database. This cannot be undone.')) return;
                              setIsDiscarding(true);
                              try {
                                await serviceTicketsService.deletePermanently(currentTicketRecordId, isDemoMode);
                                await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets', isDemoMode] });
                                await queryClient.invalidateQueries({ queryKey: ['billableEntries'] });
                                await queryClient.refetchQueries({ queryKey: ['existingServiceTickets', isDemoMode] });
                                queryClient.invalidateQueries({ queryKey: ['rejectedTicketsCount'] });
                                queryClient.invalidateQueries({ queryKey: ['resubmittedTicketsCount'] });
                                closePanel();
                              } catch (err) {
                                console.error('Error deleting ticket:', err);
                                alert('Failed to delete ticket.');
                              } finally {
                                setIsDiscarding(false);
                              }
                            }}
                            disabled={isDiscarding || !currentTicketRecordId}
                            style={{
                              padding: '10px 24px',
                              backgroundColor: 'transparent',
                              color: '#ef5350',
                              border: '1px solid #ef5350',
                              borderRadius: '6px',
                              fontSize: '13px',
                              fontWeight: '600',
                              cursor: isDiscarding ? 'wait' : 'pointer',
                            }}
                          >
                            {isDiscarding ? 'Deleting...' : 'Delete Permanently'}
                          </button>
                        )}
                      </div>
                    );
                  }

                  // Not in trash: show admin or user buttons
                  if (!isAdmin) {
                    // Non-admin: Submit for Approval or Approved by Admin
                    const isTicketApproved = existingTicketRecord?.workflow_status === 'approved';
                    const isAdminApproved = !!existingTicketRecord?.ticket_number;
                    const approvedByAdmin = (existingTicketRecord as any)?.approved_by_admin;
                    const adminName = approvedByAdmin
                      ? `${approvedByAdmin.first_name || ''} ${approvedByAdmin.last_name || ''}`.trim() || 'Admin'
                      : 'Admin';
                    if (isAdminApproved) {
                      return (
                        <button
                          className="button button-secondary"
                          disabled
                          style={{ padding: '10px 24px', backgroundColor: '#10b981', borderColor: '#10b981', cursor: 'not-allowed', opacity: 0.8 }}
                          title={`Approved by ${adminName}`}
                        >
                          ✓ Approved by {adminName}
                        </button>
                      );
                    }
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'flex-start' }}>
                        {submitError && (
                          <div style={{ color: '#ef5350', fontSize: '14px', maxWidth: '100%' }}>{submitError}</div>
                        )}
                        <button
                          className={isTicketApproved ? 'button button-secondary' : 'button button-primary'}
                          onClick={async () => {
                            setSubmitError(null);
                            setIsApproving(true);
                            try {
                              // When submitting (not withdrawing), save first
                              if (!isTicketApproved) {
                                const ok = await performSave();
                                if (!ok) { setIsApproving(false); return; }
                              }
                              const billingKey = selectedTicket.id ? getTicketBillingKeyLocal(selectedTicket.id) : '_::_::_';
                              const ticketRecord = await serviceTicketsService.getOrCreateTicket({
                                date: selectedTicket.date,
                                userId: selectedTicket.userId,
                                customerId: selectedTicket.customerId === 'unassigned' ? null : selectedTicket.customerId,
                                projectId: selectedTicket.projectId,
                                location: selectedTicket.location || '',
                                billingKey,
                              }, isDemoMode);
                              const newStatus = isTicketApproved ? 'draft' : 'approved';
                              await serviceTicketsService.updateWorkflowStatus(ticketRecord.id, newStatus, isDemoMode);
                              await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
                              await queryClient.invalidateQueries({ queryKey: ['rejectedTicketsCount'] });
                              await queryClient.invalidateQueries({ queryKey: ['resubmittedTicketsCount'] });
                              await queryClient.refetchQueries({ queryKey: ['existingServiceTickets'] });
                              // Unlock panel when withdrawing submission
                              if (isTicketApproved) {
                                setIsLockedForEditing(false);
                              } else {
                                // Lock panel after submitting
                                setIsLockedForEditing(true);
                              }
                            } catch (error) {
                              const msg = error instanceof Error ? error.message : 'Failed to submit for approval.';
                              setSubmitError(msg);
                            } finally {
                              setIsApproving(false);
                            }
                          }}
                          style={{ padding: '10px 24px', backgroundColor: isTicketApproved ? '#3b82f6' : undefined, borderColor: isTicketApproved ? '#3b82f6' : undefined }}
                          disabled={isApproving}
                        >
                          {isApproving ? 'Submitting...' : (isTicketApproved ? 'Withdraw Submission' : 'Submit for Approval')}
                        </button>
                      </div>
                    );
                  }
                  const hasTicketNumber = !!existingTicketRecord?.ticket_number;
                  const workflowStatus = existingTicketRecord?.workflow_status || 'draft';
                  const isUserApprovedNotYetApproved = !hasTicketNumber && workflowStatus !== 'draft' && workflowStatus !== 'rejected';

                  // Admin has approved (has ticket number): show Export PDF
                  if (hasTicketNumber) {
                    return (
                      <button
                        className="button button-primary"
                        onClick={async () => {
                          if (currentTicketRecordId && expenses.length === 0) await loadExpenses(currentTicketRecordId);
                          const hoursTotals = {
                            'Shop Time': serviceRows.reduce((sum, r) => sum + (r.st || 0), 0),
                            'Travel Time': serviceRows.reduce((sum, r) => sum + (r.tt || 0), 0),
                            'Field Time': serviceRows.reduce((sum, r) => sum + (r.ft || 0), 0),
                            'Shop Overtime': serviceRows.reduce((sum, r) => sum + (r.so || 0), 0),
                            'Field Overtime': serviceRows.reduce((sum, r) => sum + (r.fo || 0), 0),
                          };
                          const exportEntries: typeof selectedTicket.entries = [];
                          serviceRows.forEach((row, idx) => {
                            const template = selectedTicket.entries[0] || { id: '', date: selectedTicket.date, user_id: selectedTicket.userId };
                            if (row.st > 0) exportEntries.push({ ...template, id: `export-st-${idx}`, description: row.description, hours: row.st, rate_type: 'Shop Time' });
                            if (row.tt > 0) exportEntries.push({ ...template, id: `export-tt-${idx}`, description: row.description, hours: row.tt, rate_type: 'Travel Time' });
                            if (row.ft > 0) exportEntries.push({ ...template, id: `export-ft-${idx}`, description: row.description, hours: row.ft, rate_type: 'Field Time' });
                            if (row.so > 0) exportEntries.push({ ...template, id: `export-so-${idx}`, description: row.description, hours: row.so, rate_type: 'Shop Overtime' });
                            if (row.fo > 0) exportEntries.push({ ...template, id: `export-fo-${idx}`, description: row.description, hours: row.fo, rate_type: 'Field Overtime' });
                          });
                          const modifiedTicket: ServiceTicket = {
                            ...selectedTicket,
                            userName: editableTicket.techName,
                            projectNumber: editableTicket.projectNumber,
                            date: editableTicket.date,
                            projectOther: editableTicket.other,
                            customerInfo: {
                              ...selectedTicket.customerInfo,
                              name: editableTicket.customerName,
                              contact_name: editableTicket.contactName,
                              address: editableTicket.address,
                              city: editableTicket.cityState.split(',')[0]?.trim() || '',
                              state: editableTicket.cityState.split(',')[1]?.trim() || '',
                              zip_code: editableTicket.zipCode,
                              phone: editableTicket.phone,
                              email: editableTicket.email,
                              service_location: editableTicket.serviceLocation,
                              location_code: editableTicket.locationCode,
                              po_number: editableTicket.poNumber,
                              approver_name: editableTicket.approver ?? '',
                              approver: editableTicket.approver,
                              po_afe: editableTicket.poAfe,
                              cc: editableTicket.cc,
                            },
                            hoursByRateType: hoursTotals as typeof selectedTicket.hoursByRateType,
                            entries: exportEntries,
                          };
                          modifiedTicket.totalHours = Object.values(hoursTotals).reduce((sum, h) => sum + h, 0);
                          await handleExportPdf(modifiedTicket);
                          queryClient.invalidateQueries({ queryKey: ['billableEntries'] });
                          queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
                        }}
                        style={{ padding: '10px 24px' }}
                        disabled={isExportingExcel || isExportingPdf}
                      >
                        {isExportingPdf ? 'Generating PDF...' : 'Export PDF'}
                      </button>
                    );
                  }

                  // User submitted, waiting for admin: show Reject (left) and Approve (right)
                  if (isUserApprovedNotYetApproved) {
                    return (
                      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                        <button
                          className="button"
                          disabled={isApproving}
                          onClick={() => {
                            setRejectNote('');
                            setShowRejectNoteModal(true);
                          }}
                          style={{ padding: '10px 24px', backgroundColor: '#ef5350', color: 'white', border: 'none' }}
                        >
                          Reject
                        </button>
                        <button
                          className="button"
                          disabled={isApproving}
                          onClick={async () => {
                            setIsApproving(true);
                            try {
                              const ok = await performSave();
                              if (!ok) { setIsApproving(false); return; }
                              await handleAssignTicketNumber(selectedTicket);
                              queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
                              queryClient.invalidateQueries({ queryKey: ['rejectedTicketsCount'] });
                              queryClient.invalidateQueries({ queryKey: ['resubmittedTicketsCount'] });
                              closePanel();
                            } catch (e) {
                              console.error(e);
                            } finally {
                              setIsApproving(false);
                            }
                          }}
                          style={{ padding: '10px 24px', backgroundColor: '#10b981', color: 'white', border: 'none' }}
                        >
                          {isApproving ? 'Approving...' : 'Approve'}
                        </button>
                      </div>
                    );
                  }

                  // Draft/Rejected: show single Approve (assign ticket number) button
                  return (
                    <button
                      className="button button-primary"
                      disabled={isApproving}
                      onClick={async () => {
                        setIsApproving(true);
                        try {
                          const ok = await performSave();
                          if (!ok) { setIsApproving(false); return; }
                          await handleAssignTicketNumber(selectedTicket);
                          queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
                          queryClient.invalidateQueries({ queryKey: ['rejectedTicketsCount'] });
                          queryClient.invalidateQueries({ queryKey: ['resubmittedTicketsCount'] });
                          closePanel();
                        } catch (e) {
                          console.error(e);
                        } finally {
                          setIsApproving(false);
                        }
                      }}
                      style={{ padding: '10px 24px' }}
                    >
                      {isApproving ? 'Approving...' : 'Approve'}
                    </button>
                  );
                })()}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create Service Ticket Panel */}
      {showCreatePanel && (
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
          onClick={() => setShowCreatePanel(false)}
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
            {/* Header */}
            <div style={{ padding: '24px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h2 style={{ fontSize: '24px', fontWeight: '700', color: 'var(--text-primary)', margin: '0 0 8px 0' }}>
                  CREATE SERVICE TICKET
                </h2>
                <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)' }}>
                  Fill in the details below to create a new service ticket.
                </p>
              </div>
              <button
                onClick={() => setShowCreatePanel(false)}
                style={{ background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer', color: 'var(--text-secondary)', padding: '4px 8px' }}
              >
                ×
              </button>
            </div>

            {/* Body */}
            <div style={{ padding: '24px' }}>
              {/* Customer & Service Info */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '24px' }}>
                {/* Customer Information */}
                <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '16px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: '700', color: 'var(--primary-color)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Customer Information</h3>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <label style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Customer Name</label>
                    {!showInlineCreateCustomer && (
                      <button
                        onClick={() => setShowInlineCreateCustomer(true)}
                        style={{ background: 'none', border: 'none', color: 'var(--primary-color)', fontSize: '12px', fontWeight: '600', cursor: 'pointer', padding: 0 }}
                      >
                        + New Customer
                      </button>
                    )}
                  </div>
                  {showInlineCreateCustomer ? (
                    <div style={{ display: 'flex', gap: '6px', marginBottom: '4px' }}>
                      <input
                        type="text"
                        placeholder="Customer name..."
                        value={inlineCustomerName}
                        onChange={(e) => setInlineCustomerName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleInlineCreateCustomer(); }}
                        autoFocus
                        style={{ flex: 1, padding: '8px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--primary-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }}
                      />
                      <button
                        onClick={handleInlineCreateCustomer}
                        disabled={isCreatingCustomer || !inlineCustomerName.trim()}
                        style={{ padding: '8px 12px', backgroundColor: 'var(--primary-color)', color: 'white', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: '600', cursor: 'pointer', whiteSpace: 'nowrap' }}
                      >
                        {isCreatingCustomer ? '...' : 'Create'}
                      </button>
                      <button
                        onClick={() => { setShowInlineCreateCustomer(false); setInlineCustomerName(''); }}
                        style={{ padding: '8px 10px', background: 'none', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-secondary)', fontSize: '12px', cursor: 'pointer' }}
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <SearchableSelect
                      options={customers?.map((c: any) => ({ value: c.id, label: c.name })) || []}
                      value={createCustomerId}
                      onChange={handleCreateCustomerSelect}
                      placeholder="Search customers..."
                      emptyOption={{ value: '', label: 'Select a customer...' }}
                    />
                  )}

                  <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginTop: '10px', marginBottom: '4px' }}>Address</label>
                  <input
                    type="text"
                    value={createData.address}
                    onChange={(e) => setCreateData(prev => ({ ...prev, address: e.target.value }))}
                    style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }}
                  />

                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '10px', marginTop: '10px' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>City, Province</label>
                      <input
                        type="text"
                        value={createData.cityState}
                        onChange={(e) => setCreateData(prev => ({ ...prev, cityState: e.target.value }))}
                        style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Postal Code</label>
                      <input
                        type="text"
                        value={createData.zipCode}
                        onChange={(e) => setCreateData(prev => ({ ...prev, zipCode: e.target.value }))}
                        style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }}
                      />
                    </div>
                  </div>

                  <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginTop: '10px', marginBottom: '4px' }}>Contact Name</label>
                  <input
                    type="text"
                    value={createData.contactName}
                    onChange={(e) => setCreateData(prev => ({ ...prev, contactName: e.target.value }))}
                    style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }}
                  />

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '10px' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Phone</label>
                      <input
                        type="text"
                        value={createData.phone}
                        onChange={(e) => setCreateData(prev => ({ ...prev, phone: e.target.value }))}
                        style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Email</label>
                      <input
                        type="text"
                        value={createData.email}
                        onChange={(e) => setCreateData(prev => ({ ...prev, email: e.target.value }))}
                        style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }}
                      />
                    </div>
                  </div>
                </div>

                {/* Service Information */}
                <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '16px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: '700', color: 'var(--primary-color)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Service Information</h3>

                  <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Technician</label>
                  <input
                    type="text"
                    value={createData.techName}
                    onChange={(e) => setCreateData(prev => ({ ...prev, techName: e.target.value }))}
                    style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }}
                  />

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px', marginBottom: '4px' }}>
                    <label style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Project</label>
                    {!showInlineCreateProject && createCustomerId && (
                      <button
                        onClick={() => setShowInlineCreateProject(true)}
                        style={{ background: 'none', border: 'none', color: 'var(--primary-color)', fontSize: '12px', fontWeight: '600', cursor: 'pointer', padding: 0 }}
                      >
                        + New Project
                      </button>
                    )}
                  </div>
                  {showInlineCreateProject ? (
                    <div style={{ padding: '10px', marginBottom: '4px', backgroundColor: 'rgba(37, 99, 235, 0.05)', borderRadius: '8px', border: '1px solid rgba(37, 99, 235, 0.2)' }}>
                      <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
                        <input
                          type="text"
                          placeholder="Project name..."
                          value={inlineProjectName}
                          onChange={(e) => setInlineProjectName(e.target.value)}
                          autoFocus
                          style={{ flex: 2, padding: '8px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--primary-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px', boxSizing: 'border-box' }}
                        />
                        <input
                          type="text"
                          placeholder="Project #..."
                          value={inlineProjectNumber}
                          onChange={(e) => setInlineProjectNumber(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleInlineCreateProject(); }}
                          style={{ flex: 1, padding: '8px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px', boxSizing: 'border-box' }}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => { setShowInlineCreateProject(false); setInlineProjectName(''); setInlineProjectNumber(''); }}
                          style={{ padding: '6px 12px', background: 'none', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-secondary)', fontSize: '12px', cursor: 'pointer' }}
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleInlineCreateProject}
                          disabled={isCreatingProject || !inlineProjectName.trim()}
                          style={{ padding: '6px 12px', backgroundColor: 'var(--primary-color)', color: 'white', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}
                        >
                          {isCreatingProject ? 'Creating...' : 'Create Project'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <SearchableSelect
                      options={createProjectOptions}
                      value={createProjectId}
                      onChange={handleCreateProjectSelect}
                      placeholder={createCustomerId ? 'Search projects...' : 'Select a customer first'}
                      emptyOption={{ value: '', label: createCustomerId ? 'No project' : 'Select a customer first' }}
                    />
                  )}

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '10px' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Project #</label>
                      <input
                        type="text"
                        value={createData.projectNumber}
                        onChange={(e) => setCreateData(prev => ({ ...prev, projectNumber: e.target.value }))}
                        style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Date</label>
                      <input
                        type="date"
                        value={createData.date}
                        onChange={(e) => setCreateData(prev => ({ ...prev, date: e.target.value }))}
                        style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }}
                      />
                    </div>
                  </div>

                  <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginTop: '10px', marginBottom: '4px' }}>Service Location</label>
                  <input
                    type="text"
                    value={createData.serviceLocation}
                    onChange={(e) => setCreateData(prev => ({ ...prev, serviceLocation: e.target.value }))}
                    style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }}
                  />

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '6px' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>PO/AFE/CC (Cost Center)</label>
                      <input
                        type="text"
                        value={createData.poAfe}
                        onChange={(e) => setCreateData(prev => ({ ...prev, poAfe: e.target.value }))}
                        style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Approver</label>
                      <input
                        type="text"
                        value={createData.approver}
                        onChange={(e) => setCreateData(prev => ({ ...prev, approver: e.target.value }))}
                        style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }}
                      />
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '10px' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Coding</label>
                      <input
                        type="text"
                        value={createData.cc}
                        onChange={(e) => setCreateData(prev => ({ ...prev, cc: e.target.value }))}
                        style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Other</label>
                      <input
                        type="text"
                        value={createData.other}
                        onChange={(e) => setCreateData(prev => ({ ...prev, other: e.target.value }))}
                        style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Service Description */}
              <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '16px', marginBottom: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: '700', color: 'var(--primary-color)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Service Description</h3>
                  <button
                    className="button button-primary"
                    onClick={() => setCreateServiceRows(prev => [...prev, { id: `new-${Date.now()}`, description: '', st: 0, tt: 0, ft: 0, so: 0, fo: 0 }])}
                    style={{ padding: '6px 12px', fontSize: '12px' }}
                  >
                    + Add Row
                  </button>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
                      <th style={{ textAlign: 'left', padding: '8px', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)' }}>Description</th>
                      <th style={{ textAlign: 'center', padding: '8px', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', width: '60px' }}>ST</th>
                      <th style={{ textAlign: 'center', padding: '8px', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', width: '60px' }}>TT</th>
                      <th style={{ textAlign: 'center', padding: '8px', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', width: '60px' }}>FT</th>
                      <th style={{ textAlign: 'center', padding: '8px', fontSize: '12px', fontWeight: '600', color: '#ff9800', width: '60px' }}>SO</th>
                      <th style={{ textAlign: 'center', padding: '8px', fontSize: '12px', fontWeight: '600', color: '#ff9800', width: '60px' }}>FO</th>
                      <th style={{ width: '30px' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {createServiceRows.map((row, idx) => (
                      <tr key={row.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                        <td style={{ padding: '6px 8px' }}>
                          <textarea
                            className="service-ticket-textarea"
                            value={row.description}
                            onChange={(e) => {
                              const updated = [...createServiceRows];
                              updated[idx] = { ...updated[idx], description: e.target.value };
                              setCreateServiceRows(updated);
                            }}
                            rows={1}
                            style={{
                              width: '100%',
                              padding: '6px',
                              backgroundColor: 'var(--bg-primary)',
                              border: '1px solid var(--border-color)',
                              borderRadius: '4px',
                              color: 'var(--text-primary)',
                              fontSize: '13px',
                              resize: 'vertical',
                              minHeight: '32px',
                              boxSizing: 'border-box',
                            }}
                          />
                        </td>
                        {(['st', 'tt', 'ft', 'so', 'fo'] as const).map(field => (
                          <td key={field} style={{ padding: '6px 4px', textAlign: 'center' }}>
                            <input
                              type="number"
                              step="0.5"
                              min="0"
                              value={row[field] || ''}
                              onChange={(e) => {
                                const updated = [...createServiceRows];
                                updated[idx] = { ...updated[idx], [field]: parseFloat(e.target.value) || 0 };
                                setCreateServiceRows(updated);
                              }}
                              style={{
                                width: '50px',
                                padding: '6px 4px',
                                textAlign: 'center',
                                backgroundColor: 'var(--bg-primary)',
                                border: '1px solid var(--border-color)',
                                borderRadius: '4px',
                                color: 'var(--text-primary)',
                                fontSize: '13px',
                              }}
                            />
                          </td>
                        ))}
                        <td style={{ padding: '6px 4px', textAlign: 'center' }}>
                          {createServiceRows.length > 1 && (
                            <button
                              onClick={() => setCreateServiceRows(prev => prev.filter((_, i) => i !== idx))}
                              style={{ background: 'none', border: 'none', color: '#ef5350', cursor: 'pointer', fontSize: '16px', fontWeight: '700' }}
                            >
                              ×
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {/* Total hours */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px', fontSize: '13px', fontWeight: '700' }}>
                  <span style={{ color: 'var(--text-primary)' }}>TOTAL:</span>
                  <span style={{ width: '60px', textAlign: 'center' }}>{createServiceRows.reduce((s, r) => s + r.st, 0).toFixed(1)}</span>
                  <span style={{ width: '60px', textAlign: 'center' }}>{createServiceRows.reduce((s, r) => s + r.tt, 0).toFixed(1)}</span>
                  <span style={{ width: '60px', textAlign: 'center' }}>{createServiceRows.reduce((s, r) => s + r.ft, 0).toFixed(1)}</span>
                  <span style={{ width: '60px', textAlign: 'center', color: '#ff9800' }}>{createServiceRows.reduce((s, r) => s + r.so, 0).toFixed(1)}</span>
                  <span style={{ width: '60px', textAlign: 'center', color: '#ff9800' }}>{createServiceRows.reduce((s, r) => s + r.fo, 0).toFixed(1)}</span>
                  <span style={{ width: '30px' }}></span>
                </div>
              </div>

              {/* Expenses */}
              <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '16px', marginBottom: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: '700', color: 'var(--primary-color)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Travel / Subsistence / Expenses / Equipment</h3>
                  <button
                    className="button button-primary"
                    onClick={() => setCreateEditingExpense({ expense_type: 'Travel', description: '', quantity: 1, rate: 0, unit: '' })}
                    style={{ padding: '6px 12px', fontSize: '12px' }}
                  >
                    + Add Expense
                  </button>
                </div>

                {/* Add/Edit expense form */}
                {createEditingExpense && (
                  <div style={{ padding: '12px', marginBottom: '12px', backgroundColor: 'rgba(255, 152, 0, 0.08)', borderRadius: '8px', border: '1px solid rgba(255, 152, 0, 0.3)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 1fr 1fr', gap: '8px', alignItems: 'end' }}>
                      <div>
                        <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>Type</label>
                        <select
                          value={createEditingExpense.expense_type}
                          onChange={(e) => setCreateEditingExpense(prev => prev ? { ...prev, expense_type: e.target.value as any } : null)}
                          style={{ width: '100%', padding: '6px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '13px' }}
                        >
                          <option value="Travel">Travel</option>
                          <option value="Subsistence">Subsistence</option>
                          <option value="Expenses">Expenses</option>
                          <option value="Equipment">Equipment</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>Description</label>
                        <input
                          type="text"
                          value={createEditingExpense.description}
                          onChange={(e) => setCreateEditingExpense(prev => prev ? { ...prev, description: e.target.value } : null)}
                          style={{ width: '100%', padding: '6px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '13px', boxSizing: 'border-box' }}
                        />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>Qty</label>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={createEditingExpense.quantity}
                          onChange={(e) => setCreateEditingExpense(prev => prev ? { ...prev, quantity: parseFloat(e.target.value) || 0 } : null)}
                          style={{ width: '100%', padding: '6px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '13px', textAlign: 'center' }}
                        />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>Rate ($)</label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={createEditingExpense.rate}
                          onChange={(e) => setCreateEditingExpense(prev => prev ? { ...prev, rate: parseFloat(e.target.value) || 0 } : null)}
                          style={{ width: '100%', padding: '6px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '13px', textAlign: 'center' }}
                        />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>Unit</label>
                        <input
                          type="text"
                          value={createEditingExpense.unit || ''}
                          onChange={(e) => setCreateEditingExpense(prev => prev ? { ...prev, unit: e.target.value } : null)}
                          placeholder="km, day..."
                          style={{ width: '100%', padding: '6px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '13px', boxSizing: 'border-box' }}
                        />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', marginTop: '8px', justifyContent: 'flex-end' }}>
                      <button
                        onClick={() => setCreateEditingExpense(null)}
                        className="button button-secondary"
                        style={{ padding: '6px 14px', fontSize: '12px' }}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => {
                          if (!createEditingExpense.description) return;
                          setCreateExpenses(prev => [...prev, { ...createEditingExpense, tempId: `exp-${Date.now()}` }]);
                          setCreateEditingExpense(null);
                        }}
                        className="button button-primary"
                        style={{ padding: '6px 14px', fontSize: '12px' }}
                      >
                        Add
                      </button>
                    </div>
                  </div>
                )}

                {/* Expense list */}
                {createExpenses.length > 0 && (
                  <div>
                    {createExpenses.map((exp) => (
                      <div key={exp.tempId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
                        <div>
                          <span style={{ fontSize: '11px', fontWeight: '700', color: 'var(--primary-color)', textTransform: 'uppercase' }}>{exp.expense_type}</span>
                          <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{exp.description}{exp.unit ? ` (${exp.unit})` : ''}</div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <span style={{ fontWeight: '600', color: 'var(--text-primary)' }}>${(exp.quantity * exp.rate).toFixed(2)}</span>
                          <button
                            onClick={() => setCreateExpenses(prev => prev.filter(e => e.tempId !== exp.tempId))}
                            style={{ padding: '4px 8px', fontSize: '11px', border: '1px solid var(--border-color)', borderRadius: '4px', background: 'none', color: '#ef5350', cursor: 'pointer' }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', fontWeight: '700' }}>
                      <span>TOTAL EXPENSES:</span>
                      <span style={{ color: 'var(--primary-color)' }}>${createExpenses.reduce((s, e) => s + e.quantity * e.rate, 0).toFixed(2)}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Footer buttons */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                <button
                  className="button button-secondary"
                  onClick={() => setShowCreatePanel(false)}
                  style={{ padding: '10px 24px' }}
                >
                  Cancel
                </button>
                <button
                  className="button button-primary"
                  onClick={handleCreateTicketSave}
                  disabled={isCreatingTicket || !createCustomerId || !createData.date}
                  style={{
                    padding: '10px 24px',
                    fontSize: '14px',
                    fontWeight: '600',
                    opacity: (!createCustomerId || !createData.date) ? 0.5 : 1,
                  }}
                >
                  {isCreatingTicket ? 'Creating...' : 'Create Service Ticket'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

