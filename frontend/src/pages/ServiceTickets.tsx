import { useState, useMemo, useEffect, useRef, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { serviceTicketsService, customersService, employeesService, serviceTicketExpensesService, projectsService, timeEntriesService, userExpensesService } from '../services/supabaseServices';
import { optimizeImage } from '../utils/imageOptimizer';
import { groupEntriesIntoTickets, formatTicketDate, generateTicketDisplayId, ServiceTicket, getRateTypeSortOrder, applyHeaderOverridesToTicket, buildApproverPoAfe, getProjectHeaderFields, getTicketBillingKey, buildBillingKey, buildGroupingKey } from '../utils/serviceTickets';
import { Link, useSearchParams } from 'react-router-dom';
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
  const [searchParams, setSearchParams] = useSearchParams();
  
  // Filters state
  const [startDate, setStartDate] = useState(() => '2026-01-01');
  const [endDate, setEndDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState('');
  // Filter tabs: 'draft' (Not Submitted), 'submitted' (Pending Approval), 'approved' (Finalized), 'all'
  // Admin defaults to Submitted tab on first open; non-admin to Drafts
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const tabRefsMap = useRef<Record<string, HTMLButtonElement | null>>({});
  const [tabIndicatorStyle, setTabIndicatorStyle] = useState<{ left: number; width: number } | null>(null);
  const [activeTab, setActiveTab] = useState<'draft' | 'submitted' | 'approved' | 'all'>(() =>
    isAdmin ? 'all' : 'draft'
  );
  const prevIsAdminRef = useRef(isAdmin);
  useEffect(() => {
    if (prevIsAdminRef.current !== isAdmin) {
      prevIsAdminRef.current = isAdmin;
      setActiveTab(isAdmin ? 'all' : 'draft');
      queryClient.invalidateQueries({ queryKey: ['billableEntries'] });
      queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
    }
  }, [isAdmin, queryClient]);
  const [showDiscarded, setShowDiscarded] = useState(false);

  // Admin employee overview panel
  const [showEmployeeOverview, setShowEmployeeOverview] = useState(true);
  const [expandedEmployeeId, setExpandedEmployeeId] = useState<string | null>(null);
  const [expandedStatusSections, setExpandedStatusSections] = useState<Record<string, Set<string>>>({});
  const toggleStatusSection = (userId: string, status: string) => {
    setExpandedStatusSections(prev => {
      const sections = new Set(prev[userId] || []);
      if (sections.has(status)) sections.delete(status);
      else sections.add(status);
      return { ...prev, [userId]: sections };
    });
  };

  // Refetch sidebar notification counts when opening Service Tickets so they stay in sync (e.g. after a ticket was removed elsewhere)
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: ['rejectedTicketsCount'] });
    queryClient.invalidateQueries({ queryKey: ['resubmittedTicketsCount'] });
  }, [queryClient]);

  // Dashboard action items: open Employee Overview and switch tab from URL params
  useEffect(() => {
    const overview = searchParams.get('overview');
    const tab = searchParams.get('tab');
    if (overview === 'open') {
      setShowEmployeeOverview(true);
    }
    if (tab === 'submitted') {
      setActiveTab('submitted');
    }
    if (overview || tab) {
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

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
    actual_cost?: number;
    unit?: string;
  }>>([]);
  const [editingExpense, setEditingExpense] = useState<{
    id?: string;
    expense_type: 'Travel' | 'Subsistence' | 'Expenses' | 'Equipment';
    description: string;
    quantity: number;
    rate: number;
    actual_cost?: number;
    unit?: string;
    needs_reimbursement?: boolean;
  } | null>(null);
  const [pendingDeleteExpenseIds, setPendingDeleteExpenseIds] = useState<Set<string>>(new Set());
  const [pendingAddExpenses, setPendingAddExpenses] = useState<Array<{
    expense_type: 'Travel' | 'Subsistence' | 'Expenses' | 'Equipment';
    description: string;
    quantity: number;
    rate: number;
    actual_cost?: number;
    unit?: string;
    tempId?: string;
    needs_reimbursement?: boolean;
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
    approverNotes?: string;
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
  const [rejectModalMode, setRejectModalMode] = useState<'reject' | 'unapprove'>('reject');
  const [ticketForRejectModal, setTicketForRejectModal] = useState<ServiceTicket | null>(null);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [showCustomTicketIdModal, setShowCustomTicketIdModal] = useState(false);
  const [customTicketId, setCustomTicketId] = useState('');
  const [customTicketIdError, setCustomTicketIdError] = useState('');
  const [pendingChangesVersion, setPendingChangesVersion] = useState(0);

  // Receipt drag-and-drop split view state
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  const [receiptPreviewUrl, setReceiptPreviewUrl] = useState<string | null>(null);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptForm, setReceiptForm] = useState({ description: '', amount: '', gst: '', markupType: 'dollar' as 'dollar' | 'percent', markupValue: '', is_billable: false });
  const [isUploadingReceipt, setIsUploadingReceipt] = useState(false);
  const [receiptUploadError, setReceiptUploadError] = useState<string | null>(null);
  const receiptDropRef = useRef<HTMLDivElement>(null);
  const receiptFileInputRef = useRef<HTMLInputElement>(null);
  // When user adds expense with Needs Reimbursement, we prompt for receipt before adding
  const [pendingReimbursementExpense, setPendingReimbursementExpense] = useState<{
    expense_type: 'Travel' | 'Subsistence' | 'Expenses' | 'Equipment';
    description: string;
    quantity: number;
    rate: number;
    actual_cost?: number;
    unit?: string;
  } | null>(null);
  const receiptModalFileInputRef = useRef<HTMLInputElement>(null);

  const handleStartReceiptEdit = (receipt: any) => {
    setEditingReceipt(receipt);
    setEditReceiptForm({
      description: receipt.description || '',
      amount: String(parseFloat(receipt.amount)),
      gst: String(parseFloat(receipt.gst || 0)),
    });
    setEditReceiptPreviewUrl(null);
    if (receipt.receipt_url) {
      const isPdf = (receipt.receipt_url || '').toLowerCase().endsWith('.pdf');
      setEditReceiptPreviewIsPdf(isPdf);
      userExpensesService.getReceiptSignedUrl(receipt.receipt_url)
        .then((url) => setEditReceiptPreviewUrl(url))
        .catch(() => setEditReceiptPreviewUrl(null));
    }
  };

  const handleSaveReceiptEdit = async () => {
    if (!editingReceipt) return;
    if (!editReceiptForm.description.trim()) { alert('Description is required'); return; }
    if (!editReceiptForm.amount || parseFloat(editReceiptForm.amount) <= 0) { alert('Amount must be greater than 0'); return; }
    setIsSavingReceipt(true);
    try {
      await userExpensesService.updateAndSyncTicket(editingReceipt.id, {
        description: editReceiptForm.description.trim(),
        amount: parseFloat(editReceiptForm.amount),
        gst: parseFloat(editReceiptForm.gst) || 0,
      });
      queryClient.invalidateQueries({ queryKey: ['attachedReceipts'] });
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['serviceTicketExpenseTotals'] });
      if (currentTicketRecordId) loadExpenses(currentTicketRecordId);
      setEditingReceipt(null);
    } catch (err: any) {
      alert('Failed to save: ' + (err.message || 'Unknown error'));
    } finally {
      setIsSavingReceipt(false);
    }
  };

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
            approver_notes: editableTicket.approverNotes?.trim() || null,
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
        const expense = expenses.find((e) => e.id === expenseId);
        if (expense && recordId) {
          await userExpensesService.unlinkReceiptsForDeletedExpense(recordId, expense.description);
        }
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
            needs_reimbursement: exp.needs_reimbursement || false,
            reimbursement_status: exp.needs_reimbursement ? (isAdmin ? 'approved' : 'pending') : undefined,
          });
        }
        setPendingAddExpenses([]);
      }
      if (recordId && hadPendingExpenseChanges) {
        await loadExpenses(recordId);
        queryClient.invalidateQueries({ queryKey: ['serviceTicketExpenseTotals'] });
        queryClient.invalidateQueries({ queryKey: ['attachedReceipts'] });
        queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
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
    setCurrentTicketRecordId(null);
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
  // Preserve input order (entries already sorted by created_at asc from API - first-entered first)
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
    // Append only manually added rows (id starts with "new-") from overrides.
    // Stale overrides with IDs that don't match current entries are ignored to prevent duplicates.
    const existingIds = new Set(baseRows.map(r => r.id));
    Object.entries(overrides).forEach(([id, ov]) => {
      if (!existingIds.has(id) && id.startsWith('new-')) {
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

  // Assign ticket number to a single ticket.
  // When useSavedData is true (e.g. admin approved from panel after saving), only assign number/metadata; do not overwrite hours/header.
  const handleAssignTicketNumber = async (ticket: ServiceTicket, opts?: { useSavedData?: boolean }) => {
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
        const useSavedData = opts?.useSavedData === true;
        const headerOverrides = useSavedData ? undefined : buildApprovalHeaderOverrides(ticket);
        const approvalHours = useSavedData ? undefined : (() => {
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
          return ticket.totalHours > 0 ? {
            totalHours: ticket.totalHours,
            totalAmount,
            editedHours: legacy.hours,
            editedDescriptions: legacy.descriptions,
          } : undefined;
        })();
        await serviceTicketsService.updateTicketNumber(ticketRecordId, ticketNumber, isDemoTicket, user?.id, headerOverrides, approvalHours);
        
        // Clean up any duplicate draft records since this ticket is now approved
        await serviceTicketsService.deleteOtherDraftRecordsForTicket(ticketRecordId, isDemoTicket);
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
        
        // Ensure any other draft/submitted records for this same logical ticket are removed
        // since we just created a fresh approved record
        await serviceTicketsService.deleteOtherDraftRecordsForTicket(ticketRecordId, isDemoTicket);
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

  // Reassign ticket number (unassign then assign a new auto-generated number)
  const handleReassignTicketNumber = async (ticket: ServiceTicket) => {
    try {
      const existing = findMatchingTicketRecord(ticket);
      if (!existing) return;

      // Unassign first
      await serviceTicketsService.updateTicketNumber(existing.id, null, isDemoMode);
      // Now assign a fresh number
      await handleAssignTicketNumber(ticket);
    } catch (error) {
      console.error('Error reassigning ticket number:', error);
      alert(`Failed to reassign ticket number: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Assign a custom ticket ID (admin enters it manually)
  const handleCustomTicketIdAssign = async (ticket: ServiceTicket) => {
    const trimmed = customTicketId.trim().toUpperCase();
    if (!trimmed) {
      setCustomTicketIdError('Please enter a ticket ID.');
      return;
    }
    // Validate format: XX_YYNNN (letters_digitsdigitsdigits)
    if (!/^[A-Z]+_\d{5,}$/.test(trimmed)) {
      setCustomTicketIdError('Format must be like HV_26007 (initials_yearSequence).');
      return;
    }
    setCustomTicketIdError('');
    try {
      // Check if ticket ID is already in use
      const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
      const { data: existingWithNumber } = await supabase
        .from(tableName)
        .select('id')
        .eq('ticket_number', trimmed)
        .maybeSingle();
      if (existingWithNumber) {
        setCustomTicketIdError(`Ticket ID "${trimmed}" is already in use.`);
        return;
      }

      const existing = findMatchingTicketRecord(ticket);
      if (!existing) {
        setCustomTicketIdError('Could not find the ticket record.');
        return;
      }

      // Extract initials, year, sequence from the custom ID
      const initialsMatch = trimmed.match(/^([A-Z]+)_/);
      const employeeInitials = initialsMatch ? initialsMatch[1] : ticket.userInitials;
      const numPart = trimmed.replace(/^[A-Z]+_/, '');
      const year = numPart.length >= 2 ? parseInt(numPart.slice(0, 2), 10) : new Date().getFullYear() % 100;
      const sequenceNumber = numPart.length > 2 ? parseInt(numPart.slice(2), 10) : parseInt(numPart, 10);

      // Reserved sequence ranges - these cannot be manually assigned
      // Format: { 'INITIALS': { year: lastReservedSequence } }
      const RESERVED_SEQUENCES: Record<string, Record<number, number>> = {
        'HV': { 26: 49 },  // HV_26001 - HV_26049 are reserved
        'CG': { 26: 19 },  // CG_26001 - CG_26019 are reserved
      };
      const reservedUpTo = RESERVED_SEQUENCES[employeeInitials]?.[year] ?? 0;
      if (sequenceNumber >= 1 && sequenceNumber <= reservedUpTo) {
        setCustomTicketIdError(`Ticket IDs ${employeeInitials}_${year}001 through ${employeeInitials}_${year}${String(reservedUpTo).padStart(3, '0')} are reserved and cannot be assigned.`);
        return;
      }

      // Check unique constraint: (employee_initials, year, sequence_number)
      const { data: existingSeq } = await supabase
        .from(tableName)
        .select('id')
        .eq('employee_initials', employeeInitials)
        .eq('year', year)
        .eq('sequence_number', sequenceNumber)
        .neq('id', existing.id)
        .maybeSingle();
      if (existingSeq) {
        setCustomTicketIdError(`Sequence ${sequenceNumber} for ${employeeInitials} in year ${year} is already taken.`);
        return;
      }

      // Build header overrides for approval snapshot
      const headerOverrides = buildApprovalHeaderOverrides(ticket);
      // Persist hours
      const serviceRowsForApproval = entriesToServiceRows(ticket.entries);
      const legacy = serviceRowsToLegacyFormat(serviceRowsForApproval);
      const rtRate = ticket.rates.rt ?? 0, ttRate = ticket.rates.tt ?? 0, ftRate = ticket.rates.ft ?? 0;
      const shopOtRate = ticket.rates.shop_ot ?? 0, fieldOtRate = ticket.rates.field_ot ?? 0;
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

      await serviceTicketsService.updateTicketNumber(existing.id, trimmed, isDemoMode, user?.id, headerOverrides, approvalHours);

      // Clean up any duplicate draft records since this ticket is now approved
      const isDemoTicket = ticket.entries.length > 0 && ticket.entries.every(entry => entry.is_demo === true);
      await serviceTicketsService.deleteOtherDraftRecordsForTicket(existing.id, isDemoTicket);

      setShowCustomTicketIdModal(false);
      setCustomTicketId('');
      setDisplayTicketNumber(trimmed);
      await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
      await queryClient.refetchQueries({ queryKey: ['existingServiceTickets'] });
    } catch (error) {
      console.error('Error assigning custom ticket ID:', error);
      setCustomTicketIdError(`Failed: ${error instanceof Error ? error.message : String(error)}`);
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
      // Clear sidebar notifications for rejected/resubmitted tickets
      queryClient.invalidateQueries({ queryKey: ['rejectedTicketsCount'] });
      queryClient.invalidateQueries({ queryKey: ['resubmittedTicketsCount'] });
      setSelectedTicketIds(new Set());
    } catch (error) {
      console.error('Error bulk moving to trash:', error);
      alert('Failed to move tickets to trash.');
    }
  };

  // Fetch billable entries (filtered by demo mode)
  // Non-admins only see their own entries; admins get all (employee filter applied in UI only, so overview stays unfiltered)
  const { data: billableEntries, isLoading: isLoadingEntries, error: entriesError } = useQuery({
    queryKey: ['billableEntries', startDate, endDate, selectedCustomerId, isDemoMode, isAdmin, user?.id],
    queryFn: () => serviceTicketsService.getBillableEntries({
      startDate,
      endDate,
      customerId: selectedCustomerId || undefined,
      userId: isAdmin ? undefined : (user?.id ?? undefined),
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

    // Location-agnostic match: date + user + customer + project only (ignores location + PO/AFE)
    // Used as final fallback when user edited location before submitting
    const baseTicketLooseMatchesRecord = (bt: ServiceTicket, rec: (typeof existing)[number]) =>
      bt.date === rec.date &&
      bt.userId === rec.user_id &&
      (rec.customer_id === bt.customerId || (!rec.customer_id && bt.customerId === 'unassigned')) &&
      ((rec.project_id || '') === (bt.projectId || '') || !rec.project_id);

    // --- Claim base tickets for locked records (so they don't appear as drafts) ---
    // Hierarchy: full match (project+location+PO) > core match (project+location) > loose match (project only)
    const claimedBaseTicketIds = new Set<string>();
    const claimedBaseTicketByRecordId = new Map<string, ServiceTicket>();
    for (const rec of lockedRecords) {
      const bt = baseTickets.find(
        b => !claimedBaseTicketIds.has(b.id) && baseTicketFullMatchesRecord(b, rec)
      ) ?? baseTickets.find(
        b => !claimedBaseTicketIds.has(b.id) && baseTicketMatchesRecord(b, rec)
      ) ?? baseTickets.find(
        b => !claimedBaseTicketIds.has(b.id) && baseTicketLooseMatchesRecord(b, rec)
      );
      if (bt) {
        claimedBaseTicketIds.add(bt.id);
        claimedBaseTicketByRecordId.set(rec.id, bt);
      }
    }

    // --- Link draft records to base tickets (1:1, tracked) ---
    // Hierarchy: full match > core match > loose match (project only, for edited locations)
    const usedDraftRecordIds = new Set<string>();
    const findDraftRecordForBaseTicket = (bt: ServiceTicket) => {
      const found = draftRecords.find(
        rec => !usedDraftRecordIds.has(rec.id) && baseTicketFullMatchesRecord(bt, rec)
      ) ?? draftRecords.find(
        rec => !usedDraftRecordIds.has(rec.id) && baseTicketMatchesRecord(bt, rec)
      ) ?? draftRecords.find(
        rec => !usedDraftRecordIds.has(rec.id) && baseTicketLooseMatchesRecord(bt, rec)
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
        approverNotes: (st as any).approver_notes || undefined,
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
          
          // Only include overrides for entries that belong to THIS ticket, plus manual rows (new-*)
          const btEntryIds = new Set(bt.entries.map(e => e.id));
          const relevantOverrideIds = new Set(
            Object.keys(savedOverrides).filter(id => btEntryIds.has(id) || id.startsWith('new-'))
          );
          
          // Sum hours from base entries that are NOT overridden
          bt.entries.forEach(entry => {
            if (!relevantOverrideIds.has(entry.id)) {
              const rateType = entry.rate_type as keyof typeof baseEntryHours;
              if (rateType in baseEntryHours) {
                baseEntryHours[rateType] += entry.hours || 0;
              }
            }
          });
          
          // Sum hours from relevant overrides only (entries in this ticket + manual rows)
          Object.entries(savedOverrides).forEach(([id, ov]) => {
            if (!relevantOverrideIds.has(id)) return; // Skip overrides for entries in other tickets
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

    // All discarded tickets: show every discarded record in trash (including approved tickets that were trashed).
    const discardedRecords = existing.filter(rec => (rec as any).is_discarded === true);
    const discardedTickets = discardedRecords.map(rec => buildLockedTicketFromRecord(rec));

    return [...draftTickets, ...lockedTickets, ...discardedTickets];
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
        queryClient.invalidateQueries({ queryKey: ['serviceTicketExpenseTotals'] });
      }
    },
  });

  const updateExpenseMutation = useMutation({
    mutationFn: ({ id, ...updates }: { id: string } & Parameters<typeof serviceTicketExpensesService.update>[1]) =>
      serviceTicketExpensesService.update(id, updates),
    onSuccess: () => {
      if (currentTicketRecordId) {
        loadExpenses(currentTicketRecordId);
        queryClient.invalidateQueries({ queryKey: ['serviceTicketExpenseTotals'] });
      }
    },
  });

  const deleteExpenseMutation = useMutation({
    mutationFn: (id: string) => serviceTicketExpensesService.delete(id),
    onSuccess: () => {
      if (currentTicketRecordId) {
        loadExpenses(currentTicketRecordId);
        queryClient.invalidateQueries({ queryKey: ['serviceTicketExpenseTotals'] });
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
    // BUT only match draft/rejected/user-submitted records - don't let an admin-approved record match
    const found = matches.find(et => !(et as any).is_discarded) || matches[0] || (() => {
      const fallbackFilter = (et: NonNullable<typeof existingTickets>[number]) => {
        // Allow draft, rejected, or user-submitted (approved but no ticket_number and no admin approval)
        // Don't match admin-approved records with different locations
        const ws = (et.workflow_status || 'draft') as string;
        const hasTicketNumber = !!et.ticket_number;
        const isAdminApproved = !!et.approved_by_admin_id;
        // Locked = has ticket number OR admin has approved it
        const isLocked = hasTicketNumber || isAdminApproved;
        if (isLocked) return false;
        return et.date === ticket.date &&
          et.user_id === ticket.userId &&
          (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned')) &&
          ((et.project_id || '') === (ticket.projectId || '') || !et.project_id);
      };
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

    // Create a draft record (same for admins and non-admins).
    // Admins approve tickets via the explicit Assign ID / Approve action,
    // NOT by simply opening/viewing them.
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

  // Helper: classify a ticket into draft/submitted/approved category
  const classifyTicketStatus = (ticket: any): 'draft' | 'submitted' | 'approved' => {
    const existing = findMatchingTicketRecord(ticket);
    const hasTicketNumber = !!existing?.ticket_number;
    const workflowStatus = existing?.workflow_status || 'draft';
    if (hasTicketNumber) return 'approved';
    const approvedStatuses = ['approved', 'pdf_exported', 'qbo_created', 'sent_to_cnrl', 'cnrl_approved', 'submitted_to_cnrl'];
    if (existing?.approved_by_admin_id && approvedStatuses.includes(workflowStatus)) return 'approved';
    if (workflowStatus === 'draft' || workflowStatus === 'rejected') return 'draft';
    return 'submitted';
  };

  // Admin employee overview: per-employee counts of draft/submitted/approved
  const employeeSummary = useMemo(() => {
    if (!isAdmin) return [];

    // Pre-filter same as filteredTickets but without employee or tab filters
    let pool = ticketsWithNumbers;
    if (startDate) pool = pool.filter(t => t.date >= startDate);
    if (endDate) pool = pool.filter(t => t.date <= endDate);
    pool = pool.filter(t => {
      const existing = findMatchingTicketRecord(t);
      return !(existing as any)?.is_discarded;
    });
    if (selectedCustomerId) pool = pool.filter(t => t.customerId === selectedCustomerId);
    // Hide zero-hour drafts
    pool = pool.filter(t => (t.totalHours ?? 0) > 0 || classifyTicketStatus(t) !== 'draft');

    const map = new Map<string, { userId: string; name: string; draftCount: number; submittedCount: number; submittedNewCount: number; approvedCount: number }>();

    for (const t of pool) {
      const uid = t.userId;
      if (!uid) continue;
      if (!map.has(uid)) {
        const emp = employees?.find((e: any) => e.user_id === uid);
        const name = emp?.user
          ? `${emp.user.first_name || ''} ${emp.user.last_name || ''}`.trim()
          : t.userName || 'Unknown';
        map.set(uid, { userId: uid, name, draftCount: 0, submittedCount: 0, submittedNewCount: 0, approvedCount: 0 });
      }
      const entry = map.get(uid)!;
      const status = classifyTicketStatus(t);
      if (status === 'draft') entry.draftCount++;
      else if (status === 'submitted') {
        entry.submittedCount++;
        const existing = findMatchingTicketRecord(t);
        if (existing?.rejected_at) entry.submittedNewCount++;
      }
      else entry.approvedCount++;
    }

    return Array.from(map.values()).sort((a, b) => {
      // Employees with submitted tickets first, then by name
      if (a.submittedCount > 0 && b.submittedCount === 0) return -1;
      if (a.submittedCount === 0 && b.submittedCount > 0) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [isAdmin, ticketsWithNumbers, startDate, endDate, selectedCustomerId, employees, showDiscarded]);

  // Tickets for the expanded employee's inline view
  const expandedEmployeeTicketsByStatus = useMemo(() => {
    const empty = { draft: [] as any[], submitted: [] as any[], approved: [] as any[] };
    if (!expandedEmployeeId || !isAdmin) return empty;
    let pool = ticketsWithNumbers;
    if (startDate) pool = pool.filter(t => t.date >= startDate);
    if (endDate) pool = pool.filter(t => t.date <= endDate);
    pool = pool.filter(t => {
      const existing = findMatchingTicketRecord(t);
      return !(existing as any)?.is_discarded;
    });
    if (selectedCustomerId) pool = pool.filter(t => t.customerId === selectedCustomerId);
    pool = pool.filter(t => t.userId === expandedEmployeeId);
    pool = pool.filter(t => (t.totalHours ?? 0) > 0 || classifyTicketStatus(t) !== 'draft');

    const grouped = { draft: [] as any[], submitted: [] as any[], approved: [] as any[] };
    for (const t of pool) {
      grouped[classifyTicketStatus(t)].push(t);
    }
    const getTicketSortKey = (t: any) => {
      const rec = findMatchingTicketRecord(t);
      const seq = (rec as { sequence_number?: number })?.sequence_number;
      if (seq != null) return seq;
      const ticket = t.displayTicketNumber || t.ticketNumber || '';
      const m = (ticket || '').match(/(\d+)$/);
      return m ? parseInt(m[1], 10) : 0;
    };
    const sortByTicketNumberDesc = (a: any, b: any) => getTicketSortKey(b) - getTicketSortKey(a);
    grouped.draft.sort(sortByTicketNumberDesc);
    grouped.submitted.sort(sortByTicketNumberDesc);
    grouped.approved.sort(sortByTicketNumberDesc);
    return grouped;
  }, [expandedEmployeeId, isAdmin, ticketsWithNumbers, startDate, endDate, selectedCustomerId, existingTickets]);

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

    // Search filter (admin only) - matches ticket ID, customer, project, employee, date, work description
    if (isAdmin && searchTerm.trim()) {
      const term = searchTerm.trim().toLowerCase();
      result = result.filter((t) => {
        const ticketId = (t.displayTicketNumber || t.ticketNumber || '').toLowerCase();
        const customer = (t.customerName || '').toLowerCase();
        const project = ((t.projectName || '') + ' ' + (t.projectNumber || '')).toLowerCase();
        const employee = (t.userName || '').toLowerCase();
        const dateStr = formatDateOnlyLocal(t.date).toLowerCase();
        const workDesc = (t.entries || []).map((e: any) => (e.description || '').toLowerCase()).join(' ');
        return ticketId.includes(term) || customer.includes(term) || project.includes(term) || employee.includes(term) || dateStr.includes(term) || workDesc.includes(term);
      });
    }

    // Filter by employee (admin only)
    // When employee overview is expanded to a specific employee, use that; otherwise use dropdown
    if (isAdmin && expandedEmployeeId) {
      result = result.filter(t => t.userId === expandedEmployeeId);
    } else if (isAdmin && selectedUserId) {
      result = result.filter(t => t.userId === selectedUserId);
    }
    
    // Filter by Tab (Status Group) - skip when viewing trash
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
          // Exclude admin-approved tickets with unassigned IDs (those stay on the Approved tab)
          if (existing?.approved_by_admin_id) return false;
          return !hasTicketNumber && workflowStatus !== 'draft' && workflowStatus !== 'rejected';
        } else if (activeTab === 'approved') {
          // Non-admins: only show tickets with a ticket number (fully approved by admin)
          if (!isAdmin) return hasTicketNumber;
          // Admins: ticket number assigned, OR admin-approved (workflow beyond draft/submitted stages) even if ID temporarily unassigned
          if (hasTicketNumber) return true;
          // Keep tickets visible on approved tab when ID is unassigned but workflow is still in an approved state
          const approvedStatuses = ['approved', 'pdf_exported', 'qbo_created', 'sent_to_cnrl', 'cnrl_approved', 'submitted_to_cnrl'];
          return !!existing?.approved_by_admin_id && approvedStatuses.includes(workflowStatus);
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

      // Admin: show admin's own tickets first
      if (isAdmin && user?.id) {
        const aIsAdmin = a.userId === user.id;
        const bIsAdmin = b.userId === user.id;
        if (aIsAdmin && !bIsAdmin) return -1;
        if (!aIsAdmin && bIsAdmin) return 1;
      }

      // Draft tab: rejected tickets always at top (after restored)
      if (activeTab === 'draft' && !showDiscarded) {
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
  }, [ticketsWithNumbers, selectedCustomerId, selectedUserId, activeTab, existingTickets, sortField, sortDirection, isAdmin, user?.id, showDiscarded, startDate, endDate, expandedEmployeeId, searchTerm]);

  // Ticket record IDs for expense totals query (only tickets that have a DB record)
  const ticketRecordIdsForExpenseTotals = useMemo(() => {
    return [...new Set(
      filteredTickets
        .map(t => findMatchingTicketRecord(t)?.id)
        .filter((id): id is string => !!id)
    )];
  }, [filteredTickets, existingTickets]);

  const { data: expenseTotalsByRecordId = {} } = useQuery({
    queryKey: ['serviceTicketExpenseTotals', [...ticketRecordIdsForExpenseTotals].sort().join(',')],
    queryFn: () => serviceTicketExpensesService.getExpenseTotalsByTicketIds(ticketRecordIdsForExpenseTotals),
    enabled: ticketRecordIdsForExpenseTotals.length > 0,
  });

  // Unapplied billable receipts for the ticket owner (not the viewing admin)
  const ticketOwnerUserId = selectedTicket?.userId;
  const { data: unappliedBillableReceipts = [] } = useQuery({
    queryKey: ['unappliedBillableReceipts', ticketOwnerUserId],
    queryFn: () => userExpensesService.getUnappliedBillable(ticketOwnerUserId),
    enabled: !!selectedTicketId && !!ticketOwnerUserId,
  });

  // Receipts attached to the currently open ticket
  const { data: attachedReceipts = [] } = useQuery({
    queryKey: ['attachedReceipts', currentTicketRecordId],
    queryFn: () => userExpensesService.getByServiceTicketId(currentTicketRecordId!),
    enabled: !!currentTicketRecordId,
  });

  // Editing an attached receipt from the service ticket
  const [editingReceipt, setEditingReceipt] = useState<any>(null);
  const [editReceiptForm, setEditReceiptForm] = useState({ description: '', amount: '', gst: '' });
  const [isSavingReceipt, setIsSavingReceipt] = useState(false);
  const [editReceiptPreviewUrl, setEditReceiptPreviewUrl] = useState<string | null>(null);
  const [editReceiptPreviewIsPdf, setEditReceiptPreviewIsPdf] = useState(false);

  // Live expense total for the selected ticket (panel open: includes unsaved adds, excludes pending deletes)
  const liveExpenseTotalForSelected = useMemo(() => {
    if (!selectedTicketId) return 0;
    const fromExpenses = expenses
      .filter(e => !(e.id && pendingDeleteExpenseIds.has(e.id)))
      .reduce((sum, e) => sum + (Number(e.quantity) || 0) * (Number(e.rate) || 0), 0);
    const fromPending = pendingAddExpenses.reduce((sum, e) => sum + (Number(e.quantity) || 0) * (Number(e.rate) || 0), 0);
    return fromExpenses + fromPending;
  }, [selectedTicketId, expenses, pendingDeleteExpenseIds, pendingAddExpenses]);

  // Totals for hours columns and expense (admin-only footer)
  const tableFooterTotals = useMemo(() => {
    let totalHours = 0;
    let st = 0, tt = 0, ft = 0, so = 0, fo = 0;
    let expenseTotal = 0;
    filteredTickets.forEach((ticket) => {
      if (ticket.id === selectedTicketId && liveHoursForSelectedTicket) {
        totalHours += liveHoursForSelectedTicket.total;
        st += liveHoursForSelectedTicket.st;
        tt += liveHoursForSelectedTicket.tt;
        ft += liveHoursForSelectedTicket.ft;
        so += liveHoursForSelectedTicket.so;
        fo += liveHoursForSelectedTicket.fo;
        expenseTotal += liveExpenseTotalForSelected;
      } else {
        totalHours += ticket.totalHours ?? 0;
        st += ticket.hoursByRateType['Shop Time'] ?? 0;
        tt += ticket.hoursByRateType['Travel Time'] ?? 0;
        ft += ticket.hoursByRateType['Field Time'] ?? 0;
        so += ticket.hoursByRateType['Shop Overtime'] ?? 0;
        fo += ticket.hoursByRateType['Field Overtime'] ?? 0;
        const record = findMatchingTicketRecord(ticket);
        expenseTotal += (record?.id && expenseTotalsByRecordId[record.id]) ?? 0;
      }
    });
    return { totalHours, st, tt, ft, so, fo, expenseTotal };
  }, [filteredTickets, selectedTicketId, liveHoursForSelectedTicket, liveExpenseTotalForSelected, expenseTotalsByRecordId]);

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
        // Check if entries are actually different (not just reordered) by comparing sorted IDs
        const selectedIds = [...selectedTicket.entries].map(e => e.id).sort().join(',');
        const freshIds = [...freshTicket.entries].map(e => e.id).sort().join(',');
        const entriesChanged = selectedIds !== freshIds;
        setSelectedTicket(freshTicket);
        // Only rebuild serviceRows if entries actually changed (added/removed), not just reordered
        // This prevents the modal rows from flipping order when filteredTickets updates
        if (entriesChanged) {
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

  const openTicketPanel = async (ticket: ServiceTicket & { displayTicketNumber?: string }) => {
    const existingRecord = findMatchingTicketRecord(ticket);
    const isAdminApproved = !!existingRecord?.ticket_number;
    const ws = (existingRecord as { workflow_status?: string })?.workflow_status;
    const isFrozen = isAdminApproved || (ws && !['draft', 'rejected'].includes(ws));
    const isDiscardedTicket = !!(existingRecord as any)?.is_discarded;
    const isUserSubmitted = !isAdminApproved && ws === 'approved';
    setIsLockedForEditing(isDiscardedTicket || (isAdminApproved && !isAdmin) || (isUserSubmitted && !isAdmin));

    setCurrentTicketRecordId(existingRecord?.id || null);

    setSelectedTicket(ticket);
    setPendingDeleteExpenseIds(new Set());
    setPendingAddExpenses([]);
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
      approverNotes: ticket.approverNotes || '',
    };
    {
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
    }

    setDisplayTicketNumber(ticket.displayTicketNumber || '');

    const initialRows = entriesToServiceRows(ticket.entries);
    originalTimeEntryRowsRef.current = initialRows.map(r => ({ ...r }));
    setServiceRows(initialRows);
    initialServiceRowsRef.current = initialRows.map(r => ({ ...r }));
    setEditedEntryOverrides({});

    try {
      const hadNoRecord = !findMatchingTicketRecord(ticket);
      const ticketRecordId = await getOrCreateTicketRecord(ticket);
      setCurrentTicketRecordId(ticketRecordId);
      if (hadNoRecord) {
        queryClient.invalidateQueries({
          queryKey: ['existingServiceTickets', isDemoMode],
          refetchType: 'none',
        });
      }
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

      const ov = (ticketRecord?.header_overrides as Record<string, string | number> | null) ?? {};
      const hasApprovedTicketNumber = !!existingRecord?.ticket_number;
      const entryMaxUpdated = ticket.entries?.length
        ? Math.max(...ticket.entries.map((e) => e.updated_at ? new Date(e.updated_at).getTime() : 0))
        : 0;
      const ticketUpdated = ticketRecord?.updated_at ? new Date(ticketRecord.updated_at).getTime() : 0;
      const useEntryValues = !hasApprovedTicketNumber && (entryMaxUpdated > ticketUpdated);

      const useOverride = (ovVal: string | number | undefined, fallback: string) => {
        const s = (ovVal != null ? String(ovVal).trim() : '');
        return (s !== '' && s !== '_') ? s : fallback;
      };
      let merged: typeof initialEditable;
      if (isFrozen || Object.keys(ov).length > 0) {
        const ovApprover = ('approver' in ov) ? String(ov.approver ?? '').trim() : initialEditable.approver;
        const ovPoAfe = ('po_afe' in ov) ? String(ov.po_afe ?? '').trim() : initialEditable.poAfe;
        const ovCc = ('cc' in ov) ? String(ov.cc ?? '').trim() : initialEditable.cc;
        const ovOther = ('other' in ov) ? String(ov.other ?? '').trim() : initialEditable.other;
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
          approverNotes: initialEditable.approverNotes,
        };
      } else {
        merged = initialEditable;
      }
      setEditableTicket(merged);
      initialEditableTicketRef.current = { ...merged };

      if (isFrozen && ov && (typeof ov.rate_rt === 'number' || typeof ov.rate_tt === 'number' || typeof ov.rate_ft === 'number')) {
        const displayTicket = applyHeaderOverridesToTicket(ticket, ov);
        setSelectedTicket(displayTicket);
      }

      const savedOverrides = (ticketRecord?.edited_entry_overrides as Record<string, EntryOverride> | null) ?? {};
      const ticketEntryIds = new Set(ticket.entries.map(e => e.id));
      const relevantOverrides: Record<string, EntryOverride> = {};
      Object.entries(savedOverrides).forEach(([id, ov]) => {
        if (ticketEntryIds.has(id) || id.startsWith('new-')) {
          relevantOverrides[id] = ov;
        }
      });
      const hasPerEntryOverrides = Object.keys(relevantOverrides).length > 0;

      if (hasPerEntryOverrides && !hasApprovedTicketNumber) {
        const mergedRows = buildRowsWithOverrides(ticket.entries, relevantOverrides);
        setServiceRows(mergedRows);
        initialServiceRowsRef.current = mergedRows.map(r => ({ ...r }));
        setEditedEntryOverrides(relevantOverrides);
        setIsTicketEdited(true);
        const legacy = serviceRowsToLegacyFormat(mergedRows);
        setEditedDescriptions(legacy.descriptions);
        setEditedHours(legacy.hours);
      } else {
        const loadedDescriptions = (ticketRecord?.edited_descriptions as Record<string, string[]>) || {};
        const loadedHours = (ticketRecord?.edited_hours as Record<string, number | number[]>) || {};
        const hasLegacyData = Object.keys(loadedDescriptions).length > 0 || Object.keys(loadedHours).length > 0;
        const shouldUseSnapshot = hasLegacyData && (ticketRecord?.is_edited || isFrozen);

        if (shouldUseSnapshot) {
          // Reconstruct rows preserving ticket.entries order (created_at) so "Travel" stays above "Project"
          // Legacy format stores by rate type; we consume in entry order to preserve layout
          const loadedRows: ServiceRow[] = [];
          if (ticket.entries.length > 0 && Object.keys(loadedDescriptions).length > 0) {
            const descQueues: Record<string, string[]> = {};
            const hoursQueues: Record<string, number[]> = {};
            for (const rt of ['Shop Time', 'Travel Time', 'Field Time', 'Shop Overtime', 'Field Overtime']) {
              const descs = loadedDescriptions[rt] || [];
              const hrs = loadedHours[rt];
              descQueues[rt] = [...descs];
              hoursQueues[rt] = Array.isArray(hrs) ? [...hrs] : (hrs !== undefined ? [hrs as number] : []);
            }
            for (let i = 0; i < ticket.entries.length; i++) {
              const entry = ticket.entries[i];
              const rateType = (entry.rate_type || 'Shop Time') as keyof typeof descQueues;
              const desc = descQueues[rateType]?.shift() ?? '';
              const hours = hoursQueues[rateType]?.shift() ?? 0;
              const id = entry.id || `entry-${i}`;
              loadedRows.push({
                id,
                description: desc,
                st: rateType === 'Shop Time' ? hours : 0,
                tt: rateType === 'Travel Time' ? hours : 0,
                ft: rateType === 'Field Time' ? hours : 0,
                so: rateType === 'Shop Overtime' ? hours : 0,
                fo: rateType === 'Field Overtime' ? hours : 0,
              });
            }
            // Append any leftover rows (manual adds, or legacy entries not in ticket.entries)
            for (const rt of ['Shop Time', 'Travel Time', 'Field Time', 'Shop Overtime', 'Field Overtime']) {
              const descs = descQueues[rt];
              const hrs = hoursQueues[rt];
              if (descs && hrs) {
                for (let j = 0; j < descs.length; j++) {
                  const hours = hrs[j] ?? 0;
                  loadedRows.push({
                    id: `legacy-${rt}-${j}`,
                    description: descs[j] ?? '',
                    st: rt === 'Shop Time' ? hours : 0,
                    tt: rt === 'Travel Time' ? hours : 0,
                    ft: rt === 'Field Time' ? hours : 0,
                    so: rt === 'Shop Overtime' ? hours : 0,
                    fo: rt === 'Field Overtime' ? hours : 0,
                  });
                }
              }
            }
          } else if (Object.keys(loadedDescriptions).length > 0) {
            let rowIndex = 0;
            Object.keys(loadedDescriptions).forEach(rateType => {
              const descs = loadedDescriptions[rateType] || [];
              const hrs = loadedHours[rateType];
              const hoursArray = Array.isArray(hrs) ? hrs : (hrs !== undefined ? [hrs as number] : []);
              descs.forEach((desc, i) => {
                const hours = hoursArray[i] || 0;
                loadedRows.push({
                  id: `legacy-${rowIndex++}`,
                  description: desc,
                  st: rateType === 'Shop Time' ? hours : 0,
                  tt: rateType === 'Travel Time' ? hours : 0,
                  ft: rateType === 'Field Time' ? hours : 0,
                  so: rateType === 'Shop Overtime' ? hours : 0,
                  fo: rateType === 'Field Overtime' ? hours : 0,
                });
              });
            });
          } else if (Object.keys(loadedHours).length > 0) {
            let rowIndex = 0;
            Object.keys(loadedHours).forEach(rateType => {
              const hrs = loadedHours[rateType];
              const hoursArray = Array.isArray(hrs) ? hrs : (hrs !== undefined ? [hrs as number] : []);
              hoursArray.forEach((hours) => {
                if (hours > 0) {
                  loadedRows.push({
                    id: `legacy-${rateType}-${rowIndex++}`,
                    description: '',
                    st: rateType === 'Shop Time' ? hours : 0,
                    tt: rateType === 'Travel Time' ? hours : 0,
                    ft: rateType === 'Field Time' ? hours : 0,
                    so: rateType === 'Shop Overtime' ? hours : 0,
                    fo: rateType === 'Field Overtime' ? hours : 0,
                  });
                }
              });
            });
          }
          if (loadedRows.length > 0) {
            setServiceRows(loadedRows);
            initialServiceRowsRef.current = loadedRows.map(r => ({ ...r }));
            if (!ticketRecord?.is_edited) {
              originalTimeEntryRowsRef.current = loadedRows.map(r => ({ ...r }));
            }
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
            setIsTicketEdited(false);
            const rows = entriesToServiceRows(ticket.entries);
            setServiceRows(rows);
            initialServiceRowsRef.current = rows.map(r => ({ ...r }));
            setEditedDescriptions({});
            setEditedHours({});
            setEditedEntryOverrides({});
          }
        } else {
          setIsTicketEdited(false);
          const rows = entriesToServiceRows(ticket.entries);
          setServiceRows(rows);
          initialServiceRowsRef.current = rows.map(r => ({ ...r }));
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
              The tickets will be removed from the database. Time entries are preserved. This cannot be undone.
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
          {isAdmin && (
            <div>
              <label className="label">Employee</label>
              <SearchableSelect
                options={employees?.map((emp: any) => ({
                  value: emp.user_id,
                  label: [emp.user?.first_name, emp.user?.last_name].filter(Boolean).join(' ') || emp.user?.email || emp.user_id || 'Unknown',
                })) || []}
                value={selectedUserId}
                onChange={(value) => setSelectedUserId(value)}
                placeholder="Search employees..."
                emptyOption={{ value: '', label: 'All Employees' }}
              />
            </div>
          )}
          {isAdmin && (
            <div>
              <label className="label">Search</label>
              <input
                type="text"
                className="input"
                placeholder="Ticket, customer, project, employee..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
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

      {/* Admin Employee Overview Panel */}
      {isAdmin && !showDiscarded && (
        <div style={{ marginBottom: '20px' }}>
          <button
            onClick={() => {
              setShowEmployeeOverview(!showEmployeeOverview);
              if (showEmployeeOverview) setExpandedEmployeeId(null);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 16px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: '600',
              color: 'var(--text-primary)',
              marginBottom: showEmployeeOverview ? '8px' : '0',
            }}
          >
            <span style={{
              display: 'inline-block',
              transition: 'transform 0.2s ease',
              transform: showEmployeeOverview ? 'rotate(90deg)' : 'rotate(0deg)',
              fontSize: '12px',
            }}>&#9654;</span>
            Employee Overview
            <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', fontWeight: '400' }}>
              ({employeeSummary.length} employee{employeeSummary.length !== 1 ? 's' : ''})
            </span>
            {(() => {
              const totalSubmitted = employeeSummary.reduce((s, e) => s + e.submittedCount, 0);
              if (totalSubmitted === 0) return null;
              return (
                <span style={{
                  marginLeft: '4px',
                  padding: '2px 8px',
                  borderRadius: '10px',
                  fontSize: '11px',
                  fontWeight: '700',
                  backgroundColor: '#ff9800',
                  color: 'white',
                }}>{totalSubmitted} pending</span>
              );
            })()}
          </button>

          {showEmployeeOverview && (
            <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
                    <th style={{ padding: '14px 16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Employee</th>
                    <th style={{ padding: '14px 16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', width: '100px' }}>Drafts</th>
                    <th style={{ padding: '14px 16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: '#ff9800', textTransform: 'uppercase', width: '160px' }}>Submitted</th>
                    <th style={{ padding: '14px 16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: '#4caf50', textTransform: 'uppercase', width: '100px' }}>Approved</th>
                  </tr>
                </thead>
                <tbody>
                  {employeeSummary.map((emp) => {
                    const isExpanded = expandedEmployeeId === emp.userId;
                    return (
                      <Fragment key={emp.userId}>
                        <tr
                          onClick={() => setExpandedEmployeeId(isExpanded ? null : emp.userId)}
                          style={{
                            borderBottom: '1px solid var(--border-color)',
                            cursor: 'pointer',
                            backgroundColor: isExpanded ? 'rgba(59, 130, 246, 0.06)' : 'transparent',
                            transition: 'background-color 0.15s ease',
                          }}
                          onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.backgroundColor = 'var(--bg-secondary)'; }}
                          onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.backgroundColor = 'transparent'; }}
                        >
                          <td style={{ padding: '14px 16px', fontSize: '14px', fontWeight: '500', color: 'var(--text-primary)' }}>
                            <span style={{
                              display: 'inline-block',
                              marginRight: '8px',
                              fontSize: '10px',
                              color: 'var(--text-tertiary)',
                              transition: 'transform 0.2s ease',
                              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                            }}>&#9654;</span>
                            {emp.name}
                          </td>
                          <td style={{ padding: '14px 16px', textAlign: 'center', fontSize: '14px', fontFamily: 'monospace' }}>
                            <span style={{ color: emp.draftCount > 0 ? '#6b7280' : 'var(--text-tertiary)' }}>{emp.draftCount}</span>
                          </td>
                          <td style={{ padding: '14px 16px', textAlign: 'center', fontSize: '14px', fontFamily: 'monospace' }}>
                            <span style={{ color: emp.submittedCount > 0 ? '#ff9800' : 'var(--text-tertiary)', fontWeight: emp.submittedCount > 0 ? '700' : '400' }}>
                              {emp.submittedCount}
                            </span>
                            {emp.submittedNewCount > 0 && (
                              <span style={{
                                marginLeft: '6px',
                                padding: '1px 6px',
                                borderRadius: '8px',
                                fontSize: '10px',
                                fontWeight: '700',
                                backgroundColor: '#ff9800',
                                color: 'white',
                                whiteSpace: 'nowrap',
                              }}>{emp.submittedNewCount} resubmitted</span>
                            )}
                          </td>
                          <td style={{ padding: '14px 16px', textAlign: 'center', fontSize: '14px', fontFamily: 'monospace' }}>
                            <span style={{ color: emp.approvedCount > 0 ? '#4caf50' : 'var(--text-tertiary)' }}>{emp.approvedCount}</span>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={4} style={{ padding: '0' }}>
                              <div style={{ backgroundColor: 'var(--bg-secondary)', borderBottom: '2px solid var(--border-color)', padding: '4px 0' }}>
                                {([
                                  { key: 'draft', label: 'Drafts', color: '#6b7280', tickets: expandedEmployeeTicketsByStatus.draft },
                                  { key: 'submitted', label: 'Submitted', color: '#ff9800', tickets: expandedEmployeeTicketsByStatus.submitted },
                                  { key: 'approved', label: 'Approved', color: '#4caf50', tickets: expandedEmployeeTicketsByStatus.approved },
                                ] as const).map(section => {
                                  const sectionOpen = expandedStatusSections[emp.userId]?.has(section.key) || false;
                                  return (
                                    <div key={section.key}>
                                      <button
                                        onClick={(e) => { e.stopPropagation(); toggleStatusSection(emp.userId, section.key); }}
                                        style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: '8px',
                                          width: '100%',
                                          padding: '8px 16px 8px 32px',
                                          background: 'none',
                                          border: 'none',
                                          cursor: 'pointer',
                                          fontSize: '13px',
                                          fontWeight: '600',
                                          color: section.color,
                                          textAlign: 'left',
                                        }}
                                        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.03)'; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                                      >
                                        <span style={{
                                          display: 'inline-block',
                                          fontSize: '9px',
                                          transition: 'transform 0.2s ease',
                                          transform: sectionOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                                        }}>&#9654;</span>
                                        {section.label}
                                        <span style={{
                                          padding: '1px 7px',
                                          borderRadius: '8px',
                                          fontSize: '11px',
                                          fontWeight: '700',
                                          backgroundColor: section.tickets.length > 0 ? `${section.color}18` : 'transparent',
                                          color: section.tickets.length > 0 ? section.color : 'var(--text-tertiary)',
                                        }}>{section.tickets.length}</span>
                                      </button>
                                      {sectionOpen && section.tickets.length > 0 && (
                                        <div style={{ paddingBottom: '4px' }}>
                                          {section.tickets.map((t: any) => {
                                            const existing = findMatchingTicketRecord(t);
                                            const wfStatus = existing?.workflow_status || 'draft';
                                            const isRejected = wfStatus === 'rejected';
                                            const workDesc = (t.entries || [])
                                              .map((e: any) => e.description?.trim())
                                              .filter(Boolean)[0] || '';
                                            const displayDesc = workDesc.length > 80 ? workDesc.slice(0, 77) + '…' : workDesc;
                                            return (
                                              <div
                                                key={t.date + t.userId + t.customerId + t.projectId}
                                                onClick={(e) => { e.stopPropagation(); openTicketPanel(t); }}
                                                style={{
                                                  display: 'grid',
                                                  gridTemplateColumns: '140px 100px 1fr minmax(140px, 2fr) 70px',
                                                  gap: '8px',
                                                  padding: '10px 16px 10px 52px',
                                                  cursor: 'pointer',
                                                  fontSize: '13px',
                                                  alignItems: 'center',
                                                  borderTop: '1px solid var(--border-color)',
                                                }}
                                                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(59, 130, 246, 0.04)'; }}
                                                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                                              >
                                                <span style={{ fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                                                  {t.displayTicketNumber || '—'}
                                                  {isRejected && <span style={{ marginLeft: '6px', fontSize: '10px', color: '#ef5350', fontWeight: '600' }}>Rejected</span>}
                                                </span>
                                                <span style={{ color: 'var(--text-primary)' }}>{t.date}</span>
                                                <span style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                  {t.customerName || '—'}
                                                </span>
                                                <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px' }} title={workDesc || undefined}>
                                                  {displayDesc || '—'}
                                                </span>
                                                <span style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--text-primary)' }}>
                                                  {(t.totalHours ?? 0).toFixed(1)}h
                                                </span>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      )}
                                      {sectionOpen && section.tickets.length === 0 && (
                                        <div style={{ padding: '4px 16px 8px 52px', fontSize: '12px', color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                                          No {section.label.toLowerCase()} tickets
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
                    <td style={{ padding: '14px 16px', fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)' }}>Totals</td>
                    <td style={{ padding: '14px 16px', textAlign: 'center', fontSize: '14px', fontFamily: 'monospace', fontWeight: '700', color: '#6b7280' }}>
                      {employeeSummary.reduce((s, e) => s + e.draftCount, 0)}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'center', fontSize: '14px', fontFamily: 'monospace', fontWeight: '700', color: '#ff9800' }}>
                      {employeeSummary.reduce((s, e) => s + e.submittedCount, 0)}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'center', fontSize: '14px', fontFamily: 'monospace', fontWeight: '700', color: '#4caf50' }}>
                      {employeeSummary.reduce((s, e) => s + e.approvedCount, 0)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Status Tabs — under Employee Overview for admin, standalone for non-admin */}
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
              ) : activeTab === 'submitted' || activeTab === 'draft' ? (
                <>
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
              ) : (
                <>
                  {/* Approved tab: Unassign/Assign ID buttons */}
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
                    ✗ Unassign ID
                  </button>
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
                    ✓ Assign ID
                  </button>
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
                  style={{ padding: '16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', cursor: 'pointer', userSelect: 'none' }}
                >
                  Total Hours {effectiveSortField === 'totalHours' && (effectiveSortDirection === 'asc' ? '▲' : '▼')}
                </th>
                <th style={{ padding: '16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  ST
                </th>
                <th style={{ padding: '16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  TT
                </th>
                <th style={{ padding: '16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  FT
                </th>
                <th style={{ padding: '16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  SO
                </th>
                <th style={{ padding: '16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  FO
                </th>
                <th style={{ padding: '16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  Expenses
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
                const handleRowClick = () => openTicketPanel(ticket);

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
                  <td style={{ padding: '16px', textAlign: 'center', color: 'var(--text-primary)', fontWeight: '600' }}>
                    {(() => {
                      // When this ticket is selected, show live total from service rows
                      if (selectedTicketId === ticket.id && liveHoursForSelectedTicket) {
                        return liveHoursForSelectedTicket.total.toFixed(2);
                      }
                      return ticket.totalHours.toFixed(2);
                    })()}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {(() => {
                      if (selectedTicketId === ticket.id && liveHoursForSelectedTicket) {
                        return liveHoursForSelectedTicket.st.toFixed(2);
                      }
                      return ticket.hoursByRateType['Shop Time'].toFixed(2);
                    })()}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {(() => {
                      if (selectedTicketId === ticket.id && liveHoursForSelectedTicket) {
                        return liveHoursForSelectedTicket.tt.toFixed(2);
                      }
                      return ticket.hoursByRateType['Travel Time'].toFixed(2);
                    })()}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {(() => {
                      if (selectedTicketId === ticket.id && liveHoursForSelectedTicket) {
                        return liveHoursForSelectedTicket.ft.toFixed(2);
                      }
                      return ticket.hoursByRateType['Field Time'].toFixed(2);
                    })()}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {(() => {
                      if (selectedTicketId === ticket.id && liveHoursForSelectedTicket) {
                        return liveHoursForSelectedTicket.so.toFixed(2);
                      }
                      return ticket.hoursByRateType['Shop Overtime'].toFixed(2);
                    })()}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {(() => {
                      if (selectedTicketId === ticket.id && liveHoursForSelectedTicket) {
                        return liveHoursForSelectedTicket.fo.toFixed(2);
                      }
                      return ticket.hoursByRateType['Field Overtime'].toFixed(2);
                    })()}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {selectedTicketId === ticket.id
                      ? `$${liveExpenseTotalForSelected.toFixed(2)}`
                      : `$${((findMatchingTicketRecord(ticket)?.id && expenseTotalsByRecordId[findMatchingTicketRecord(ticket)!.id]) ?? 0).toFixed(2)}`}
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
                        // States: has ticket# (fully approved), admin-approved but ID unassigned, user-submitted, draft
                        const isAdminApprovedNoId = !hasTicketNumber && isWorkflowApproved && !!existing?.approved_by_admin_id;
                        const isUserSubmitted = !hasTicketNumber && isWorkflowApproved && !existing?.approved_by_admin_id;
                        if (hasTicketNumber) {
                          return (
                            <button
                              className="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setTicketForRejectModal(ticket);
                                setRejectModalMode('unapprove');
                                setRejectNote('');
                                setShowRejectNoteModal(true);
                              }}
                              style={{
                                padding: '6px 16px',
                                fontSize: '13px',
                                backgroundColor: '#10b981',
                                color: 'white',
                                border: 'none',
                                cursor: 'pointer',
                              }}
                              title="Click to unapprove and send back to drafts"
                            >
                              ✓ Approved
                            </button>
                          );
                        } else if (isAdminApprovedNoId) {
                          // Admin approved but ticket ID was unassigned - click to assign a new ID
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
                                backgroundColor: '#10b981',
                                color: 'white',
                                border: 'none',
                                cursor: 'pointer',
                                opacity: 0.85,
                              }}
                              title="Admin approved - click to assign ticket ID"
                            >
                              ✓ Admin Approved
                            </button>
                          );
                        } else if (isUserSubmitted) {
                          // User has submitted but no admin approval yet - same look as bulk Approve
                          return (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleAssignTicketNumber(ticket);
                              }}
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
                              title="User submitted - click to assign ticket ID"
                            >
                              ✓ Approve
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
                                    // Clear per-entry overrides when submitting to prevent stale IDs from
                                    // causing duplicate rows if ticket is rejected and reopened
                                    edited_entry_overrides: null,
                                    is_edited: false,
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
            {isAdmin && filteredTickets.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
                  {isAdmin && <td style={{ padding: '12px 16px', width: '50px' }}> </td>}
                  <td style={{ padding: '12px 16px', fontWeight: '600', color: 'var(--text-secondary)' }}>Total</td>
                  <td colSpan={3} style={{ padding: '12px 16px' }} />
                  <td style={{ padding: '12px 16px', textAlign: 'center', fontWeight: '700', color: 'var(--text-primary)' }}>
                    {tableFooterTotals.totalHours.toFixed(2)}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'center', fontWeight: '600', color: 'var(--text-secondary)' }}>
                    {tableFooterTotals.st.toFixed(2)}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'center', fontWeight: '600', color: 'var(--text-secondary)' }}>
                    {tableFooterTotals.tt.toFixed(2)}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'center', fontWeight: '600', color: 'var(--text-secondary)' }}>
                    {tableFooterTotals.ft.toFixed(2)}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'center', fontWeight: '600', color: 'var(--text-secondary)' }}>
                    {tableFooterTotals.so.toFixed(2)}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'center', fontWeight: '600', color: 'var(--text-secondary)' }}>
                    {tableFooterTotals.fo.toFixed(2)}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'center', fontWeight: '600', color: 'var(--text-secondary)' }}>
                    ${tableFooterTotals.expenseTotal.toFixed(2)}
                  </td>
                  <td style={{ padding: '12px 16px' }} />
                  {isAdmin && !showDiscarded && activeTab === 'approved' && <td style={{ padding: '12px 16px' }} />}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        </>
      )}

      {/* Reject / Unapprove with notes modal (admin) - outside panel so it works from row click without opening ticket */}
      {showRejectNoteModal && (ticketForRejectModal || selectedTicket) && (
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
          onClick={() => { setShowRejectNoteModal(false); setTicketForRejectModal(null); }}
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
              {rejectModalMode === 'unapprove' ? 'Unapprove this ticket?' : 'Reject this ticket?'}
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
                onClick={() => { setShowRejectNoteModal(false); setTicketForRejectModal(null); }}
                style={{ padding: '8px 16px' }}
              >
                Cancel
              </button>
              <button
                className="button"
                disabled={isApproving}
                onClick={async () => {
                  const ticket = ticketForRejectModal ?? selectedTicket!;
                  setIsApproving(true);
                  try {
                    // For unapprove from row: locked tickets use record id as ticket.id; prefer it so we update the correct record
                    let recordId = rejectModalMode === 'unapprove' && ticket.id
                      ? ticket.id
                      : (currentTicketRecordId
                          || (ticket as { _matchedRecordId?: string })?._matchedRecordId
                          || findMatchingTicketRecord(ticket)?.id);
                    if (!recordId) {
                      const billingKey = ticket.id ? getTicketBillingKeyLocal(ticket.id) : '_::_::_';
                      const record = await serviceTicketsService.getOrCreateTicket({
                        date: ticket.date,
                        userId: ticket.userId,
                        customerId: ticket.customerId === 'unassigned' ? null : ticket.customerId,
                        projectId: ticket.projectId,
                        location: ticket.location || '',
                        billingKey,
                      }, isDemoMode);
                      recordId = record.id;
                    }
                    const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
                    // Check if ticket has any backing time entries - if not, auto-discard
                    // to prevent orphaned rejected notifications
                    const hasNoBackingEntries = !ticket.entries || ticket.entries.length === 0;
                    if (rejectModalMode === 'unapprove') {
                      const { error } = await supabase.from(tableName).update({
                        ticket_number: null,
                        sequence_number: null,
                        year: null,
                        workflow_status: hasNoBackingEntries ? 'draft' : 'rejected',
                        rejected_at: hasNoBackingEntries ? null : new Date().toISOString(),
                        rejection_notes: hasNoBackingEntries ? null : (rejectNote.trim() || null),
                        approved_by_admin_id: null,
                        restored_at: null,
                        // Clear all edited state so ticket reopens fresh from time entries
                        // (avoids "manually edited" label when user resubmits)
                        edited_entry_overrides: null,
                        edited_hours: null,
                        edited_descriptions: null,
                        is_edited: false,
                        total_hours: null,
                        total_amount: null,
                        // Auto-discard if no backing time entries (prevents orphaned rejected notification)
                        is_discarded: hasNoBackingEntries ? true : false,
                      }).eq('id', recordId);
                      if (error) throw error;
                    } else {
                      await serviceTicketsService.updateWorkflowStatus(recordId, 'rejected', isDemoMode, rejectNote.trim() || null);
                    }
                    setShowRejectNoteModal(false);
                    setTicketForRejectModal(null);
                    closePanel();
                    await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
                    await queryClient.refetchQueries({ queryKey: ['existingServiceTickets'] });
                    queryClient.invalidateQueries({ queryKey: ['rejectedTicketsCount'] });
                    queryClient.invalidateQueries({ queryKey: ['resubmittedTicketsCount'] });
                  } catch (e) {
                    console.error(rejectModalMode === 'unapprove' ? 'Unapprove failed:' : 'Rejection failed:', e);
                    const errMsg = e instanceof Error ? e.message : (e && typeof (e as any).message === 'string' ? (e as any).message : String(e));
                    alert(`Failed to ${rejectModalMode === 'unapprove' ? 'unapprove' : 'reject'} ticket: ${errMsg}`);
                  } finally {
                    setIsApproving(false);
                  }
                }}
                style={{ padding: '8px 16px', backgroundColor: '#ef5350', color: 'white', border: 'none' }}
              >
                {isApproving
                  ? (rejectModalMode === 'unapprove' ? 'Unapproving...' : 'Rejecting...')
                  : (rejectModalMode === 'unapprove' ? 'Unapprove' : 'Reject')}
              </button>
            </div>
          </div>
        </div>
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
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <p style={{ fontSize: '14px', color: 'var(--text-secondary)', margin: 0 }}>
                    Ticket: {displayTicketNumber || 'Loading...'}
                  </p>
                  {isAdmin && selectedTicket && (() => {
                    const rec = findMatchingTicketRecord(selectedTicket);
                    const hasNumber = !!rec?.ticket_number;
                    if (!hasNumber) return null;
                    return (
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button
                          title="Unassign ticket ID"
                          onClick={() => {
                            if (confirm('Unassign this ticket ID? The ticket stays approved and you can reassign an ID later.')) {
                              handleUnassignTicketNumber(selectedTicket);
                            }
                          }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontSize: '13px', color: '#ef5350' }}
                        >✕</button>
                        <button
                          title="Reassign a new auto-generated ticket ID"
                          onClick={() => {
                            if (confirm('Reassign a new ticket ID? The current ID will be freed.')) {
                              handleReassignTicketNumber(selectedTicket);
                            }
                          }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontSize: '13px', color: '#3b82f6' }}
                        >⟳</button>
                        <button
                          title="Set a custom ticket ID"
                          onClick={() => {
                            setCustomTicketId(rec?.ticket_number || '');
                            setCustomTicketIdError('');
                            setShowCustomTicketIdModal(true);
                          }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontSize: '13px', color: '#f59e0b' }}
                        >✎</button>
                      </div>
                    );
                  })()}
                </div>
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
                        
                        {/* EDITED notice - below legend. Only show when entries actually differ from time entries and ticket is editable (not locked) */}
                        {!isLockedForEditing && isTicketEdited && Object.keys(editedEntryOverrides).length > 0 && (
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
                      
                      {/* Suggested billable receipts from Expenses page */}
                      {!isLockedForEditing && unappliedBillableReceipts.length > 0 && (
                        <div style={{ marginBottom: '12px', padding: '10px 12px', backgroundColor: 'rgba(33, 150, 243, 0.06)', border: '1px solid rgba(33, 150, 243, 0.2)', borderRadius: '6px' }}>
                          <div style={{ fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'rgba(33, 150, 243, 0.8)', marginBottom: '8px' }}>Suggested Billable Receipts</div>
                          {unappliedBillableReceipts.map((r: any) => (
                            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid rgba(33, 150, 243, 0.1)' }}>
                              <div>
                                <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: '500' }}>{r.description}</span>
                                <span style={{ marginLeft: '8px', fontSize: '12px', color: 'var(--text-tertiary)' }}>${parseFloat(r.amount).toFixed(2)}</span>
                              </div>
                              <button
                                onClick={async () => {
                                  const markupStr = prompt('Enter markup on total (e.g. 10 for $10, 10% for percentage, or 0 for none):') || '0';
                                  let markup = 0;
                                  const expTotal = parseFloat(r.amount) + parseFloat(r.gst || 0);
                                  if (markupStr.includes('%')) {
                                    const pct = parseFloat(markupStr.replace('%', ''));
                                    markup = (expTotal * pct) / 100;
                                  } else {
                                    markup = parseFloat(markupStr) || 0;
                                  }
                                  const totalWithMarkup = expTotal + markup;
                                  try {
                                    await userExpensesService.update(r.id, { service_ticket_id: currentTicketRecordId, markup_amount: markup });
                                    setPendingAddExpenses((prev) => [
                                      ...prev,
                                      {
                                        expense_type: 'Expenses' as const,
                                        description: r.description,
                                        quantity: 1,
                                        rate: totalWithMarkup,
                                        unit: '',
                                        tempId: `receipt-${r.id}`,
                                      },
                                    ]);
                                    queryClient.invalidateQueries({ queryKey: ['unappliedBillableReceipts'] });
                                  } catch (err: any) {
                                    alert('Failed to apply receipt: ' + (err.message || 'Unknown error'));
                                  }
                                }}
                                style={{ padding: '4px 10px', backgroundColor: 'rgba(33, 150, 243, 0.1)', color: '#2196F3', border: '1px solid rgba(33, 150, 243, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: 'pointer' }}
                              >
                                + Add to Ticket
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

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
                              <label style={labelStyle}>Billed Rate ($)</label>
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
                            <div>
                              <label style={labelStyle}>Actual Cost ($)</label>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                style={inputStyle}
                                value={editingExpense.actual_cost || ''}
                                onChange={(e) => {
                                  const val = e.target.value === '' ? 0 : parseFloat(e.target.value);
                                  setEditingExpense({ ...editingExpense, actual_cost: isNaN(val) ? 0 : val });
                                }}
                                placeholder="0.00 (optional)"
                              />
                            </div>
                          </div>
                          {/* Needs Reimbursement checkbox — hidden for Mileage/Per Diem (auto-reimbursed) */}
                          {editingExpense.expense_type !== 'Travel' && editingExpense.expense_type !== 'Subsistence' && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                              <input
                                type="checkbox"
                                id="needs-reimbursement"
                                checked={editingExpense.needs_reimbursement || false}
                                onChange={(e) => setEditingExpense({ ...editingExpense, needs_reimbursement: e.target.checked })}
                              />
                              <label htmlFor="needs-reimbursement" style={{ fontSize: '13px', color: 'var(--text-primary)', cursor: 'pointer' }}>Needs Reimbursement</label>
                            </div>
                          )}
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
                                // When Needs Reimbursement is checked, prompt for receipt first
                                if (!editingExpense.id && editingExpense.needs_reimbursement) {
                                  const amt = (Number(editingExpense.quantity) || 0) * (Number(editingExpense.rate) || 0);
                                  setPendingReimbursementExpense({
                                    expense_type: editingExpense.expense_type,
                                    description: editingExpense.description.trim(),
                                    quantity: Number(editingExpense.quantity) || 0,
                                    rate: Number(editingExpense.rate) || 0,
                                    actual_cost: Number(editingExpense.actual_cost) || 0,
                                    unit: editingExpense.unit?.trim() || undefined,
                                  });
                                  setReceiptForm({
                                    description: editingExpense.description.trim(),
                                    amount: amt > 0 ? String(amt) : '',
                                    gst: '',
                                    markupType: 'dollar',
                                    markupValue: '',
                                    is_billable: true,
                                  });
                                  setReceiptFile(null);
                                  if (receiptPreviewUrl) URL.revokeObjectURL(receiptPreviewUrl);
                                  setReceiptPreviewUrl(null);
                                  setReceiptUploadError(null);
                                  setShowReceiptModal(true);
                                  setEditingExpense(null);
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
                                      actual_cost: Number(editingExpense.actual_cost) || 0,
                                      unit: editingExpense.unit?.trim() || undefined,
                                      needs_reimbursement: editingExpense.needs_reimbursement,
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
                                        actual_cost: Number(editingExpense.actual_cost) || 0,
                                        unit: editingExpense.unit?.trim() || undefined,
                                        tempId: `pending-${Date.now()}-${prev.length}`,
                                        needs_reimbursement: editingExpense.needs_reimbursement || false,
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
                                  setEditingExpense({ expense_type: expense.expense_type, description: expense.description, quantity: expense.quantity, rate: expense.rate, actual_cost: expense.actual_cost, unit: expense.unit });
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

                      {/* Internal Receipts Drag & Drop */}
                      {!isLockedForEditing && (
                        <div style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--border-color)' }}>
                          <h4 style={{ fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-tertiary)', marginBottom: '8px' }}>Internal Receipts</h4>
                          <input
                            type="file"
                            accept="image/*,.pdf"
                            ref={receiptFileInputRef}
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              if (receiptPreviewUrl) URL.revokeObjectURL(receiptPreviewUrl);
                              setReceiptFile(file);
                              setReceiptForm({ description: '', amount: '', gst: '', markupType: 'dollar', markupValue: '', is_billable: false });
                              setReceiptUploadError(null);
                              setReceiptPreviewUrl(URL.createObjectURL(file));
                              setShowReceiptModal(true);
                              e.target.value = '';
                            }}
                          />
                          <div
                            ref={receiptDropRef}
                            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.style.borderColor = 'var(--primary-color)'; }}
                            onDragLeave={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--border-color)'; }}
                            onDrop={(e) => {
                              e.preventDefault(); e.stopPropagation();
                              e.currentTarget.style.borderColor = 'var(--border-color)';
                              const file = e.dataTransfer.files?.[0];
                              if (!file) return;
                              if (receiptPreviewUrl) URL.revokeObjectURL(receiptPreviewUrl);
                              setReceiptFile(file);
                              setReceiptForm({ description: '', amount: '', gst: '', markupType: 'dollar', markupValue: '', is_billable: false });
                              setReceiptUploadError(null);
                              setReceiptPreviewUrl(URL.createObjectURL(file));
                              setShowReceiptModal(true);
                            }}
                            onClick={() => receiptFileInputRef.current?.click()}
                            style={{
                              padding: '16px',
                              borderRadius: '6px',
                              border: '2px dashed var(--border-color)',
                              backgroundColor: 'var(--bg-tertiary)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: 'var(--text-tertiary)',
                              fontSize: '13px',
                              textAlign: 'center',
                              cursor: 'pointer',
                              transition: 'border-color 0.2s',
                            }}
                          >
                            Drop receipt image here, or click to upload
                          </div>
                        </div>
                      )}

                          {/* Attached Receipts List */}
                          {attachedReceipts.length > 0 && (
                            <div style={{ marginTop: '12px' }}>
                              <div style={{ fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-tertiary)', marginBottom: '6px' }}>Attached Receipts</div>
                              {attachedReceipts.map((r: any) => (
                                <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '6px', marginBottom: '4px', fontSize: '13px' }}>
                                  <div>
                                    <span style={{ fontWeight: '500', color: 'var(--text-primary)' }}>{r.description}</span>
                                    <span style={{ color: 'var(--text-secondary)', marginLeft: '8px' }}>${parseFloat(r.amount).toFixed(2)}</span>
                                    {parseFloat(r.gst || 0) > 0 && <span style={{ color: 'var(--text-tertiary)', marginLeft: '6px', fontSize: '11px' }}>GST: ${parseFloat(r.gst).toFixed(2)}</span>}
                                  </div>
                                  {!isLockedForEditing && (
                                    <div style={{ display: 'flex', gap: '6px' }}>
                                      <button
                                        onClick={() => handleStartReceiptEdit(r)}
                                        style={{ padding: '3px 8px', backgroundColor: 'rgba(33, 150, 243, 0.1)', color: '#2196F3', border: '1px solid rgba(33, 150, 243, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: 'pointer' }}
                                      >
                                        Edit
                                      </button>
                                      <button
                                        onClick={async () => {
                                          if (!confirm('Unlink this receipt from the ticket? The expense line will be removed.')) return;
                                          try {
                                            await userExpensesService.unapplyFromTicket(r.id);
                                            queryClient.invalidateQueries({ queryKey: ['attachedReceipts'] });
                                            queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
                                            queryClient.invalidateQueries({ queryKey: ['serviceTicketExpenseTotals'] });
                                            if (currentTicketRecordId) await loadExpenses(currentTicketRecordId);
                                          } catch (err: any) {
                                            alert('Failed to unlink: ' + (err?.message || 'Unknown error'));
                                          }
                                        }}
                                        style={{ padding: '3px 8px', backgroundColor: 'rgba(239, 83, 80, 0.1)', color: '#ef5350', border: '1px solid rgba(239, 83, 80, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: 'pointer' }}
                                      >
                                        Unlink
                                      </button>
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                    </div>

                  {/* Notes for the approver (bottom of modal, internal use only) */}
                  {editableTicket && (
                    <div style={{ ...sectionStyle, marginTop: '20px' }}>
                      <h3 style={sectionTitleStyle}>Notes for the Approver (Internal Use Only)</h3>
                      {isLockedForEditing ? (
                        <div style={{ padding: '10px 12px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '6px', fontSize: '14px', color: 'var(--text-primary)', minHeight: '48px', whiteSpace: 'pre-wrap' }}>
                          {editableTicket.approverNotes || <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>No notes provided.</span>}
                        </div>
                      ) : (
                        <textarea
                          value={editableTicket.approverNotes ?? ''}
                          onChange={(e) => setEditableTicket({ ...editableTicket, approverNotes: e.target.value })}
                          placeholder="Add any notes for the admin approving this ticket..."
                          style={{
                            width: '100%',
                            minHeight: '80px',
                            padding: '10px 12px',
                            borderRadius: '6px',
                            border: '1px solid var(--border-color)',
                            backgroundColor: 'var(--bg-primary)',
                            color: 'var(--text-primary)',
                            fontSize: '14px',
                            resize: 'vertical',
                            fontFamily: 'inherit',
                            boxSizing: 'border-box',
                          }}
                        />
                      )}
                    </div>
                  )}

                  </>
                );
              })()}

              {/* Receipt Split-View Modal */}
              {showReceiptModal && (receiptPreviewUrl || pendingReimbursementExpense) && (
                <div style={{
                  position: 'fixed', inset: 0, zIndex: 10002, backgroundColor: 'rgba(0,0,0,0.6)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }} onClick={() => { setShowReceiptModal(false); setPendingReimbursementExpense(null); if (receiptPreviewUrl) URL.revokeObjectURL(receiptPreviewUrl); setReceiptPreviewUrl(null); setReceiptFile(null); }}>
                  <div onClick={(e) => e.stopPropagation()} style={{
                    backgroundColor: 'var(--bg-primary)', borderRadius: '10px', width: '90%', maxWidth: '800px',
                    maxHeight: '85vh', display: 'flex', flexDirection: 'row', overflow: 'hidden',
                    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
                  }}>
                    {/* Left: Receipt preview or drop zone */}
                    <div style={{ flex: 1, backgroundColor: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto', padding: '16px', minHeight: '400px' }}>
                      <input
                        type="file"
                        accept="image/*,.pdf"
                        ref={receiptModalFileInputRef}
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          if (receiptPreviewUrl) URL.revokeObjectURL(receiptPreviewUrl);
                          setReceiptFile(file);
                          setReceiptPreviewUrl(URL.createObjectURL(file));
                          e.target.value = '';
                        }}
                      />
                      {receiptPreviewUrl ? (
                        receiptFile?.type === 'application/pdf' ? (
                          <iframe src={receiptPreviewUrl} title="PDF receipt preview" style={{ width: '100%', height: '100%', minHeight: '380px', border: 'none', borderRadius: '4px' }} />
                        ) : (
                          <img src={receiptPreviewUrl} alt="Receipt" style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain', borderRadius: '4px' }} />
                        )
                      ) : (
                        <div
                          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.style.borderColor = 'var(--primary-color)'; }}
                          onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.style.borderColor = 'var(--border-color)'; }}
                          onDrop={(e) => {
                            e.preventDefault(); e.stopPropagation();
                            e.currentTarget.style.borderColor = 'var(--border-color)';
                            const file = e.dataTransfer.files?.[0];
                            if (!file || (!file.type.startsWith('image/') && file.type !== 'application/pdf')) return;
                            setReceiptFile(file);
                            setReceiptPreviewUrl(URL.createObjectURL(file));
                          }}
                          onClick={() => receiptModalFileInputRef.current?.click()}
                          style={{
                            width: '100%', height: '100%', minHeight: '360px',
                            border: '2px dashed var(--border-color)', borderRadius: '8px',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: 'var(--text-tertiary)', fontSize: '14px', cursor: 'pointer',
                            transition: 'border-color 0.2s',
                          }}
                        >
                          {pendingReimbursementExpense ? 'Drop receipt image or PDF here, or click to upload' : 'Drop receipt here'}
                        </div>
                      )}
                    </div>
                    {/* Right: Inputs */}
                    <div style={{ flex: 1, padding: '24px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                      <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)' }}>
                        {pendingReimbursementExpense ? 'Upload Receipt for Reimbursement' : 'New Receipt Expense'}
                      </h3>
                      {receiptUploadError && <div style={{ color: '#ef5350', fontSize: '13px' }}>{receiptUploadError}</div>}
                      <div>
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Name / Description</label>
                        <input type="text" value={receiptForm.description} onChange={(e) => setReceiptForm({ ...receiptForm, description: e.target.value })} placeholder="e.g. Hotel, Fuel, Parts..." style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }} />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Amount ($)</label>
                        <input type="number" step="0.01" value={receiptForm.amount} onChange={(e) => setReceiptForm({ ...receiptForm, amount: e.target.value })} placeholder="0.00" style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }} />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>GST ($)</label>
                        <input type="number" step="0.01" value={receiptForm.gst} onChange={(e) => setReceiptForm({ ...receiptForm, gst: e.target.value })} placeholder="0.00" style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }} />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Markup</label>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <input type="number" step="0.01" min="0" value={receiptForm.markupValue} onChange={(e) => setReceiptForm({ ...receiptForm, markupValue: e.target.value })} placeholder="0" style={{ flex: 1, padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }} />
                          <div style={{ display: 'flex', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
                            <button type="button" onClick={() => setReceiptForm({ ...receiptForm, markupType: 'dollar' })} style={{ padding: '8px 12px', border: 'none', fontSize: '13px', fontWeight: '600', cursor: 'pointer', backgroundColor: receiptForm.markupType === 'dollar' ? 'var(--primary-color)' : 'var(--bg-secondary)', color: receiptForm.markupType === 'dollar' ? 'white' : 'var(--text-secondary)' }}>$</button>
                            <button type="button" onClick={() => setReceiptForm({ ...receiptForm, markupType: 'percent' })} style={{ padding: '8px 12px', border: 'none', borderLeft: '1px solid var(--border-color)', fontSize: '13px', fontWeight: '600', cursor: 'pointer', backgroundColor: receiptForm.markupType === 'percent' ? 'var(--primary-color)' : 'var(--bg-secondary)', color: receiptForm.markupType === 'percent' ? 'white' : 'var(--text-secondary)' }}>%</button>
                          </div>
                        </div>
                        {(() => {
                          const amt = parseFloat(receiptForm.amount) || 0;
                          const gst = parseFloat(receiptForm.gst) || 0;
                          const expTotal = amt + gst;
                          const val = parseFloat(receiptForm.markupValue) || 0;
                          const markup = receiptForm.markupType === 'percent' ? (expTotal * val) / 100 : val;
                          const total = expTotal + markup;
                          if (markup > 0) return (
                            <div style={{ marginTop: '6px', padding: '8px 10px', backgroundColor: 'rgba(33, 150, 243, 0.08)', borderRadius: '6px', fontSize: '13px' }}>
                              <span style={{ color: 'var(--text-secondary)' }}>Markup: </span><span style={{ fontWeight: '600', color: '#2196F3' }}>${markup.toFixed(2)}</span>
                              <span style={{ marginLeft: '12px', color: 'var(--text-secondary)' }}>Total on ticket: </span><span style={{ fontWeight: '700', color: 'var(--text-primary)' }}>${total.toFixed(2)}</span>
                            </div>
                          );
                          return null;
                        })()}
                      </div>
                      <div style={{ display: 'flex', gap: '8px', marginTop: 'auto', paddingTop: '16px' }}>
                        <button onClick={() => { setShowReceiptModal(false); setPendingReimbursementExpense(null); if (receiptPreviewUrl) URL.revokeObjectURL(receiptPreviewUrl); setReceiptPreviewUrl(null); setReceiptFile(null); }} style={{ flex: 1, padding: '10px', backgroundColor: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', cursor: 'pointer', fontSize: '14px' }}>Cancel</button>
                        <button
                          disabled={isUploadingReceipt}
                          onClick={async () => {
                            if (!receiptForm.description.trim()) { setReceiptUploadError('Name is required'); return; }
                            if (!receiptForm.amount || parseFloat(receiptForm.amount) <= 0) { setReceiptUploadError('Amount is required'); return; }
                            if (pendingReimbursementExpense && !receiptFile) { setReceiptUploadError('Receipt image or PDF is required for reimbursement'); return; }
                            setIsUploadingReceipt(true);
                            setReceiptUploadError(null);
                            try {
                              const amt = parseFloat(receiptForm.amount);
                              const gst = parseFloat(receiptForm.gst) || 0;
                              const expTotal = amt + gst;
                              const markupVal = parseFloat(receiptForm.markupValue) || 0;
                              const markup = receiptForm.markupType === 'percent' ? (expTotal * markupVal) / 100 : markupVal;
                              const totalWithMarkup = expTotal + markup;
                              let storagePath: string | undefined;
                              if (receiptFile) {
                                const optimized = await optimizeImage(receiptFile, { maxWidth: 1024, maxHeight: 1024, quality: 0.8 });
                                storagePath = await userExpensesService.uploadReceipt(optimized);
                              }
                              await userExpensesService.create({
                                description: receiptForm.description.trim(),
                                amount: amt,
                                expense_date: new Date().toISOString().split('T')[0],
                                receipt_url: storagePath,
                                gst: parseFloat(receiptForm.gst) || 0,
                                is_billable: true,
                                service_ticket_id: currentTicketRecordId || undefined,
                                markup_amount: markup > 0 ? markup : undefined,
                                status: isAdmin ? 'approved' : 'pending',
                              });
                              // If billable AND attached to this ticket, also add to the billable expenses list on the ticket (rate = amount + markup)
                              if (currentTicketRecordId) {
                                const expenseType = pendingReimbursementExpense?.expense_type ?? 'Expenses';
                                const unit = pendingReimbursementExpense?.unit;
                                setPendingAddExpenses((prev) => [
                                  ...prev,
                                  {
                                    expense_type: expenseType,
                                    description: receiptForm.description.trim(),
                                    quantity: 1,
                                    rate: totalWithMarkup,
                                    actual_cost: pendingReimbursementExpense ? expTotal : undefined,
                                    unit: unit ?? '',
                                    tempId: `receipt-${Date.now()}`,
                                    needs_reimbursement: !!pendingReimbursementExpense,
                                  },
                                ]);
                              }
                              queryClient.invalidateQueries({ queryKey: ['unappliedBillableReceipts'] });
                              setShowReceiptModal(false);
                              setPendingReimbursementExpense(null);
                              if (receiptPreviewUrl) URL.revokeObjectURL(receiptPreviewUrl);
                              setReceiptPreviewUrl(null);
                              setReceiptFile(null);
                            } catch (err: any) {
                              setReceiptUploadError(err.message || 'Failed to save receipt');
                            } finally {
                              setIsUploadingReceipt(false);
                            }
                          }}
                          style={{ flex: 1, padding: '10px', backgroundColor: 'var(--primary-color)', color: 'white', border: 'none', borderRadius: '6px', cursor: isUploadingReceipt ? 'not-allowed' : 'pointer', fontSize: '14px', fontWeight: '600', opacity: isUploadingReceipt ? 0.7 : 1 }}
                        >
                          {isUploadingReceipt ? 'Saving...' : 'Save Receipt'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

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

              {/* Custom ticket ID modal (admin) */}
              {showCustomTicketIdModal && selectedTicket && (
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
                  onClick={() => setShowCustomTicketIdModal(false)}
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
                      Set Custom Ticket ID
                    </p>
                    <p style={{ margin: '0 0 12px', color: 'var(--text-secondary)', fontSize: '13px' }}>
                      Enter a ticket ID in the format: <strong>XX_YYNNN</strong> (e.g. HV_26007). It must not already be in use.
                    </p>
                    <input
                      value={customTicketId}
                      onChange={(e) => { setCustomTicketId(e.target.value.toUpperCase()); setCustomTicketIdError(''); }}
                      placeholder="e.g. HV_26007"
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        borderRadius: '6px',
                        border: `1px solid ${customTicketIdError ? '#ef5350' : 'var(--border-color)'}`,
                        backgroundColor: 'var(--bg-secondary)',
                        color: 'var(--text-primary)',
                        fontSize: '14px',
                        fontFamily: 'monospace',
                        marginBottom: customTicketIdError ? '4px' : '16px',
                        boxSizing: 'border-box',
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleCustomTicketIdAssign(selectedTicket); }}
                      autoFocus
                    />
                    {customTicketIdError && (
                      <p style={{ margin: '0 0 12px', color: '#ef5350', fontSize: '12px' }}>{customTicketIdError}</p>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                      <button
                        className="button button-secondary"
                        onClick={() => setShowCustomTicketIdModal(false)}
                        style={{ padding: '8px 16px' }}
                      >
                        Cancel
                      </button>
                      <button
                        className="button"
                        onClick={() => handleCustomTicketIdAssign(selectedTicket)}
                        style={{ padding: '8px 16px', backgroundColor: '#3b82f6', color: 'white', border: 'none' }}
                      >
                        Assign
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
                  {/* Trash button - only when NOT in trash (Restore moves to right when in trash). Non-admin: hide when ticket is submitted or approved (any tab, e.g. All). */}
                  {selectedTicket && (() => {
                    const existingRecord = findMatchingTicketRecord(selectedTicket);
                    const isCurrentlyDiscarded = !!(existingRecord as any)?.is_discarded;
                    const ws = (existingRecord as any)?.workflow_status as string | undefined;
                    const hasTicketNumber = !!(existingRecord as any)?.ticket_number;
                    const isSubmittedOrApproved = ws === 'submitted' || ws === 'approved' || hasTicketNumber;
                    if (isCurrentlyDiscarded) return null;
                    if (!isAdmin && isSubmittedOrApproved) return null;
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
                            // Clear sidebar notifications for rejected/resubmitted tickets
                            queryClient.invalidateQueries({ queryKey: ['rejectedTicketsCount'] });
                            queryClient.invalidateQueries({ queryKey: ['resubmittedTicketsCount'] });
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
                              if (!confirm('Permanently delete this service ticket? The ticket will be removed from the database. Time entries are preserved. This cannot be undone.')) return;
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
                          onClick={async (e) => {
                            e.stopPropagation();
                            setSubmitError(null);
                            setIsApproving(true);
                            try {
                              // When submitting (not withdrawing), save first so pending changes are included
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
                                headerOverrides: (selectedTicket.entryApprover != null || selectedTicket.entryPoAfe != null || selectedTicket.entryCc != null || selectedTicket.entryOther != null)
                                  ? {
                                      approver: selectedTicket.entryApprover ?? '',
                                      po_afe: selectedTicket.entryPoAfe ?? '',
                                      cc: selectedTicket.entryCc ?? '',
                                      other: selectedTicket.entryOther ?? '',
                                      service_location: selectedTicket.entryLocation ?? selectedTicket.location ?? '',
                                    }
                                  : undefined,
                              }, isDemoMode);
                              const newStatus = isTicketApproved ? 'draft' : 'approved';
                              await serviceTicketsService.updateWorkflowStatus(ticketRecord.id, newStatus, isDemoMode);
                              
                              // Clean up any old duplicate draft records for this logical ticket (same PO/AFE)
                              // if we just submitted it, to prevent orphaned drafts showing up alongside submitted tickets
                              if (newStatus === 'approved') {
                                await serviceTicketsService.deleteOtherDraftRecordsForTicket(ticketRecord.id, isDemoMode);
                              }
                              
                              await queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
                              await queryClient.invalidateQueries({ queryKey: ['rejectedTicketsCount'] });
                              await queryClient.invalidateQueries({ queryKey: ['resubmittedTicketsCount'] });
                              await queryClient.refetchQueries({ queryKey: ['existingServiceTickets'] });
                              // Unlock panel when withdrawing submission, close panel when submitting
                              if (isTicketApproved) {
                                setIsLockedForEditing(false);
                              } else {
                                // Close panel after successfully submitting for approval
                                closePanel();
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
                          if (hasPendingChanges) {
                            const ok = await performSave();
                            if (!ok) return;
                          }
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
                            setTicketForRejectModal(selectedTicket);
                            setRejectModalMode('reject');
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
                              await handleAssignTicketNumber(selectedTicket, { useSavedData: true });
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
                          await handleAssignTicketNumber(selectedTicket, { useSavedData: true });
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

      {/* Edit Receipt Modal */}
      {editingReceipt && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10010, backgroundColor: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onMouseDown={(e) => { if (e.target === e.currentTarget) setEditingReceipt(null); }}>
          <div onMouseDown={(e) => e.stopPropagation()} style={{
            backgroundColor: 'var(--bg-primary)', borderRadius: '12px',
            width: editingReceipt.receipt_url ? '90%' : undefined,
            maxWidth: editingReceipt.receipt_url ? '800px' : '420px',
            padding: editingReceipt.receipt_url ? 0 : '24px',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            display: editingReceipt.receipt_url ? 'flex' : 'block',
            flexDirection: 'row',
            overflow: 'hidden',
            maxHeight: editingReceipt.receipt_url ? '85vh' : undefined,
          }}>
            {editingReceipt.receipt_url && (
              <div style={{ flex: 1, backgroundColor: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto', padding: '16px', minHeight: '300px', minWidth: '200px' }}>
                {editReceiptPreviewUrl ? (
                  editReceiptPreviewIsPdf ? (
                    <iframe src={editReceiptPreviewUrl} title="Receipt preview" style={{ width: '100%', height: '100%', minHeight: '320px', border: 'none', borderRadius: '4px' }} />
                  ) : (
                    <img src={editReceiptPreviewUrl} alt="Receipt" style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain', borderRadius: '4px' }} />
                  )
                ) : (
                  <div style={{ color: 'var(--text-tertiary)', fontSize: '14px' }}>Loading receipt...</div>
                )}
              </div>
            )}
            <div style={{ flex: editingReceipt.receipt_url ? 1 : undefined, padding: '24px', overflowY: 'auto', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '700', color: 'var(--text-primary)' }}>Edit Receipt</h3>
                <button onClick={() => setEditingReceipt(null)} style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-secondary)' }}>&times;</button>
              </div>
              <div style={{ marginBottom: '16px', padding: '8px 12px', backgroundColor: 'rgba(33, 150, 243, 0.1)', borderRadius: '6px', fontSize: '12px', color: '#2196F3' }}>
                Changes will sync to this service ticket's expense line and the Expenses page.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Description</label>
                  <input type="text" value={editReceiptForm.description} onChange={(e) => setEditReceiptForm({ ...editReceiptForm, description: e.target.value })} style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Amount ($)</label>
                    <input type="number" step="0.01" min="0" value={editReceiptForm.amount} onChange={(e) => setEditReceiptForm({ ...editReceiptForm, amount: e.target.value })} style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>GST ($)</label>
                    <input type="number" step="0.01" min="0" value={editReceiptForm.gst} onChange={(e) => setEditReceiptForm({ ...editReceiptForm, gst: e.target.value })} style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }} />
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '20px' }}>
                <button onClick={() => setEditingReceipt(null)} style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
                <button onClick={handleSaveReceiptEdit} disabled={isSavingReceipt} style={{ padding: '8px 16px', borderRadius: '6px', border: 'none', backgroundColor: 'var(--primary-color)', color: 'white', fontSize: '13px', fontWeight: '600', cursor: isSavingReceipt ? 'not-allowed' : 'pointer', opacity: isSavingReceipt ? 0.7 : 1 }}>
                  {isSavingReceipt ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

