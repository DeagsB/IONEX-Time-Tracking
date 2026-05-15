import React, { useState, useRef, useMemo, Fragment, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { userExpensesService, serviceTicketExpensesService, employeesService } from '../services/supabaseServices';
import { supabase } from '../lib/supabaseClient';
import { optimizeImage } from '../utils/imageOptimizer';
import { ticketExpenseLineHasAttachedReceipt } from '../utils/ticketExpenseReceiptMatch';
import { allocateProportionalCents } from '../utils/allocateProportionalCents';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { extractReceiptAutoFill } from '../utils/receiptAutoFill';
import ServiceTickets from './ServiceTickets';

function normalizeExpenseTableDateKey(raw: string): string {
  const t = String(raw || '').trim();
  return t.split('T')[0].split(' ')[0] || '—';
}

function formatExpenseGroupDateLabel(dateKey: string): string {
  if (dateKey === '—') return 'No date';
  return new Date(`${dateKey}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

type SharedReceiptRowInput = { id: string; receipt_url?: string | null; amount?: unknown; gst?: unknown };

/** Same-day (or same-group) rows that share one uploaded receipt file → line index + combined subtotal+GST. */
function sharedReceiptLabelMetaForGroup(
  items: SharedReceiptRowInput[]
): Map<string, { index: number; total: number; combinedTotal: number }> {
  const byUrl = new Map<string, string[]>();
  for (const exp of items) {
    const u = (exp.receipt_url && String(exp.receipt_url).trim()) || '';
    if (!u) continue;
    if (!byUrl.has(u)) byUrl.set(u, []);
    byUrl.get(u)!.push(String(exp.id));
  }
  const combinedByUrl = new Map<string, number>();
  for (const exp of items) {
    const u = (exp.receipt_url && String(exp.receipt_url).trim()) || '';
    if (!u) continue;
    const a = parseFloat(String(exp.amount)) || 0;
    const g = parseFloat(String(exp.gst)) || 0;
    combinedByUrl.set(u, (combinedByUrl.get(u) || 0) + a + g);
  }
  const meta = new Map<string, { index: number; total: number; combinedTotal: number }>();
  for (const [url, ids] of byUrl.entries()) {
    if (ids.length < 2) continue;
    const combinedTotal = Math.round((combinedByUrl.get(url) || 0) * 100) / 100;
    ids.forEach((id, i) => meta.set(id, { index: i + 1, total: ids.length, combinedTotal }));
  }
  return meta;
}

/**
 * One entry per receipt file that has 2+ lines in this date group, in list order.
 * Sums match the per-line badges (`combinedTotal` from shared receipt meta).
 */
function sharedReceiptGroupTotalsInOrder(
  items: SharedReceiptRowInput[],
  receiptLineMeta: Map<string, { index: number; total: number; combinedTotal: number }>
): Array<{ url: string; lineCount: number; amountSum: number; gstSum: number; combinedTotal: number }> {
  const byUrl = new Map<string, SharedReceiptRowInput[]>();
  for (const exp of items) {
    const u = (exp.receipt_url && String(exp.receipt_url).trim()) || '';
    if (!u) continue;
    if (!byUrl.has(u)) byUrl.set(u, []);
    byUrl.get(u)!.push(exp);
  }
  const out: Array<{ url: string; lineCount: number; amountSum: number; gstSum: number; combinedTotal: number }> = [];
  const seen = new Set<string>();
  for (const exp of items) {
    const id = String(exp.id);
    if (!receiptLineMeta.has(id)) continue;
    const u = (exp.receipt_url && String(exp.receipt_url).trim()) || '';
    if (!u || seen.has(u)) continue;
    seen.add(u);
    const rows = byUrl.get(u)!;
    let amountSum = 0;
    let gstSum = 0;
    for (const r of rows) {
      amountSum += parseFloat(String(r.amount)) || 0;
      gstSum += parseFloat(String(r.gst)) || 0;
    }
    amountSum = Math.round(amountSum * 100) / 100;
    gstSum = Math.round(gstSum * 100) / 100;
    out.push({
      url: u,
      lineCount: rows.length,
      amountSum,
      gstSum,
      combinedTotal: receiptLineMeta.get(id)!.combinedTotal,
    });
  }
  return out;
}

/** Split a receipt line total into subtotal + GST using the same ratio as the full bill. */
function splitTotalIntoAmountGst(
  lineTotal: number,
  billSubtotal: number,
  billGst: number
): { amount: number; gst: number } {
  const t = Math.round(lineTotal * 100) / 100;
  if (!(t >= 0) || Number.isNaN(t)) return { amount: 0, gst: 0 };
  const billTotal = billSubtotal + billGst;
  if (!(billTotal > 0)) {
    return { amount: t, gst: 0 };
  }
  const amount = Math.round(t * (billSubtotal / billTotal) * 100) / 100;
  const gst = Math.round((t - amount) * 100) / 100;
  return { amount, gst };
}

/**
 * Auto-suggest which pending ticket-expense lines a receipt should link to.
 *
 * Strategies (first hit wins):
 *   1. Single-line exact match — line.billed ≈ receiptTotal.
 *   2. Same-rate group (hotel pattern) — N × rate ≈ receiptTotal, pick N
 *      lines from that rate group whose ticket dates sit closest to receipt date.
 *   3. Date-sorted greedy subset sum — sort lines by |ticketDate − receiptDate|,
 *      add until cumulative ≈ receiptTotal within tolerance.
 *
 * Tolerance = max($1.00, 2% of receipt). Returns empty set if no confident match.
 */
function suggestReceiptLinkLines(
  receipt: { expense_date?: string | null; amount?: unknown; gst?: unknown },
  lines: Array<{
    id: string;
    quantity?: unknown;
    rate?: unknown;
    service_tickets?: { date?: string | null } | null;
  }>
): Set<string> {
  const empty = new Set<string>();
  const receiptTotal =
    (parseFloat(String(receipt.amount)) || 0) + (parseFloat(String(receipt.gst)) || 0);
  if (!(receiptTotal > 0) || lines.length === 0) return empty;
  const tol = Math.max(1.0, receiptTotal * 0.02);

  const receiptDateStr = String(receipt.expense_date || '').slice(0, 10);
  const receiptDate = receiptDateStr
    ? new Date(`${receiptDateStr}T12:00:00`).getTime()
    : NaN;

  type Cand = { id: string; billed: number; rate: number; daysAway: number };
  const cands: Cand[] = lines.map((r) => {
    const qty = Number(r.quantity) || 0;
    const rate = Number(r.rate) || 0;
    const billed = qty * rate;
    const dStr = String(r.service_tickets?.date || '').slice(0, 10);
    const dateMs = dStr ? new Date(`${dStr}T12:00:00`).getTime() : NaN;
    const daysAway =
      Number.isFinite(dateMs) && Number.isFinite(receiptDate)
        ? Math.abs(dateMs - receiptDate) / 86400000
        : 9999;
    return { id: String(r.id), billed, rate, daysAway };
  });

  const singles = cands
    .filter((c) => c.billed > 0 && Math.abs(c.billed - receiptTotal) <= tol)
    .sort((a, b) => a.daysAway - b.daysAway);
  if (singles.length > 0) return new Set([singles[0].id]);

  const byRate = new Map<string, Cand[]>();
  for (const c of cands) {
    if (!(c.rate > 0)) continue;
    const k = c.rate.toFixed(2);
    if (!byRate.has(k)) byRate.set(k, []);
    byRate.get(k)!.push(c);
  }
  let bestGroup: Cand[] | null = null;
  let bestGroupScore = Infinity;
  for (const [, group] of byRate) {
    if (group.length < 2) continue;
    const rate = group[0].rate;
    const targetN = Math.round(receiptTotal / rate);
    if (targetN < 2 || targetN > group.length) continue;
    const expected = targetN * rate;
    if (Math.abs(expected - receiptTotal) > tol) continue;
    const picked = [...group].sort((a, b) => a.daysAway - b.daysAway).slice(0, targetN);
    const avgDays = picked.reduce((s, c) => s + c.daysAway, 0) / picked.length;
    const score = avgDays + Math.abs(expected - receiptTotal);
    if (score < bestGroupScore) {
      bestGroupScore = score;
      bestGroup = picked;
    }
  }
  if (bestGroup) return new Set(bestGroup.map((c) => c.id));

  const sorted = [...cands].sort((a, b) => a.daysAway - b.daysAway);
  const picked: Cand[] = [];
  let running = 0;
  for (const c of sorted) {
    if (!(c.billed > 0)) continue;
    if (running + c.billed > receiptTotal + tol) continue;
    picked.push(c);
    running += c.billed;
    if (Math.abs(running - receiptTotal) <= tol) break;
  }
  if (picked.length >= 1 && Math.abs(running - receiptTotal) <= tol) {
    return new Set(picked.map((c) => c.id));
  }

  return empty;
}

interface ReceiptLineItem {
  id: string;
  description: string;
  /** Number of units; default '1'. Line total = quantity × rate. */
  quantity: string;
  /** Per-unit rate ($). When quantity is '1', this equals the line subtotal. */
  rate: string;
  gst: string;
  is_billable: boolean;
}

interface ReceiptFormState {
  expense_date: string;
  notes: string;
  lineItems: ReceiptLineItem[];
}

const newLineItem = (): ReceiptLineItem => ({
  id: Math.random().toString(36).slice(2),
  description: '',
  quantity: '1',
  rate: '',
  gst: '',
  is_billable: false,
});

/** Compute line subtotal = quantity × rate (zero if either invalid). */
const lineItemSubtotal = (li: { quantity: string; rate: string }): number => {
  const q = parseFloat(li.quantity);
  const r = parseFloat(li.rate);
  if (!Number.isFinite(q) || !Number.isFinite(r)) return 0;
  return Math.round(q * r * 100) / 100;
};

const initialReceiptForm: ReceiptFormState = {
  expense_date: new Date().toISOString().split('T')[0],
  notes: '',
  lineItems: [newLineItem()],
};

const ST_NEEDS_RECEIPT_TICKET_IDS_KEY = 'ionex_st_needs_receipt_record_ids';
const ST_PENDING_OPEN_RECORD_KEY = 'ionex_st_pending_open_record';

export default function Expenses() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { user, isAdmin } = useAuth();
  const { isDemoMode } = useDemoMode();
  const [searchParams, setSearchParams] = useSearchParams();

  // Receipt drag-and-drop + split view state
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreviewUrl, setReceiptPreviewUrl] = useState<string | null>(null);
  const [receiptForm, setReceiptForm] = useState<ReceiptFormState>(initialReceiptForm);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  /**
   * "Linking mode": when non-empty, the receipt being submitted will be linked to
   * these service_ticket_expenses rows (one receipt covering multiple ticket charges,
   * e.g. one hotel bill across several days). Single line item is enforced; the
   * billed total is shown alongside the receipt total so the discrepancy is visible.
   */
  const [linkingTicketExpenseIds, setLinkingTicketExpenseIds] = useState<string[]>([]);
  const [linkingTicketExpenseRows, setLinkingTicketExpenseRows] = useState<any[]>([]);
  // Selection state for the "Awaiting Receipts" table
  const [pendingReceiptSelectedIds, setPendingReceiptSelectedIds] = useState<Set<string>>(new Set());
  const receiptFormSectionRef = useRef<HTMLDivElement>(null);
  const [receiptAutofillNote, setReceiptAutofillNote] = useState<string | null>(null);
  const [receiptAutofillBusy, setReceiptAutofillBusy] = useState(false);
  const [hotelAttachAutofillNote, setHotelAttachAutofillNote] = useState<string | null>(null);
  const [hotelAttachAutofillBusy, setHotelAttachAutofillBusy] = useState(false);
  const [splitAutofillNote, setSplitAutofillNote] = useState<string | null>(null);
  const [splitAutofillBusy, setSplitAutofillBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // "Apply to Ticket" modal state
  const [applyExpenseId, setApplyExpenseId] = useState<string | null>(null);
  /** Admin "Link to ticket expenses" modal — opens for a receipt and offers that user's pending ticket expenses. */
  const [linkReceiptModal, setLinkReceiptModal] = useState<{ receipt: any } | null>(null);
  /** Service-ticket modal record id (open ticket from clicked ticket-number badge). */
  const [viewingTicketRecordId, setViewingTicketRecordId] = useState<string | null>(null);
  const [linkReceiptSelectedIds, setLinkReceiptSelectedIds] = useState<Set<string>>(new Set());
  const [isLinkingReceipt, setIsLinkingReceipt] = useState(false);
  const [linkReceiptError, setLinkReceiptError] = useState<string | null>(null);
  /** IDs auto-picked by the suggester, so the modal can mark them as suggestions vs. user picks. */
  const [linkReceiptSuggested, setLinkReceiptSuggested] = useState<Set<string>>(new Set());
  /** Receipt id we already auto-applied for — prevents re-applying after the user clears. */
  const linkReceiptAutoAppliedRef = useRef<string | null>(null);
  const [showTicketPickerModal, setShowTicketPickerModal] = useState(false);
  const [ticketSearchQuery, setTicketSearchQuery] = useState('');

  // Markup modal state (step 2 after picking a ticket)
  const [markupModalTicket, setMarkupModalTicket] = useState<{ id: string; ticketNumber: string } | null>(null);
  const [markupValue, setMarkupValue] = useState('0');
  const [markupType, setMarkupType] = useState<'dollar' | 'percent'>('dollar');
  const [isApplyingMarkup, setIsApplyingMarkup] = useState(false);

  // Viewing receipt
  const [viewingReceiptUrl, setViewingReceiptUrl] = useState<string | null>(null);
  const [viewingReceiptIsPdf, setViewingReceiptIsPdf] = useState(false);
  const [loadingReceiptId, setLoadingReceiptId] = useState<string | null>(null);

  // Admin approval
  const [adminStatusFilter, setAdminStatusFilter] = useState<'unpaid' | 'paid' | 'all'>('unpaid');
  const [adminEmployeeFilter, setAdminEmployeeFilter] = useState<string>('all');
  const [adminDateStart, setAdminDateStart] = useState<string>('');
  const [adminDateEnd, setAdminDateEnd] = useState<string>('');
  /** Type filter values: 'all' | 'Receipt' (standalone receipts) | one of the ticket expense_type strings. */
  const [adminTypeFilter, setAdminTypeFilter] = useState<string>('all');
  const [adminFiltersOpen, setAdminFiltersOpen] = useState(false);
  const adminFiltersAnchorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!adminFiltersOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!adminFiltersAnchorRef.current) return;
      if (!adminFiltersAnchorRef.current.contains(e.target as Node)) setAdminFiltersOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [adminFiltersOpen]);
  const [collapsedMyExpenseDateKeys, setCollapsedMyExpenseDateKeys] = useState<Set<string>>(() => new Set());
  const [collapsedAdminExpenseDateKeys, setCollapsedAdminExpenseDateKeys] = useState<Set<string>>(() => new Set());
  const hasSeededMyExpenseDateCollapse = useRef(false);
  const hasSeededAdminExpenseDateCollapse = useRef(false);
  const [updatingExpenseId, setUpdatingExpenseId] = useState<string | null>(null);

  // Admin employee overview (like Service Tickets)
  const [showExpenseEmployeeOverview, setShowExpenseEmployeeOverview] = useState(true);
  const [expandedExpenseEmployeeId, setExpandedExpenseEmployeeId] = useState<string | null>(null);
  const [expandedExpenseStatusSections, setExpandedExpenseStatusSections] = useState<Record<string, Set<string>>>({});
  /** Selected rows in Employee Overview for batch actions. Key format: "<source>-<id>". */
  const [overviewSelectedKeys, setOverviewSelectedKeys] = useState<Set<string>>(new Set());
  const [overviewBatchBusy, setOverviewBatchBusy] = useState(false);

  const toggleExpenseStatusSection = (empId: string, key: string) => {
    setExpandedExpenseStatusSections(prev => {
      const next = { ...prev };
      const set = new Set(next[empId] || []);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      next[empId] = set;
      return next;
    });
  };

  // Edit receipt
  const [editingExpense, setEditingExpense] = useState<any>(null);
  const [editForm, setEditForm] = useState({ description: '', quantity: '1', rate: '', gst: '', is_billable: false, expense_date: '', notes: '' });
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [editReceiptPreviewUrl, setEditReceiptPreviewUrl] = useState<string | null>(null);
  const [editReceiptIsPdf, setEditReceiptIsPdf] = useState(false);
  const [loadingEditReceipt, setLoadingEditReceipt] = useState(false);

  useEffect(() => {
    if (!editingExpense?.receipt_url) {
      setEditReceiptPreviewUrl(null);
      return;
    }
    setLoadingEditReceipt(true);
    const isPdf = (editingExpense.receipt_url || '').toLowerCase().endsWith('.pdf');
    setEditReceiptIsPdf(isPdf);
    userExpensesService.getReceiptSignedUrl(editingExpense.receipt_url)
      .then((url) => { setEditReceiptPreviewUrl(url); })
      .catch(() => { setEditReceiptPreviewUrl(editingExpense.receipt_url); })
      .finally(() => { setLoadingEditReceipt(false); });
  }, [editingExpense?.id, editingExpense?.receipt_url]);

  // Auto-mark-paid-on-mount was removed: expenses should only become "paid" when an
  // admin explicitly marks them so. Rows already in 'paid' status stay paid — the
  // sweep just stops adding new ones silently. Manual "Mark Paid" actions in the
  // Employee Overview still work as before.

  // Dashboard action items: open Employee Overview and set tab from URL params
  useEffect(() => {
    const overview = searchParams.get('overview');
    const tab = searchParams.get('tab');
    if (overview === 'open') {
      setShowExpenseEmployeeOverview(true);
    }
    if (tab === 'pending' || tab === 'unpaid') {
      setAdminStatusFilter('unpaid');
    }
    if (overview || tab) {
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Ticket details popup (inside picker)
  const [detailsTicketId, setDetailsTicketId] = useState<string | null>(null);

  const { data: expenses = [], isLoading } = useQuery({
    queryKey: ['userExpenses'],
    queryFn: () => userExpensesService.getAll(),
  });

  const { data: hotelReimbLinesRaw = [] } = useQuery({
    queryKey: ['hotelTicketLinesNeedingReceipt', user?.id],
    queryFn: () => serviceTicketExpensesService.getHotelReimbursementLinesForUser(user!.id),
    enabled: !!user?.id,
  });

  const { data: pendingReceiptLines = [] } = useQuery({
    queryKey: ['pendingReceiptLines', isAdmin ? 'all' : user?.id],
    queryFn: () =>
      isAdmin
        ? serviceTicketExpensesService.getAllPendingReceiptLines()
        : serviceTicketExpensesService.getPendingReceiptLinesForUser(user!.id),
    enabled: !!user?.id,
  });

  /** Employees roster — used early for contractor lookup; admin overview uses it again later. */
  const { data: employees = [] } = useQuery({
    queryKey: ['employees'],
    queryFn: () => employeesService.getAll(),
    enabled: isAdmin,
  });

  /**
   * user_id → true if employee.employment_type === 'Contractor'.
   * Contractors invoice us for their expenses, so they don't need receipts and
   * their lines auto-pay with the pay period (no receipt-pending gate).
   */
  const contractorByUserId = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const e of (employees as any[])) {
      if (!e.user_id) continue;
      map.set(String(e.user_id), (e.employment_type || 'Employee') === 'Contractor');
    }
    return map;
  }, [employees]);

  /** Admin filter for the Awaiting Receipts section — by employee user_id. 'all' = no filter. */
  const [pendingReceiptEmpFilter, setPendingReceiptEmpFilter] = useState<string>('all');
  const [pendingReceiptTypeFilter, setPendingReceiptTypeFilter] = useState<string>('all');
  const [pendingReceiptDescFilter, setPendingReceiptDescFilter] = useState<string>('');
  const [pendingReceiptCollapsed, setPendingReceiptCollapsed] = useState<boolean>(true);

  /**
   * Only expense types that genuinely require a receipt before payroll reimbursement.
   * Mileage / Truck Hours / Per Diem / basic Equipment are reimbursed automatically when
   * `needs_reimbursement = true` — they should never appear in Awaiting Receipts.
   */
  const pendingReceiptRequiringTypes = useMemo(() => new Set(['Hotel', 'Expenses']), []);

  const pendingReceiptLinesView = useMemo(() => {
    const arr = pendingReceiptLines as any[];
    return arr.filter((r) => {
      if (!pendingReceiptRequiringTypes.has(String(r.expense_type || ''))) return false;
      // Contractors invoice us — never expect a receipt, never block them in this list.
      const ownerId = String(r.service_tickets?.user_id ?? '');
      if (ownerId && contractorByUserId.get(ownerId)) return false;
      if (isAdmin && pendingReceiptEmpFilter !== 'all' && ownerId !== pendingReceiptEmpFilter) return false;
      if (pendingReceiptTypeFilter !== 'all' && String(r.expense_type || '') !== pendingReceiptTypeFilter) return false;
      const q = pendingReceiptDescFilter.trim().toLowerCase();
      if (q && !String(r.description || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [pendingReceiptLines, isAdmin, pendingReceiptEmpFilter, pendingReceiptTypeFilter, pendingReceiptDescFilter, pendingReceiptRequiringTypes, contractorByUserId]);

  /** Pre-filter rows that pass the receipt-required gate (used for the type-options dropdown + count). */
  const pendingReceiptLinesGated = useMemo(() => {
    return (pendingReceiptLines as any[]).filter((r) => {
      if (!pendingReceiptRequiringTypes.has(String(r.expense_type || ''))) return false;
      const ownerId = String(r.service_tickets?.user_id ?? '');
      if (ownerId && contractorByUserId.get(ownerId)) return false;
      return true;
    });
  }, [pendingReceiptLines, pendingReceiptRequiringTypes, contractorByUserId]);

  /** Count of receipt-required lines suppressed because the owner is a contractor — surfaced
   *  in the Awaiting Receipts banner so admins know why the list is shorter than expected. */
  const pendingReceiptContractorSuppressedCount = useMemo(() => {
    let n = 0;
    for (const r of pendingReceiptLines as any[]) {
      if (!pendingReceiptRequiringTypes.has(String(r.expense_type || ''))) continue;
      const ownerId = String(r.service_tickets?.user_id ?? '');
      if (ownerId && contractorByUserId.get(ownerId)) n++;
    }
    return n;
  }, [pendingReceiptLines, pendingReceiptRequiringTypes, contractorByUserId]);

  const pendingReceiptTypeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of pendingReceiptLinesGated) set.add(String(r.expense_type || ''));
    return [...set].sort();
  }, [pendingReceiptLinesGated]);

  const pendingReceiptEmpOptions = useMemo(() => {
    if (!isAdmin) return [] as { id: string; name: string }[];
    const map = new Map<string, string>();
    for (const r of pendingReceiptLines as any[]) {
      const u = r.service_tickets?.user;
      const id = String(r.service_tickets?.user_id ?? '');
      if (!id) continue;
      if (!map.has(id)) {
        const name = u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email || 'Unknown' : 'Unknown';
        map.set(id, name);
      }
    }
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [pendingReceiptLines, isAdmin]);

  /** Pending receipt lines for the user whose receipt is being linked (admin flow). */
  const linkReceiptUserId = linkReceiptModal?.receipt?.user_id ?? null;
  const { data: linkReceiptPendingLines = [] } = useQuery({
    queryKey: ['pendingReceiptLines', 'forLinkModal', linkReceiptUserId],
    queryFn: () => serviceTicketExpensesService.getPendingReceiptLinesForUser(linkReceiptUserId!),
    enabled: !!linkReceiptUserId,
  });

  // Auto-apply suggestions once per opened receipt, after candidate lines arrive.
  useEffect(() => {
    const receipt = linkReceiptModal?.receipt;
    if (!receipt) {
      linkReceiptAutoAppliedRef.current = null;
      return;
    }
    const receiptId = String(receipt.id);
    if (linkReceiptAutoAppliedRef.current === receiptId) return;
    if (!linkReceiptPendingLines || (linkReceiptPendingLines as any[]).length === 0) return;
    const candidateLines = (linkReceiptPendingLines as any[]).filter((r) =>
      pendingReceiptRequiringTypes.has(String(r.expense_type || ''))
    );
    if (candidateLines.length === 0) {
      linkReceiptAutoAppliedRef.current = receiptId;
      return;
    }
    const suggested = suggestReceiptLinkLines(receipt, candidateLines);
    setLinkReceiptSuggested(suggested);
    if (suggested.size > 0) setLinkReceiptSelectedIds(new Set(suggested));
    linkReceiptAutoAppliedRef.current = receiptId;
  }, [linkReceiptModal, linkReceiptPendingLines, pendingReceiptRequiringTypes]);

  /** All ticket expenses currently linked to a receipt — grouped by user_expense_id. */
  const { data: linkedTicketExpenses = [] } = useQuery({
    queryKey: ['linkedTicketExpenses'],
    queryFn: () => serviceTicketExpensesService.getLinkedTicketExpenses(),
  });
  const linkedByReceiptId = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const r of linkedTicketExpenses as any[]) {
      const key = String(r.user_expense_id || '');
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return map;
  }, [linkedTicketExpenses]);

  /** "View linked" expansion state — shows the list of ticket expenses a receipt covers, with unlink. */
  const [expandedLinkedReceiptId, setExpandedLinkedReceiptId] = useState<string | null>(null);
  const [unlinkingTicketExpenseId, setUnlinkingTicketExpenseId] = useState<string | null>(null);

  const handleUnlinkTicketExpense = async (ticketExpenseId: string) => {
    setUnlinkingTicketExpenseId(ticketExpenseId);
    try {
      await serviceTicketExpensesService.linkUserExpense([ticketExpenseId], null);
      queryClient.invalidateQueries({ queryKey: ['linkedTicketExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['pendingReceiptLines'] });
      queryClient.invalidateQueries({ queryKey: ['ticketReimbExpenses'] });
    } catch (err: any) {
      alert('Failed to unlink: ' + (err?.message || 'Unknown error'));
    } finally {
      setUnlinkingTicketExpenseId(null);
    }
  };

  const hotelLinesStillNeedReceipt = useMemo(() => {
    return (hotelReimbLinesRaw as any[]).filter((row) => {
      const tid = row.service_ticket_id;
      const onTicket = expenses.filter((e: any) => e.service_ticket_id === tid);
      return !ticketExpenseLineHasAttachedReceipt(row.description, onTicket);
    });
  }, [hotelReimbLinesRaw, expenses]);

  const [hotelAttachTarget, setHotelAttachTarget] = useState<{
    serviceTicketExpenseId: string;
    serviceTicketId: string;
    description: string;
    quantity: number;
    rate: number;
  } | null>(null);
  const [hotelAttachFile, setHotelAttachFile] = useState<File | null>(null);
  const [hotelAttachPreviewUrl, setHotelAttachPreviewUrl] = useState<string | null>(null);
  const [hotelAttachForm, setHotelAttachForm] = useState({
    description: '',
    amount: '',
    gst: '',
    expense_date: new Date().toISOString().split('T')[0],
  });
  const [hotelAttachError, setHotelAttachError] = useState<string | null>(null);
  const [hotelAttachSaving, setHotelAttachSaving] = useState(false);
  const hotelAttachFileInputRef = useRef<HTMLInputElement>(null);

  /** One hotel bill / receipt file shared across multiple service-ticket hotel lines */
  const [splitWizardOpen, setSplitWizardOpen] = useState(false);
  const [splitWizardStep, setSplitWizardStep] = useState<1 | 2 | 3>(1);
  const [splitSelectedLineIds, setSplitSelectedLineIds] = useState<Set<string>>(() => new Set());
  const [splitFile, setSplitFile] = useState<File | null>(null);
  const [splitPreviewUrl, setSplitPreviewUrl] = useState<string | null>(null);
  const [splitForm, setSplitForm] = useState({
    amount: '',
    gst: '',
    expense_date: new Date().toISOString().split('T')[0],
  });
  const [splitError, setSplitError] = useState<string | null>(null);
  const [splitSaving, setSplitSaving] = useState(false);
  /** When set, the split wizard uses this existing user_expenses row instead of uploading a new file. */
  const [splitExistingReceiptId, setSplitExistingReceiptId] = useState<string | null>(null);
  const splitFileInputRef = useRef<HTMLInputElement>(null);
  /** Step 3: per-line total receipt cost (subtotal + tax) allocated to each ticket; keyed by service_ticket_expenses.id */
  const [splitManualCostOverrides, setSplitManualCostOverrides] = useState<Record<string, string>>({});
  const prevSplitAllocKeyRef = useRef('');

  const hotelAttachAuto = useMemo(() => {
    if (!hotelAttachTarget) return null;
    const clientBilled =
      (Number(hotelAttachTarget.quantity) || 1) * (Number(hotelAttachTarget.rate) || 0);
    const expTotal = (parseFloat(hotelAttachForm.amount) || 0) + (parseFloat(hotelAttachForm.gst) || 0);
    const markup = Math.round((clientBilled - expTotal) * 100) / 100;
    return { clientBilled, expTotal, markup };
  }, [hotelAttachTarget, hotelAttachForm.amount, hotelAttachForm.gst]);

  const closeHotelAttachModal = () => {
    if (hotelAttachPreviewUrl) URL.revokeObjectURL(hotelAttachPreviewUrl);
    setHotelAttachTarget(null);
    setHotelAttachFile(null);
    setHotelAttachPreviewUrl(null);
    setHotelAttachForm({
      description: '',
      amount: '',
      gst: '',
      expense_date: new Date().toISOString().split('T')[0],
    });
    setHotelAttachAutofillNote(null);
    setHotelAttachAutofillBusy(false);
    setHotelAttachError(null);
    setHotelAttachSaving(false);
  };

  const openHotelAttachModal = (row: any) => {
    setHotelAttachTarget({
      serviceTicketExpenseId: String(row.id),
      serviceTicketId: String(row.service_ticket_id),
      description: String(row.description || 'Hotel'),
      quantity: Number(row.quantity) || 1,
      rate: Number(row.rate) || 0,
    });
    setHotelAttachForm({
      description: String(row.description || 'Hotel'),
      amount: '',
      gst: '',
      expense_date: new Date().toISOString().split('T')[0],
    });
    setHotelAttachFile(null);
    setHotelAttachPreviewUrl(null);
    setHotelAttachAutofillNote(null);
    setHotelAttachAutofillBusy(false);
    setHotelAttachError(null);
  };

  const handleHotelAttachSave = async () => {
    if (!hotelAttachTarget) return;
    if (!hotelAttachForm.description.trim()) {
      setHotelAttachError('Description is required');
      return;
    }
    if (!hotelAttachForm.amount || parseFloat(hotelAttachForm.amount) <= 0) {
      setHotelAttachError('Receipt amount is required');
      return;
    }
    if (!hotelAttachFile) {
      setHotelAttachError('Please choose a receipt image or PDF');
      return;
    }
    const clientBilled =
      (Number(hotelAttachTarget.quantity) || 1) * (Number(hotelAttachTarget.rate) || 0);
    if (!(clientBilled > 0)) {
      setHotelAttachError('This line has no amount billed to the client. Fix it on the service ticket first.');
      return;
    }
    const amt = parseFloat(hotelAttachForm.amount);
    const gst = parseFloat(hotelAttachForm.gst) || 0;
    const expTotal = amt + gst;
    const markup = Math.round((clientBilled - expTotal) * 100) / 100;

    setHotelAttachSaving(true);
    setHotelAttachError(null);
    try {
      const optimized = await optimizeImage(hotelAttachFile, { maxWidth: 1024, maxHeight: 1024, quality: 0.8 });
      const storagePath = await userExpensesService.uploadReceipt(optimized);
      await userExpensesService.create({
        description: hotelAttachForm.description.trim(),
        amount: amt,
        expense_date:
          hotelAttachForm.expense_date.trim() || new Date().toISOString().split('T')[0],
        receipt_url: storagePath,
        gst,
        is_billable: true,
        service_ticket_id: hotelAttachTarget.serviceTicketId,
        markup_amount: markup,
        status: 'pending',
      });
      await serviceTicketExpensesService.update(hotelAttachTarget.serviceTicketExpenseId, {
        expense_type: 'Hotel',
        description: hotelAttachForm.description.trim(),
        quantity: 1,
        rate: clientBilled,
        actual_cost: expTotal,
        needs_reimbursement: true,
      });
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['unappliedBillableReceipts'] });
      queryClient.invalidateQueries({ queryKey: ['attachedReceipts'] });
      queryClient.invalidateQueries({ queryKey: ['serviceTicketExpenseTotals'] });
      queryClient.invalidateQueries({ queryKey: ['ticketReimbExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['hotelTicketLinesNeedingReceipt'] });
      queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
      closeHotelAttachModal();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save';
      setHotelAttachError(msg);
    } finally {
      setHotelAttachSaving(false);
    }
  };

  const openSplitWizard = (preselectedIds?: string[]) => {
    const allHotelIds = hotelLinesStillNeedReceipt.map((r: any) => String(r.id));
    const fromArg = (preselectedIds || []).filter((id) => allHotelIds.includes(id));
    const initial = fromArg.length >= 2 ? fromArg : allHotelIds.length >= 2 ? allHotelIds : [];
    setSplitWizardStep(1);
    setSplitSelectedLineIds(new Set(initial));
    setSplitFile(null);
    setSplitPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setSplitForm({
      amount: '',
      gst: '',
      expense_date: new Date().toISOString().split('T')[0],
    });
    setSplitAutofillNote(null);
    setSplitAutofillBusy(false);
    setSplitError(null);
    setSplitSaving(false);
    setSplitManualCostOverrides({});
    setSplitExistingReceiptId(null);
    prevSplitAllocKeyRef.current = '';
    setSplitWizardOpen(true);
  };

  const closeSplitWizard = () => {
    if (splitPreviewUrl) URL.revokeObjectURL(splitPreviewUrl);
    setSplitWizardOpen(false);
    setSplitWizardStep(1);
    setSplitSelectedLineIds(new Set());
    setSplitFile(null);
    setSplitPreviewUrl(null);
    setSplitForm({
      amount: '',
      gst: '',
      expense_date: new Date().toISOString().split('T')[0],
    });
    setSplitAutofillNote(null);
    setSplitAutofillBusy(false);
    setSplitError(null);
    setSplitSaving(false);
    setSplitManualCostOverrides({});
    setSplitExistingReceiptId(null);
    prevSplitAllocKeyRef.current = '';
  };

  const splitSelectedRows = useMemo(() => {
    return hotelLinesStillNeedReceipt.filter((r: any) => splitSelectedLineIds.has(String(r.id)));
  }, [hotelLinesStillNeedReceipt, splitSelectedLineIds]);

  const splitAllocationPreview = useMemo(() => {
    if (splitSelectedRows.length < 2) return null;
    const amt = parseFloat(splitForm.amount) || 0;
    const gst = parseFloat(splitForm.gst) || 0;
    if (amt <= 0) return null;
    const weights = splitSelectedRows.map(
      (r: any) => (Number(r.quantity) || 1) * (Number(r.rate) || 0)
    );
    const wsum = weights.reduce((a: number, b: number) => a + b, 0);
    if (!(wsum > 0)) return null;
    const amtCents = Math.round(amt * 100);
    const gstCents = Math.round(gst * 100);
    const amtParts = allocateProportionalCents(weights, amtCents);
    const gstParts = allocateProportionalCents(weights, gstCents);
    return splitSelectedRows.map((r: any, i: number) => {
      const billed = weights[i];
      const ai = amtParts[i] / 100;
      const gi = gstParts[i] / 100;
      const cost = ai + gi;
      return {
        row: r,
        billed,
        amount: ai,
        gst: gi,
        cost,
        markup: Math.round((billed - cost) * 100) / 100,
        pct: (100 * billed) / wsum,
      };
    });
  }, [splitSelectedRows, splitForm.amount, splitForm.gst]);

  const splitAllocKey = useMemo(() => {
    if (!splitAllocationPreview) return '';
    return `${splitForm.amount}|${splitForm.gst}|${splitAllocationPreview.map((l) => String(l.row.id)).sort().join(',')}`;
  }, [splitAllocationPreview, splitForm.amount, splitForm.gst]);

  useEffect(() => {
    if (splitWizardStep !== 3 || !splitAllocationPreview || !splitAllocKey) return;
    if (prevSplitAllocKeyRef.current === splitAllocKey) return;
    prevSplitAllocKeyRef.current = splitAllocKey;
    const next: Record<string, string> = {};
    for (const l of splitAllocationPreview) {
      next[String(l.row.id)] = l.cost.toFixed(2);
    }
    setSplitManualCostOverrides(next);
  }, [splitWizardStep, splitAllocKey, splitAllocationPreview]);

  const splitEffectiveAllocation = useMemo(() => {
    if (!splitAllocationPreview) return null;
    const billSub = parseFloat(splitForm.amount) || 0;
    const billGst = parseFloat(splitForm.gst) || 0;
    const totalBill = Math.round((billSub + billGst) * 100) / 100;
    const lines = splitAllocationPreview.map((line) => {
      const id = String(line.row.id);
      const raw = splitManualCostOverrides[id];
      let cost: number;
      if (raw === undefined || String(raw).trim() === '') {
        cost = line.cost;
      } else {
        cost = Math.max(0, Math.round((parseFloat(raw) || 0) * 100) / 100);
      }
      const { amount, gst } = splitTotalIntoAmountGst(cost, billSub, billGst);
      const markup = Math.round((line.billed - cost) * 100) / 100;
      return { ...line, cost, amount, gst, markup };
    });
    const sumAllocated = Math.round(lines.reduce((s, l) => s + l.cost, 0) * 100) / 100;
    const remainder = Math.round((totalBill - sumAllocated) * 100) / 100;
    return { lines, totalBill, sumAllocated, remainder };
  }, [splitAllocationPreview, splitManualCostOverrides, splitForm.amount, splitForm.gst]);

  const handleSplitWizardSave = async () => {
    if (!splitEffectiveAllocation || splitEffectiveAllocation.lines.length < 2) return;
    if (!splitFile && !splitExistingReceiptId) return;
    const amt = parseFloat(splitForm.amount) || 0;
    const gst = parseFloat(splitForm.gst) || 0;
    if (amt <= 0) {
      setSplitError('Enter the receipt subtotal (before tax) from the hotel bill.');
      return;
    }
    for (const line of splitEffectiveAllocation.lines) {
      if (!(line.billed > 0)) {
        setSplitError('Every selected line must have an amount billed to the client.');
        return;
      }
    }
    if (splitEffectiveAllocation.sumAllocated > splitEffectiveAllocation.totalBill + 0.02) {
      setSplitError(
        `Allocated total ($${splitEffectiveAllocation.sumAllocated.toFixed(2)}) cannot exceed the bill ($${splitEffectiveAllocation.totalBill.toFixed(2)}).`
      );
      return;
    }

    setSplitSaving(true);
    setSplitError(null);
    try {
      // Re-use the file path from an existing user_expenses row when the admin chose
      // "use existing receipt" instead of uploading a new file. Otherwise upload normally.
      let storagePath: string;
      if (splitExistingReceiptId) {
        const existing = (expenses as any[]).find((e) => String(e.id) === splitExistingReceiptId);
        if (!existing?.receipt_url) {
          throw new Error('Selected existing receipt has no stored file. Please upload a new file instead.');
        }
        storagePath = existing.receipt_url;
      } else {
        if (!splitFile) {
          throw new Error('Pick a receipt file or choose an existing receipt before saving.');
        }
        const optimized = await optimizeImage(splitFile, { maxWidth: 1024, maxHeight: 1024, quality: 0.8 });
        storagePath = await userExpensesService.uploadReceipt(optimized);
      }
      const expenseDate =
        splitForm.expense_date.trim() || new Date().toISOString().split('T')[0];

      for (const line of splitEffectiveAllocation.lines) {
        const desc = String(line.row.description || 'Hotel').trim();
        const markup = Math.round((line.billed - line.cost) * 100) / 100;
        await userExpensesService.create({
          description: desc,
          amount: line.amount,
          expense_date: expenseDate,
          receipt_url: storagePath,
          gst: line.gst,
          is_billable: true,
          service_ticket_id: String(line.row.service_ticket_id),
          markup_amount: markup,
          status: 'pending',
        });
        await serviceTicketExpensesService.update(String(line.row.id), {
          expense_type: 'Hotel',
          description: desc,
          quantity: 1,
          rate: line.billed,
          actual_cost: line.cost,
          needs_reimbursement: true,
          reimbursement_status: 'pending',
          reimbursement_approved_at: new Date().toISOString(),
        });
      }

      if (splitEffectiveAllocation.remainder > 0.02) {
        const { amount: remAmt, gst: remGst } = splitTotalIntoAmountGst(
          splitEffectiveAllocation.remainder,
          amt,
          gst
        );
        await userExpensesService.create({
          description: 'Hotel — portion not billed to client (same receipt)',
          amount: remAmt,
          expense_date: expenseDate,
          receipt_url: storagePath,
          gst: remGst,
          is_billable: false,
          status: 'pending',
        });
      }

      const sumAmt = splitEffectiveAllocation.lines.reduce((s, l) => s + l.amount, 0);
      const sumGst = splitEffectiveAllocation.lines.reduce((s, l) => s + l.gst, 0);
      let sumCost = splitEffectiveAllocation.lines.reduce((s, l) => s + l.cost, 0);
      if (splitEffectiveAllocation.remainder > 0.02) {
        sumCost += splitEffectiveAllocation.remainder;
      }
      if (Math.abs(sumAmt - amt) > 0.05 || Math.abs(sumGst - gst) > 0.05) {
        console.warn('Split receipt rounding drift', { sumAmt, amt, sumGst, gst, sumCost });
      }

      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['unappliedBillableReceipts'] });
      queryClient.invalidateQueries({ queryKey: ['attachedReceipts'] });
      queryClient.invalidateQueries({ queryKey: ['serviceTicketExpenseTotals'] });
      queryClient.invalidateQueries({ queryKey: ['ticketReimbExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['hotelTicketLinesNeedingReceipt'] });
      queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
      closeSplitWizard();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save split receipt';
      setSplitError(msg);
    } finally {
      setSplitSaving(false);
    }
  };

  const { data: allTicketRecords = [] } = useQuery({
    queryKey: ['ticketsForExpensePicker', isDemoMode, isAdmin, user?.id],
    queryFn: async () => {
      const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
      let query = supabase
        .from(tableName)
        .select('id, ticket_number, date, location, workflow_status, user_id, customers(name), projects(name, project_number)')
        .order('date', { ascending: false })
        .limit(200);

      if (!isAdmin && user?.id) {
        query = query.eq('user_id', user.id);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    enabled: showTicketPickerModal,
  });

  // Ticket picker shows all tickets — the legacy CNRL-pipeline filter was
  // tied to retired workflow_status values. Invoice-side tracking lives on
  // the Invoices page now.
  const uninvoicedTickets = allTicketRecords;

  // Admin: own tickets first, then others. Non-admin: already filtered to own.
  const sortedUninvoiced = isAdmin && user?.id
    ? [...uninvoicedTickets].sort((a: any, b: any) => {
        const aOwn = a.user_id === user.id ? 0 : 1;
        const bOwn = b.user_id === user.id ? 0 : 1;
        if (aOwn !== bOwn) return aOwn - bOwn;
        return new Date(b.date).getTime() - new Date(a.date).getTime();
      })
    : uninvoicedTickets;

  const filteredPickerTickets = sortedUninvoiced.filter((t: any) => {
    if (!ticketSearchQuery.trim()) return true;
    const q = ticketSearchQuery.toLowerCase();
    return (
      (t.ticket_number || '').toLowerCase().includes(q) ||
      (t.location || '').toLowerCase().includes(q) ||
      (t.customers?.name || '').toLowerCase().includes(q) ||
      (t.projects?.name || '').toLowerCase().includes(q) ||
      (t.projects?.project_number || '').toLowerCase().includes(q)
    );
  });

  const detailsTicket = allTicketRecords.find((t: any) => t.id === detailsTicketId) as any;

  const { data: ticketDetails, isLoading: isLoadingDetails } = useQuery({
    queryKey: ['ticketPickerDetails', detailsTicketId],
    queryFn: async () => {
      if (!detailsTicketId || !detailsTicket) return null;
      const [timeRes, expRes] = await Promise.all([
        supabase
          .from('time_entries')
          .select('id, date, hours, rate_type, description, start_time, end_time')
          .eq('user_id', detailsTicket.user_id)
          .eq('date', detailsTicket.date)
          .eq('billable', true)
          .not('project_id', 'is', null)
          .order('start_time', { ascending: true }),
        supabase
          .from('service_ticket_expenses')
          .select('id, expense_type, description, quantity, rate, unit')
          .eq('service_ticket_id', detailsTicketId)
          .order('created_at', { ascending: true }),
      ]);
      if (timeRes.error) throw timeRes.error;
      if (expRes.error) throw expRes.error;
      return { timeEntries: timeRes.data || [], expenses: expRes.data || [] };
    },
    enabled: !!detailsTicketId && !!detailsTicket,
  });

  const deleteExpenseMutation = useMutation({
    mutationFn: (id: string) => userExpensesService.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['unappliedBillableReceipts'] });
      queryClient.invalidateQueries({ queryKey: ['serviceTicketExpenseTotals'] });
      queryClient.invalidateQueries({ queryKey: ['ticketReimbExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['hotelTicketLinesNeedingReceipt'] });
    },
    onError: (err: unknown) => {
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      const msg = err instanceof Error ? err.message : 'Unknown error';
      alert('Failed to delete expense: ' + msg);
    },
  });

  const removeExpenseFromCache = (id: string) => {
    queryClient.setQueryData(['userExpenses'], (old: any[] | undefined) => (old || []).filter((e) => e.id !== id));
  };

  const requestDeleteExpense = (exp: any, e: React.MouseEvent) => {
    e.stopPropagation();
    // Standard confirm replaces the 3-second undo banner — undo silently completed
    // the delete if the user navigated away or refreshed the page, leaving no audit
    // trail. Confirm matches how the unapply/destructive actions work elsewhere in
    // the app.
    const desc = (exp.description || 'Expense').trim();
    const short = desc.length > 60 ? `${desc.slice(0, 60)}…` : desc || 'this expense';
    const amount = Number(exp.amount) || 0;
    const proceed = window.confirm(`Delete "${short}"${amount > 0 ? ` ($${amount.toFixed(2)})` : ''}?`);
    if (!proceed) return;
    if (editingExpense?.id === exp.id) {
      setEditingExpense(null);
      setEditReceiptPreviewUrl(null);
    }
    removeExpenseFromCache(exp.id);
    deleteExpenseMutation.mutate(exp.id);
  };

  const handleStartEdit = (exp: any) => {
    setEditingExpense(exp);
    const qty = Number(exp.quantity) || 1;
    const amt = parseFloat(exp.amount) || 0;
    const ratePerUnit = qty > 0 ? amt / qty : amt;
    setEditForm({
      description: exp.description || '',
      quantity: String(qty),
      rate: String(Math.round(ratePerUnit * 100) / 100),
      gst: String(parseFloat(exp.gst || 0)),
      is_billable: exp.is_billable || false,
      expense_date: exp.expense_date || '',
      notes: exp.notes || '',
    });
  };

  const handleSaveEdit = async () => {
    if (!editingExpense) return;
    if (!editForm.description.trim()) { alert('Description is required'); return; }
    const qty = parseFloat(editForm.quantity) || 0;
    const rate = parseFloat(editForm.rate) || 0;
    if (qty <= 0) { alert('Quantity must be greater than 0'); return; }
    if (rate <= 0) { alert('Rate must be greater than 0'); return; }
    const newAmount = Math.round(qty * rate * 100) / 100;
    setIsSavingEdit(true);
    try {
      await userExpensesService.updateAndSyncTicket(editingExpense.id, {
        description: editForm.description.trim(),
        amount: newAmount,
        quantity: qty,
        gst: parseFloat(editForm.gst) || 0,
        is_billable: editForm.is_billable,
        expense_date: editForm.expense_date,
        notes: editForm.notes.trim(),
      });
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['unappliedBillableReceipts'] });
      queryClient.invalidateQueries({ queryKey: ['serviceTicketExpenseTotals'] });
      queryClient.invalidateQueries({ queryKey: ['hotelTicketLinesNeedingReceipt'] });
      setEditingExpense(null);
    } catch (err: any) {
      alert('Failed to save: ' + (err.message || 'Unknown error'));
    } finally {
      setIsSavingEdit(false);
    }
  };

  // Fetch service ticket expenses that need reimbursement (admin only)
  const { data: ticketReimbExpenses = [] } = useQuery({
    queryKey: ['ticketReimbExpenses'],
    queryFn: () => serviceTicketExpensesService.getNeedsReimbursement(),
    enabled: isAdmin,
  });

  /**
   * Batch flip status for many selected rows at once. Receipts hit user_expenses.status,
   * ticket expenses hit service_ticket_expenses.reimbursement_status. Used by the
   * Employee Overview bulk-action bar.
   */
  const handleOverviewBatchStatusChange = async (
    rows: Array<{ id: string; source: 'receipt' | 'ticket' }>,
    newStatus: 'pending' | 'paid'
  ) => {
    if (rows.length === 0) return;
    // Confirm before flipping a batch — single-row marks already prompt for the
    // receipt-required case, but batch actions had no guard and could flip dozens of
    // rows in one click. Show count + intended state so admins can sanity check.
    const verb = newStatus === 'paid' ? 'paid' : 'unpaid';
    const proceed = window.confirm(`Mark ${rows.length} expense${rows.length === 1 ? '' : 's'} as ${verb}?`);
    if (!proceed) return;
    setOverviewBatchBusy(true);
    try {
      await Promise.all(
        rows.map((r) =>
          r.source === 'ticket'
            ? serviceTicketExpensesService.updateReimbursementStatus(r.id, newStatus)
            : userExpensesService.update(r.id, { status: newStatus })
        )
      );
      queryClient.invalidateQueries({ queryKey: ['ticketReimbExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['hotelTicketLinesNeedingReceipt'] });
      setOverviewSelectedKeys(new Set());
    } catch (err: any) {
      alert('Failed to update some rows: ' + (err?.message || 'Unknown error'));
    } finally {
      setOverviewBatchBusy(false);
    }
  };

  const handleAdminStatusChange = async (itemId: string, newStatus: 'pending' | 'paid', source: 'receipt' | 'ticket', expRow?: any) => {
    // Guard: marking a receipt-required ticket expense (Hotel / Other) paid when no
    // receipt is attached is almost always accidental — confirm before letting it through.
    // Contractors are exempt: they invoice us, no receipt expected.
    if (newStatus === 'paid' && source === 'ticket' && expRow) {
      const t = String(expRow.expense_type || '').toLowerCase();
      const desc = String(expRow.description || '').toLowerCase();
      const needsReceipt = t === 'hotel' || t === 'expenses' || desc.includes('hotel');
      const hasReceipt = (Number(expRow.actual_cost) || 0) > 0 || !!expRow.user_expense_id;
      const ownerId = String(expRow.service_tickets?.user_id ?? expRow._userId ?? '');
      const isContractor = ownerId ? !!contractorByUserId.get(ownerId) : false;
      if (needsReceipt && !hasReceipt && !isContractor) {
        const proceed = window.confirm(
          'This ticket expense does not have a receipt attached yet. Mark as paid anyway?\n\n' +
          'You can still find it later in the Awaiting Receipts section.'
        );
        if (!proceed) return;
      }
    }
    setUpdatingExpenseId(itemId);
    try {
      if (source === 'ticket') {
        await serviceTicketExpensesService.updateReimbursementStatus(itemId, newStatus);
        queryClient.invalidateQueries({ queryKey: ['ticketReimbExpenses'] });
      } else {
        await userExpensesService.update(itemId, { status: newStatus });
        queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      }
      queryClient.invalidateQueries({ queryKey: ['hotelTicketLinesNeedingReceipt'] });
    } catch (err: any) {
      alert('Failed to update status: ' + (err.message || 'Unknown error'));
    } finally {
      setUpdatingExpenseId(null);
    }
  };

  // Merge receipt expenses + ticket reimbursement expenses into one admin list
  const mergedAdminExpenses = useMemo(() => {
    const receiptItems = expenses.map((exp: any) => ({
      ...exp,
      _source: 'receipt' as const,
      _status: exp.status === 'paid' ? 'paid' : 'unpaid',
      _userId: exp.user_id,
      _employeeName: exp.users ? `${exp.users.first_name || ''} ${exp.users.last_name || ''}`.trim() || exp.users.email : 'Unknown',
      _ticketNumber: exp.service_tickets?.ticket_number || null,
      _amount: parseFloat(exp.amount),
      _date: exp.expense_date,
    }));
    const ticketItems = ticketReimbExpenses
      .filter((exp: any) => {
        const tid = exp.service_ticket_id;
        if (!tid) return true;
        const receiptsOnTicket = expenses.filter((r: any) => r.service_ticket_id === tid);
        return !ticketExpenseLineHasAttachedReceipt(exp.description, receiptsOnTicket);
      })
      .map((exp: any) => {
        const uid = exp.service_tickets?.user_id;
        const emp = employees?.find((e: any) => e.user_id === uid);
        const empName = emp?.user ? `${emp.user.first_name || ''} ${emp.user.last_name || ''}`.trim() : 'Unknown';
        return {
          ...exp,
          _source: 'ticket' as const,
          _status: (exp.reimbursement_status === 'paid') ? 'paid' : 'unpaid',
          _userId: uid,
          _employeeName: empName,
          _ticketNumber: exp.service_tickets?.ticket_number || null,
          _amount: (Number(exp.quantity) || 0) * (Number(exp.rate) || 0),
          _date: exp.service_tickets?.date || exp.created_at?.split('T')[0],
        };
      });
    return [...receiptItems, ...ticketItems].sort((a, b) => new Date(b._date).getTime() - new Date(a._date).getTime());
  }, [expenses, ticketReimbExpenses, employees]);

  // Expense Approvals shows everyone's expenses (admin's own are auto-approved)
  const mergedAdminExpensesForApproval = mergedAdminExpenses;

  const adminEmployeeOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of mergedAdminExpensesForApproval as any[]) {
      const id = String(e._userId ?? '');
      if (!id) continue;
      if (!map.has(id)) map.set(id, String(e._employeeName || 'Unknown'));
    }
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [mergedAdminExpensesForApproval]);

  const expenseTypeOf = (exp: any): string => {
    if (exp._source === 'receipt') return 'Receipt';
    const t = String(exp.expense_type || 'Other');
    if (t === 'Travel') {
      const desc = String(exp.description || '').toLowerCase();
      if (desc.includes('truck')) return 'Truck Hours';
      if (desc.includes('mileage') || desc.includes('km')) return 'Mileage';
      return 'Travel';
    }
    return t;
  };

  const adminTypeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of mergedAdminExpensesForApproval as any[]) set.add(expenseTypeOf(e));
    return [...set].sort();
  }, [mergedAdminExpensesForApproval]);

  const adminFilteredExpenses = mergedAdminExpensesForApproval.filter((exp: any) => {
    if (adminStatusFilter !== 'all' && exp._status !== adminStatusFilter) return false;
    if (adminEmployeeFilter !== 'all' && String(exp._userId ?? '') !== adminEmployeeFilter) return false;
    if (adminTypeFilter !== 'all' && expenseTypeOf(exp) !== adminTypeFilter) return false;
    if (adminDateStart || adminDateEnd) {
      const d = normalizeExpenseTableDateKey(String(exp._date || ''));
      if (adminDateStart && d < adminDateStart) return false;
      if (adminDateEnd && d > adminDateEnd) return false;
    }
    return true;
  });

  const adminFilteredTotals = useMemo(() => {
    let amount = 0;
    let gst = 0;
    const byType: Record<string, { count: number; amount: number }> = {};
    for (const exp of adminFilteredExpenses as any[]) {
      const a = Number(exp._amount) || 0;
      amount += a;
      if (exp._source === 'receipt') gst += parseFloat(String(exp.gst || 0)) || 0;
      const t = expenseTypeOf(exp);
      if (!byType[t]) byType[t] = { count: 0, amount: 0 };
      byType[t].count += 1;
      byType[t].amount += a;
    }
    return { amount, gst, count: adminFilteredExpenses.length, byType };
  }, [adminFilteredExpenses]);

  // Expense table: admin sees own only; non-admin sees own only (filtered for defense in depth)
  const myExpenses = useMemo(() => {
    if (!user?.id) return expenses;
    return expenses.filter((e: any) => e.user_id === user.id);
  }, [expenses, user?.id]);

  const myExpensesGroupedByDate = useMemo(() => {
    const sorted = [...myExpenses].sort((a: any, b: any) => {
      const ka = normalizeExpenseTableDateKey(String(a.expense_date || ''));
      const kb = normalizeExpenseTableDateKey(String(b.expense_date || ''));
      if (ka !== kb) return kb.localeCompare(ka);
      const ta = String(a.created_at || a.id || '');
      const tb = String(b.created_at || b.id || '');
      return tb.localeCompare(ta);
    });
    const groups: { dateKey: string; items: any[] }[] = [];
    let lastKey = '';
    for (const exp of sorted) {
      const k = normalizeExpenseTableDateKey(String(exp.expense_date || ''));
      if (k !== lastKey) {
        groups.push({ dateKey: k, items: [] });
        lastKey = k;
      }
      groups[groups.length - 1].items.push(exp);
    }
    return groups;
  }, [myExpenses]);

  const adminFilteredExpensesGroupedByDate = useMemo(() => {
    const sorted = [...adminFilteredExpenses].sort((a: any, b: any) => {
      const ka = normalizeExpenseTableDateKey(String(a._date || ''));
      const kb = normalizeExpenseTableDateKey(String(b._date || ''));
      if (ka !== kb) return kb.localeCompare(ka);
      const sa = `${a._employeeName || ''}|${a.description || ''}|${a.id}`;
      const sb = `${b._employeeName || ''}|${b.description || ''}|${b.id}`;
      return sa.localeCompare(sb);
    });
    const groups: { dateKey: string; items: any[] }[] = [];
    let lastKey = '';
    for (const exp of sorted) {
      const k = normalizeExpenseTableDateKey(String(exp._date || ''));
      if (k !== lastKey) {
        groups.push({ dateKey: k, items: [] });
        lastKey = k;
      }
      groups[groups.length - 1].items.push(exp);
    }
    return groups;
  }, [adminFilteredExpenses]);

  const toggleMyExpenseDateGroup = (dateKey: string) => {
    setCollapsedMyExpenseDateKeys((prev) => {
      const next = new Set(prev);
      if (next.has(dateKey)) next.delete(dateKey);
      else next.add(dateKey);
      return next;
    });
  };

  const toggleAdminExpenseDateGroup = (dateKey: string) => {
    setCollapsedAdminExpenseDateKeys((prev) => {
      const next = new Set(prev);
      if (next.has(dateKey)) next.delete(dateKey);
      else next.add(dateKey);
      return next;
    });
  };

  useEffect(() => {
    if (myExpensesGroupedByDate.length === 0) {
      hasSeededMyExpenseDateCollapse.current = false;
      setCollapsedMyExpenseDateKeys(new Set());
      return;
    }
    if (hasSeededMyExpenseDateCollapse.current) return;
    hasSeededMyExpenseDateCollapse.current = true;
    const collapsedKeys = myExpensesGroupedByDate
      .filter((g) => g.items.length > 0 && g.items.every((exp: any) => exp.status === 'paid'))
      .map((g) => g.dateKey);
    setCollapsedMyExpenseDateKeys(new Set(collapsedKeys));
  }, [myExpensesGroupedByDate]);

  useEffect(() => {
    hasSeededAdminExpenseDateCollapse.current = false;
    setCollapsedAdminExpenseDateKeys(new Set());
  }, [adminStatusFilter]);

  useEffect(() => {
    if (adminFilteredExpensesGroupedByDate.length === 0) {
      hasSeededAdminExpenseDateCollapse.current = false;
      setCollapsedAdminExpenseDateKeys(new Set());
      return;
    }
    if (hasSeededAdminExpenseDateCollapse.current) return;
    hasSeededAdminExpenseDateCollapse.current = true;
    const collapsedKeys = adminFilteredExpensesGroupedByDate
      .filter((g) => g.items.length > 0 && g.items.every((exp: any) => exp._status === 'paid'))
      .map((g) => g.dateKey);
    setCollapsedAdminExpenseDateKeys(new Set(collapsedKeys));
  }, [adminFilteredExpensesGroupedByDate]);

  // Admin employee overview: per-employee counts (unpaid, paid)
  const expenseEmployeeSummary = useMemo(() => {
    if (!isAdmin || !employees?.length) return [];
    const map = new Map<string, { userId: string; name: string; unpaid: number; paid: number }>();
    for (const e of mergedAdminExpenses) {
      const uid = e._userId;
      if (!uid) continue;
      if (!map.has(uid)) {
        const emp = employees.find((em: any) => em.user_id === uid);
        const name = emp?.user ? `${emp.user.first_name || ''} ${emp.user.last_name || ''}`.trim() : e._employeeName || 'Unknown';
        map.set(uid, { userId: uid, name, unpaid: 0, paid: 0 });
      }
      const entry = map.get(uid)!;
      if (e._status === 'paid') entry.paid++;
      else entry.unpaid++;
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.unpaid > 0 && b.unpaid === 0) return -1;
      if (a.unpaid === 0 && b.unpaid > 0) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [isAdmin, mergedAdminExpenses, employees]);

  // Expenses for expanded employee in overview (grouped by status)
  const expandedExpenseEmployeeByStatus = useMemo(() => {
    const empty = { unpaid: [] as any[], paid: [] as any[] };
    if (!expandedExpenseEmployeeId || !isAdmin) return empty;
    const pool = mergedAdminExpenses.filter((e: any) => e._userId === expandedExpenseEmployeeId);
    const grouped = { unpaid: [] as any[], paid: [] as any[] };
    for (const e of pool) {
      if (e._status === 'paid') grouped.paid.push(e);
      else grouped.unpaid.push(e);
    }
    return grouped;
  }, [expandedExpenseEmployeeId, isAdmin, mergedAdminExpenses]);

  const handleFileDrop = (file: File) => {
    setReceiptFile(file);
    setReceiptForm(initialReceiptForm);
    setReceiptAutofillNote(null);
    setUploadError(null);
    const reader = new FileReader();
    reader.onloadend = () => {
      setReceiptPreviewUrl(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    if (!receiptFile || (!receiptFile.type.startsWith('image/') && receiptFile.type !== 'application/pdf')) {
      setReceiptAutofillBusy(false);
      return;
    }
    let cancelled = false;
    setReceiptAutofillBusy(true);
    setReceiptAutofillNote(null);
    void extractReceiptAutoFill(receiptFile).then((r) => {
      if (cancelled) return;
      setReceiptAutofillBusy(false);
      setReceiptForm((prev) => ({
        ...prev,
        expense_date: r.expenseDate || prev.expense_date,
        lineItems: prev.lineItems.map((item, i) =>
          i === 0
            ? {
                ...item,
                // Auto-fill treats receipt total as a single-unit line: qty=1, rate=amount.
                ...(r.amount ? { quantity: '1', rate: r.amount } : {}),
                ...(r.gst !== '' ? { gst: r.gst } : {}),
              }
            : item
        ),
      }));
      const parts: string[] = [];
      if (r.method === 'pdf-text') parts.push('Filled from PDF text.');
      else if (r.method === 'ocr') parts.push('Filled using photo text recognition; please verify amounts.');
      if (r.hint) parts.push(r.hint);
      setReceiptAutofillNote(parts.length ? parts.join(' ') : null);
    });
    return () => {
      cancelled = true;
    };
  }, [receiptFile]);

  useEffect(() => {
    if (!hotelAttachFile || (!hotelAttachFile.type.startsWith('image/') && hotelAttachFile.type !== 'application/pdf')) {
      setHotelAttachAutofillBusy(false);
      return;
    }
    let cancelled = false;
    setHotelAttachAutofillBusy(true);
    setHotelAttachAutofillNote(null);
    void extractReceiptAutoFill(hotelAttachFile).then((r) => {
      if (cancelled) return;
      setHotelAttachAutofillBusy(false);
      setHotelAttachForm((prev) => ({
        ...prev,
        ...(r.amount ? { amount: r.amount } : {}),
        ...(r.gst !== '' ? { gst: r.gst } : {}),
        expense_date: r.expenseDate || prev.expense_date,
      }));
      const parts: string[] = [];
      if (r.method === 'pdf-text') parts.push('Filled from PDF text.');
      else if (r.method === 'ocr') parts.push('Filled using photo text recognition; please verify amounts.');
      if (r.hint) parts.push(r.hint);
      setHotelAttachAutofillNote(parts.length ? parts.join(' ') : null);
    });
    return () => {
      cancelled = true;
    };
  }, [hotelAttachFile]);

  useEffect(() => {
    if (
      !splitWizardOpen ||
      !splitFile ||
      (!splitFile.type.startsWith('image/') && splitFile.type !== 'application/pdf')
    ) {
      setSplitAutofillBusy(false);
      return;
    }
    let cancelled = false;
    setSplitAutofillBusy(true);
    setSplitAutofillNote(null);
    void extractReceiptAutoFill(splitFile).then((r) => {
      if (cancelled) return;
      setSplitAutofillBusy(false);
      setSplitForm((prev) => ({
        ...prev,
        ...(r.amount ? { amount: r.amount } : {}),
        ...(r.gst !== '' ? { gst: r.gst } : {}),
        expense_date: r.expenseDate || prev.expense_date,
      }));
      const parts: string[] = [];
      if (r.method === 'pdf-text') parts.push('Filled from PDF text.');
      else if (r.method === 'ocr') parts.push('Filled using photo text recognition; please verify amounts.');
      if (r.hint) parts.push(r.hint);
      setSplitAutofillNote(parts.length ? parts.join(' ') : null);
    });
    return () => {
      cancelled = true;
    };
  }, [splitWizardOpen, splitFile]);

  /**
   * Begin "linking mode" — switch the receipt-upload form into a state where the
   * uploaded receipt will be attached to the selected service_ticket_expenses rows.
   * Pre-populates description/date/amount based on the selected lines and forces a
   * single line item (multi-line receipts are only for non-linked submissions).
   */
  const startReceiptLinkingForLines = (lineIds: string[]) => {
    const rows = (pendingReceiptLines as any[]).filter((r) => lineIds.includes(String(r.id)));
    if (rows.length === 0) return;
    const totalBilled = rows.reduce(
      (sum, r) => sum + (Number(r.quantity) || 0) * (Number(r.rate) || 0),
      0
    );
    const types = [...new Set(rows.map((r) => String(r.expense_type || 'Expense')))];
    const description =
      rows.length === 1
        ? rows[0].description || types[0]
        : `${types.join(' / ')} — ${rows.length} ticket lines`;
    const earliestDate =
      rows
        .map((r: any) => r.service_tickets?.date)
        .filter(Boolean)
        .sort()[0] || new Date().toISOString().split('T')[0];

    setLinkingTicketExpenseIds(lineIds);
    setLinkingTicketExpenseRows(rows);
    setReceiptForm({
      expense_date: earliestDate,
      notes: '',
      lineItems: [
        {
          id: Math.random().toString(36).slice(2),
          description,
          quantity: '1',
          rate: totalBilled.toFixed(2),
          gst: '',
          is_billable: false,
        },
      ],
    });
    setUploadError(null);
    setPendingReceiptSelectedIds(new Set());
    setTimeout(() => {
      receiptFormSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  const cancelReceiptLinking = () => {
    setLinkingTicketExpenseIds([]);
    setLinkingTicketExpenseRows([]);
    setReceiptForm(initialReceiptForm);
    setReceiptFile(null);
    setReceiptPreviewUrl(null);
    setUploadError(null);
    setReceiptAutofillNote(null);
    setReceiptAutofillBusy(false);
  };

  const handleSubmitReceipt = async () => {
    const isLinking = linkingTicketExpenseIds.length > 0;
    const validItems = receiptForm.lineItems.filter(
      (item) => item.description.trim() && lineItemSubtotal(item) > 0
    );
    if (validItems.length === 0) {
      setUploadError('At least one line item with a description and qty × rate > 0 is required');
      return;
    }
    for (const item of receiptForm.lineItems) {
      if (lineItemSubtotal(item) > 0 && !item.description.trim()) {
        setUploadError('All line items with an amount must have a description');
        return;
      }
      if (item.description.trim() && parseFloat(item.quantity) <= 0) {
        setUploadError('Quantity must be greater than 0');
        return;
      }
    }
    if (isLinking && validItems.length > 1) {
      setUploadError('When linking to ticket expenses, the receipt must be a single line item.');
      return;
    }
    setIsUploading(true);
    setUploadError(null);
    try {
      let storagePath: string | undefined;
      if (receiptFile) {
        const optimized = await optimizeImage(receiptFile, { maxWidth: 1024, maxHeight: 1024, quality: 0.8 });
        storagePath = await userExpensesService.uploadReceipt(optimized);
      }
      let firstCreatedId: string | null = null;
      for (const item of validItems) {
        const qty = parseFloat(item.quantity) || 1;
        const subtotal = lineItemSubtotal(item);
        const created = await userExpensesService.create({
          description: item.description.trim(),
          amount: subtotal,
          quantity: qty,
          expense_date: receiptForm.expense_date,
          receipt_url: storagePath,
          gst: parseFloat(item.gst) || 0,
          is_billable: item.is_billable,
          notes: receiptForm.notes.trim() || undefined,
          status: 'pending',
        });
        if (!firstCreatedId) firstCreatedId = String(created?.id || '');
      }
      if (isLinking && firstCreatedId) {
        await serviceTicketExpensesService.linkUserExpense(linkingTicketExpenseIds, firstCreatedId);
      }
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['unappliedBillableReceipts'] });
      queryClient.invalidateQueries({ queryKey: ['hotelTicketLinesNeedingReceipt'] });
      queryClient.invalidateQueries({ queryKey: ['pendingReceiptLines'] });
      setReceiptFile(null);
      setReceiptPreviewUrl(null);
      setReceiptForm(initialReceiptForm);
      setReceiptAutofillNote(null);
      setReceiptAutofillBusy(false);
      setLinkingTicketExpenseIds([]);
      setLinkingTicketExpenseRows([]);
    } catch (err: any) {
      setUploadError(err.message || 'Failed to save expense');
    } finally {
      setIsUploading(false);
    }
  };

  const handlePickTicketForMarkup = (ticketRecordId: string, ticketNumber: string) => {
    setMarkupModalTicket({ id: ticketRecordId, ticketNumber });
    setMarkupValue('0');
    setMarkupType('dollar');
    setShowTicketPickerModal(false);
  };

  const handleConfirmMarkup = async () => {
    if (!applyExpenseId || !markupModalTicket) return;
    const expense = expenses.find((e: any) => e.id === applyExpenseId);
    if (!expense) return;

    const expTotal = parseFloat(expense.amount) + parseFloat(expense.gst || 0);
    let markup = 0;
    const val = parseFloat(markupValue) || 0;
    if (markupType === 'percent') {
      markup = (expTotal * val) / 100;
    } else {
      markup = val;
    }
    const totalWithMarkup = expTotal + markup;
    // Preserve qty × rate breakdown on the customer-facing ticket line.
    // Per-unit billed rate = total / qty so the invoice renders "qty × $rate = $total".
    const ticketQty = Number(expense.quantity) || 1;
    const ticketRate = ticketQty > 0 ? Math.round((totalWithMarkup / ticketQty) * 100) / 100 : totalWithMarkup;

    setIsApplyingMarkup(true);
    try {
      await userExpensesService.update(applyExpenseId, {
        service_ticket_id: markupModalTicket.id,
        markup_amount: markup,
      });
      await serviceTicketExpensesService.create({
        service_ticket_id: markupModalTicket.id,
        expense_type: 'Expenses',
        description: expense.description,
        quantity: ticketQty,
        rate: ticketRate,
        unit: '',
        needs_reimbursement: true,
        reimbursement_status: 'pending',
      });
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['unappliedBillableReceipts'] });
      queryClient.invalidateQueries({ queryKey: ['attachedReceipts'] });
      queryClient.invalidateQueries({ queryKey: ['serviceTicketExpenseTotals'] });
      queryClient.invalidateQueries({ queryKey: ['hotelTicketLinesNeedingReceipt'] });
      setMarkupModalTicket(null);
      setApplyExpenseId(null);
    } catch (err: any) {
      alert('Failed to apply expense to ticket: ' + (err.message || 'Unknown error'));
    } finally {
      setIsApplyingMarkup(false);
    }
  };

  const handleBackToTicketPicker = () => {
    setMarkupModalTicket(null);
    setShowTicketPickerModal(true);
  };

  /** Apply-to-ticket flow spans three states (applyExpenseId, ticket picker, markup
   *  modal). Use this helper everywhere we exit so they always reset together — a
   *  partial close was the source of stuck/zombie modals when the user re-clicked the
   *  Apply button while a flow was open. */
  const closeApplyToTicketFlow = () => {
    setShowTicketPickerModal(false);
    setMarkupModalTicket(null);
    setApplyExpenseId(null);
    setDetailsTicketId(null);
    setTicketSearchQuery('');
  };
  const isApplyToTicketFlowOpen = !!applyExpenseId || showTicketPickerModal || !!markupModalTicket;

  const handleViewReceipt = async (expense: any) => {
    if (!expense.receipt_url) return;
    setLoadingReceiptId(expense.id);
    const isPdf = (expense.receipt_url || '').toLowerCase().endsWith('.pdf');
    setViewingReceiptIsPdf(isPdf);
    try {
      const signedUrl = await userExpensesService.getReceiptSignedUrl(expense.receipt_url);
      setViewingReceiptUrl(signedUrl);
    } catch {
      setViewingReceiptUrl(expense.receipt_url);
    } finally {
      setLoadingReceiptId(null);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    borderRadius: '6px',
    border: '1px solid var(--border-color)',
    backgroundColor: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    fontSize: '14px',
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '12px',
    fontWeight: '600',
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    marginBottom: '4px',
  };

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: '0 0 24px', color: 'var(--text-primary)' }}>
        Internal Expenses & Receipts
      </h1>

      {pendingReceiptLinesGated.length > 0 && (
        <div
          style={{
            marginBottom: '24px',
            padding: '16px 18px',
            borderRadius: '10px',
            border: '1px solid rgba(245, 158, 11, 0.45)',
            backgroundColor: 'rgba(245, 158, 11, 0.08)',
          }}
          role="region"
          aria-label="Ticket expenses awaiting receipts"
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: pendingReceiptCollapsed ? 0 : '12px' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <button
                type="button"
                onClick={() => setPendingReceiptCollapsed((v) => !v)}
                aria-expanded={!pendingReceiptCollapsed}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'inherit' }}
              >
                <span style={{ fontSize: '11px', color: '#b45309', transition: 'transform 0.15s', transform: pendingReceiptCollapsed ? 'rotate(0deg)' : 'rotate(90deg)', display: 'inline-block', width: '12px' }}>▶</span>
                <span style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#b45309' }}>
                  Awaiting Receipts ({pendingReceiptLinesView.length}{pendingReceiptLinesView.length !== pendingReceiptLinesGated.length ? ` of ${pendingReceiptLinesGated.length}` : ''})
                </span>
                {isAdmin && <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', backgroundColor: 'rgba(33, 150, 243, 0.18)', color: '#2196F3' }}>ADMIN VIEW</span>}
              </button>
              {!pendingReceiptCollapsed && (
              <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5, maxWidth: '720px' }}>
                {isAdmin
                  ? "All reimbursable ticket charges across employees that don't have a receipt attached yet. Filter by employee, then submit a receipt or link an existing one."
                  : "Reimbursable charges you've added to service tickets that don't have a receipt attached yet. Select one or more, then upload the actual receipt to attach it. The receipt amount may differ from what was billed to the client — the company absorbs the difference."}
              </p>
              )}
              {!pendingReceiptCollapsed && (<>
              <p style={{ margin: '8px 0 0', fontSize: '12px', color: 'var(--text-primary)', lineHeight: 1.45, maxWidth: '720px', padding: '8px 10px', borderRadius: '6px', backgroundColor: 'rgba(0, 137, 123, 0.08)', border: '1px solid rgba(0, 137, 123, 0.3)' }}>
                <strong style={{ color: '#00897b' }}>Reimbursement note:</strong> as soon as a receipt is attached, this expense is included on the next payroll for reimbursement to the employee. Lines that don't need a receipt (Mileage, Truck Hours, Per Diem, basic Equipment) are reimbursed automatically on the next payroll once flagged needs-reimbursement.
              </p>
              {isAdmin && pendingReceiptContractorSuppressedCount > 0 && (
                <p style={{ margin: '6px 0 0', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.45, maxWidth: '720px', padding: '6px 10px', borderRadius: '6px', backgroundColor: 'var(--bg-tertiary)', border: '1px dashed var(--border-color)' }}>
                  <strong>Note:</strong> {pendingReceiptContractorSuppressedCount} receipt-required line{pendingReceiptContractorSuppressedCount === 1 ? '' : 's'} hidden because the owner is a contractor — contractors invoice IONEX directly, so we don't track receipts for them here.
                </p>
              )}
              <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                {isAdmin && pendingReceiptEmpOptions.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Employee</label>
                    <select
                      value={pendingReceiptEmpFilter}
                      onChange={(e) => { setPendingReceiptEmpFilter(e.target.value); setPendingReceiptSelectedIds(new Set()); }}
                      style={{ padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '13px' }}
                    >
                      <option value="all">All employees</option>
                      {pendingReceiptEmpOptions.map((emp) => (
                        <option key={emp.id} value={emp.id}>{emp.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                {pendingReceiptTypeOptions.length > 1 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Type</label>
                    <select
                      value={pendingReceiptTypeFilter}
                      onChange={(e) => { setPendingReceiptTypeFilter(e.target.value); setPendingReceiptSelectedIds(new Set()); }}
                      style={{ padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '13px' }}
                    >
                      <option value="all">All types</option>
                      {pendingReceiptTypeOptions.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Description</label>
                  <input
                    type="text"
                    value={pendingReceiptDescFilter}
                    onChange={(e) => { setPendingReceiptDescFilter(e.target.value); setPendingReceiptSelectedIds(new Set()); }}
                    placeholder="Search…"
                    style={{ padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '13px', minWidth: '160px' }}
                  />
                </div>
                {(pendingReceiptEmpFilter !== 'all' || pendingReceiptTypeFilter !== 'all' || pendingReceiptDescFilter) && (
                  <button
                    type="button"
                    onClick={() => { setPendingReceiptEmpFilter('all'); setPendingReceiptTypeFilter('all'); setPendingReceiptDescFilter(''); setPendingReceiptSelectedIds(new Set()); }}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '11px', color: 'var(--text-secondary)', textDecoration: 'underline' }}
                  >
                    Clear filters
                  </button>
                )}
              </div>
              </>)}
            </div>
            {!pendingReceiptCollapsed && pendingReceiptSelectedIds.size > 0 && (() => {
              const selectedHotelIds = pendingReceiptLinesView
                .filter((r) => pendingReceiptSelectedIds.has(String(r.id)) && String(r.expense_type) === 'Hotel')
                .map((r) => String(r.id));
              const canSplitHotel = selectedHotelIds.length >= 2;
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0, alignSelf: 'center' }}>
                  <button
                    type="button"
                    onClick={() => startReceiptLinkingForLines([...pendingReceiptSelectedIds])}
                    style={{
                      padding: '8px 14px',
                      borderRadius: '6px',
                      backgroundColor: 'var(--primary-color)',
                      color: 'white',
                      border: 'none',
                      fontSize: '13px',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Submit receipt for {pendingReceiptSelectedIds.size} item
                    {pendingReceiptSelectedIds.size === 1 ? '' : 's'}
                  </button>
                  {canSplitHotel && (
                    <button
                      type="button"
                      onClick={() => openSplitWizard(selectedHotelIds)}
                      title="One hotel bill covering several nights — splits subtotal+tax across selected hotel lines proportionally"
                      style={{
                        padding: '8px 14px',
                        borderRadius: '6px',
                        border: '1px solid rgba(245, 158, 11, 0.6)',
                        backgroundColor: 'rgba(245, 158, 11, 0.15)',
                        color: '#92400e',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Split hotel bill across {selectedHotelIds.length} nights
                    </button>
                  )}
                </div>
              );
            })()}
          </div>

          {!pendingReceiptCollapsed && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left', color: 'var(--text-secondary)', fontSize: '11px', textTransform: 'uppercase' }}>
                  <th style={{ padding: '8px 6px', width: '32px' }}>
                    <input
                      type="checkbox"
                      checked={
                        pendingReceiptLinesView.length > 0 &&
                        pendingReceiptSelectedIds.size === pendingReceiptLinesView.length
                      }
                      onChange={(e) => {
                        if (e.target.checked) {
                          setPendingReceiptSelectedIds(
                            new Set(pendingReceiptLinesView.map((r) => String(r.id)))
                          );
                        } else {
                          setPendingReceiptSelectedIds(new Set());
                        }
                      }}
                    />
                  </th>
                  {isAdmin && <th style={{ padding: '8px 6px' }}>Employee</th>}
                  <th style={{ padding: '8px 6px' }}>Type</th>
                  <th style={{ padding: '8px 6px' }}>Description</th>
                  <th style={{ padding: '8px 6px' }}>Ticket</th>
                  <th style={{ padding: '8px 6px' }}>Date</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>Billed to client</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pendingReceiptLinesView.map((row) => {
                  const id = String(row.id);
                  const hasTicketNumber = !!(row.service_tickets?.ticket_number);
                  const tn = row.service_tickets?.ticket_number || 'Unassigned';
                  const dt = row.service_tickets?.date || '';
                  const billed = (Number(row.quantity) || 0) * (Number(row.rate) || 0);
                  const isSelected = pendingReceiptSelectedIds.has(id);
                  return (
                    <tr key={id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '10px 6px' }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            setPendingReceiptSelectedIds((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(id);
                              else next.delete(id);
                              return next;
                            });
                          }}
                        />
                      </td>
                      {isAdmin && (() => {
                        const u = row.service_tickets?.user;
                        const empName = u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email || 'Unknown' : 'Unknown';
                        return (
                          <td style={{ padding: '10px 6px', color: 'var(--text-primary)', fontWeight: 600 }}>{empName}</td>
                        );
                      })()}
                      <td style={{ padding: '10px 6px', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {row.expense_type || '—'}
                      </td>
                      <td style={{ padding: '10px 6px', color: 'var(--text-secondary)' }}>
                        {row.description || '—'}
                      </td>
                      <td style={{ padding: '10px 6px', fontFamily: hasTicketNumber ? 'monospace' : 'inherit' }}>
                        {row.service_ticket_id ? (
                          <button
                            type="button"
                            onClick={() => setViewingTicketRecordId(String(row.service_ticket_id))}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: hasTicketNumber ? 'var(--primary-color)' : 'var(--text-tertiary)', fontWeight: 600, fontFamily: hasTicketNumber ? 'monospace' : 'inherit', fontSize: 'inherit', textDecoration: 'underline', fontStyle: hasTicketNumber ? 'normal' : 'italic' }}
                            title="Open service ticket"
                          >
                            {tn}
                          </button>
                        ) : (
                          <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>{tn}</span>
                        )}
                      </td>
                      <td style={{ padding: '10px 6px', color: 'var(--text-secondary)' }}>{dt || '—'}</td>
                      <td style={{ padding: '10px 6px', textAlign: 'right', fontWeight: 600 }}>${billed.toFixed(2)}</td>
                      <td style={{ padding: '10px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button
                          type="button"
                          onClick={() => startReceiptLinkingForLines([id])}
                          style={{
                            padding: '5px 10px',
                            borderRadius: '6px',
                            border: 'none',
                            backgroundColor: 'var(--primary-color)',
                            color: 'white',
                            fontSize: '12px',
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          Submit receipt
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}
        </div>
      )}

      {hotelAttachTarget && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10003,
            backgroundColor: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={closeHotelAttachModal}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: 'var(--bg-primary)',
              borderRadius: '10px',
              width: '90%',
              maxWidth: '800px',
              maxHeight: '85vh',
              display: 'flex',
              flexDirection: 'row',
              overflow: 'hidden',
              boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}
          >
            <div
              style={{
                flex: 1,
                backgroundColor: 'var(--bg-tertiary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'auto',
                padding: '16px',
                minHeight: '360px',
              }}
            >
              <input
                type="file"
                accept="image/*,.pdf"
                ref={hotelAttachFileInputRef}
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  if (hotelAttachPreviewUrl) URL.revokeObjectURL(hotelAttachPreviewUrl);
                  setHotelAttachFile(file);
                  setHotelAttachPreviewUrl(URL.createObjectURL(file));
                }}
              />
              {hotelAttachPreviewUrl ? (
                hotelAttachFile?.type === 'application/pdf' ? (
                  <iframe
                    src={hotelAttachPreviewUrl}
                    title="PDF receipt preview"
                    style={{ width: '100%', height: '100%', minHeight: '340px', border: 'none', borderRadius: '4px' }}
                  />
                ) : (
                  <img
                    src={hotelAttachPreviewUrl}
                    alt="Receipt"
                    style={{ maxWidth: '100%', maxHeight: '65vh', objectFit: 'contain', borderRadius: '4px' }}
                  />
                )
              ) : (
                <div
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      hotelAttachFileInputRef.current?.click();
                    }
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const file = e.dataTransfer.files?.[0];
                    if (!file || (!file.type.startsWith('image/') && file.type !== 'application/pdf')) return;
                    if (hotelAttachPreviewUrl) URL.revokeObjectURL(hotelAttachPreviewUrl);
                    setHotelAttachFile(file);
                    setHotelAttachPreviewUrl(URL.createObjectURL(file));
                  }}
                  onClick={() => hotelAttachFileInputRef.current?.click()}
                  style={{
                    width: '100%',
                    minHeight: '300px',
                    border: '2px dashed var(--border-color)',
                    borderRadius: '8px',
                    background: 'transparent',
                    color: 'var(--text-tertiary)',
                    fontSize: '14px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    textAlign: 'center',
                    padding: '16px',
                  }}
                >
                  Drop receipt here or click to upload
                </div>
              )}
            </div>
            <div style={{ flex: 1, padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700' }}>Attach hotel receipt</h3>
              <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                Billed amount on the ticket stays the same. Markup is calculated as billed to client minus receipt subtotal and GST.
              </p>
              {hotelAttachError && <div style={{ color: '#ef5350', fontSize: '13px' }}>{hotelAttachError}</div>}
              {hotelAttachAutofillBusy && (
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Reading receipt…</div>
              )}
              {hotelAttachAutofillNote && !hotelAttachAutofillBusy && (
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>{hotelAttachAutofillNote}</div>
              )}
              <div>
                <label style={labelStyle}>Description</label>
                <input
                  type="text"
                  value={hotelAttachForm.description}
                  onChange={(e) => setHotelAttachForm({ ...hotelAttachForm, description: e.target.value })}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>Receipt amount ($)</label>
                <input
                  type="number"
                  step="0.01"
                  value={hotelAttachForm.amount}
                  onChange={(e) => setHotelAttachForm({ ...hotelAttachForm, amount: e.target.value })}
                  style={inputStyle}
                  placeholder="0.00"
                />
              </div>
              <div>
                <label style={labelStyle}>GST ($)</label>
                <input
                  type="number"
                  step="0.01"
                  value={hotelAttachForm.gst}
                  onChange={(e) => setHotelAttachForm({ ...hotelAttachForm, gst: e.target.value })}
                  style={inputStyle}
                  placeholder="0.00"
                />
              </div>
              <div>
                <label style={labelStyle}>Expense date</label>
                <input
                  type="date"
                  value={hotelAttachForm.expense_date}
                  onChange={(e) => setHotelAttachForm({ ...hotelAttachForm, expense_date: e.target.value })}
                  style={inputStyle}
                />
              </div>
              {hotelAttachAuto && hotelAttachAuto.clientBilled > 0 && (
                <div style={{ padding: '10px 12px', backgroundColor: 'rgba(33, 150, 243, 0.08)', borderRadius: '6px', fontSize: '13px' }}>
                  <div style={{ fontWeight: '600', marginBottom: '4px' }}>Billed to client (unchanged)</div>
                  <div>${hotelAttachAuto.clientBilled.toFixed(2)}</div>
                  <div style={{ marginTop: '8px', fontWeight: '600' }}>Auto markup: ${hotelAttachAuto.markup.toFixed(2)}</div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>Receipt total: ${hotelAttachAuto.expTotal.toFixed(2)}</div>
                </div>
              )}
              <div style={{ display: 'flex', gap: '8px', marginTop: 'auto', paddingTop: '12px' }}>
                <button
                  type="button"
                  onClick={closeHotelAttachModal}
                  style={{ flex: 1, padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'transparent', cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={hotelAttachSaving}
                  onClick={() => void handleHotelAttachSave()}
                  style={{
                    flex: 1,
                    padding: '10px',
                    borderRadius: '6px',
                    border: 'none',
                    backgroundColor: 'var(--primary-color)',
                    color: 'white',
                    fontWeight: '600',
                    cursor: hotelAttachSaving ? 'not-allowed' : 'pointer',
                    opacity: hotelAttachSaving ? 0.7 : 1,
                  }}
                >
                  {hotelAttachSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {splitWizardOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10004,
            backgroundColor: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
          }}
          onClick={closeSplitWizard}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: 'var(--bg-primary)',
              borderRadius: '10px',
              width: '100%',
              maxWidth: '960px',
              maxHeight: '90vh',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}
          >
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid var(--border-color)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '12px',
              }}
            >
              <h3 style={{ margin: 0, fontSize: '17px', fontWeight: '700', color: 'var(--text-primary)' }}>
                Split one hotel bill across tickets
              </h3>
              <button
                type="button"
                onClick={closeSplitWizard}
                style={{
                  border: 'none',
                  background: 'none',
                  fontSize: '22px',
                  lineHeight: 1,
                  cursor: 'pointer',
                  color: 'var(--text-secondary)',
                }}
                aria-label="Close"
              >
                &times;
              </button>
            </div>

            <div style={{ padding: '20px', overflowY: 'auto', flex: 1 }}>
              <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '16px' }}>
                Step {splitWizardStep} of 3
              </div>
              {splitError && (
                <div style={{ color: '#ef5350', fontSize: '13px', marginBottom: '12px' }}>{splitError}</div>
              )}

              {splitWizardStep === 1 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <p style={{ margin: 0, fontSize: '14px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    Upload the combined hotel bill or invoice (PDF or photo) — or pick an already-submitted receipt for legacy/historical entries. Enter the <strong>room subtotal</strong> and <strong>GST / taxes</strong> exactly as shown on the bill (before credits). The next step chooses which ticket lines belong to this stay.
                  </p>

                  {/* Existing-receipt picker — for the case where a receipt was already submitted before the new linking flow. */}
                  {(() => {
                    // Filter rules:
                    //   - Non-admin: only own receipts (privacy).
                    //   - Admin with ticket lines selected: restrict to that user — admin
                    //     already committed to whose stay this is, so other employees'
                    //     receipts are noise.
                    //   - Admin with no lines selected yet: show all unlinked receipts so
                    //     they can pick a shared hotel bill before checking lines.
                    const selectedUserId = splitSelectedRows[0]?.service_tickets?.user_id ?? null;
                    const targetUserId =
                      selectedUserId
                      ?? hotelLinesStillNeedReceipt[0]?.service_tickets?.user_id
                      ?? user?.id
                      ?? null;
                    const candidates = (expenses as any[])
                      .filter((e) => {
                        if (!e.receipt_url) return false;
                        if (!isAdmin) {
                          if (!targetUserId || e.user_id !== targetUserId) return false;
                        } else if (selectedUserId) {
                          if (e.user_id !== selectedUserId) return false;
                        }
                        // Skip receipts already applied to a ticket directly OR linked via service_ticket_expenses.user_expense_id.
                        if (e.service_ticket_id) return false;
                        if (linkedByReceiptId.has(String(e.id))) return false;
                        return true;
                      })
                      .sort((a, b) => {
                        // Pin receipts whose owner matches the selected ticket lines to the top
                        // (most likely match) — then date desc within each group.
                        const aMatch = targetUserId && a.user_id === targetUserId ? 0 : 1;
                        const bMatch = targetUserId && b.user_id === targetUserId ? 0 : 1;
                        if (aMatch !== bMatch) return aMatch - bMatch;
                        return String(b.expense_date || '').localeCompare(String(a.expense_date || ''));
                      })
                      .slice(0, 200);
                    return (
                      <div>
                        <label style={labelStyle}>Use an existing receipt (optional)</label>
                        <select
                          value={splitExistingReceiptId ?? ''}
                          onChange={(e) => {
                            const id = e.target.value || null;
                            setSplitExistingReceiptId(id);
                            if (id) {
                              const r = candidates.find((c) => String(c.id) === id);
                              if (r) {
                                // Pre-fill the wizard fields from the existing receipt and clear any uploaded file.
                                setSplitForm({
                                  amount: String(parseFloat(r.amount) || 0),
                                  gst: String(parseFloat(r.gst || 0) || 0),
                                  expense_date: r.expense_date || new Date().toISOString().split('T')[0],
                                });
                                if (splitPreviewUrl) URL.revokeObjectURL(splitPreviewUrl);
                                setSplitPreviewUrl(null);
                                setSplitFile(null);
                              }
                            }
                          }}
                          style={{ ...inputStyle, marginTop: '4px' }}
                        >
                          <option value="">— Upload a new file instead —</option>
                          {candidates.map((r: any) => {
                            const empName = r.users
                              ? `${r.users.first_name || ''} ${r.users.last_name || ''}`.trim() || r.users.email || ''
                              : '';
                            const total = (parseFloat(r.amount) || 0) + (parseFloat(r.gst) || 0);
                            return (
                              <option key={String(r.id)} value={String(r.id)}>
                                {r.expense_date || '?'} · {r.description || 'Receipt'} · ${total.toFixed(2)}{isAdmin && empName ? ` · ${empName}` : ''}
                              </option>
                            );
                          })}
                        </select>
                        {splitExistingReceiptId && (() => {
                          const r = candidates.find((c) => String(c.id) === splitExistingReceiptId);
                          if (!r) return null;
                          return (
                            <div style={{ marginTop: '6px', padding: '8px 10px', borderRadius: '6px', backgroundColor: 'rgba(0, 137, 123, 0.08)', border: '1px solid rgba(0, 137, 123, 0.3)', fontSize: '12px', color: 'var(--text-secondary)' }}>
                              Using existing receipt: <strong style={{ color: 'var(--text-primary)' }}>{r.description || 'Receipt'}</strong>
                              {' '}· ${((parseFloat(r.amount) || 0) + (parseFloat(r.gst) || 0)).toFixed(2)}
                              {' '}· {r.expense_date || '—'}
                              <button
                                type="button"
                                onClick={() => {
                                  setSplitExistingReceiptId(null);
                                  setSplitForm({ amount: '', gst: '', expense_date: new Date().toISOString().split('T')[0] });
                                }}
                                style={{ marginLeft: '10px', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--primary-color)', fontSize: '12px', textDecoration: 'underline' }}
                              >
                                Clear
                              </button>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })()}

                  {splitAutofillBusy && (
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Reading receipt…</div>
                  )}
                  {splitAutofillNote && !splitAutofillBusy && (
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>{splitAutofillNote}</div>
                  )}
                  <input
                    ref={splitFileInputRef}
                    type="file"
                    accept="image/*,.pdf"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      setSplitPreviewUrl((prev) => {
                        if (prev) URL.revokeObjectURL(prev);
                        return URL.createObjectURL(file);
                      });
                      setSplitFile(file);
                    }}
                  />
                  {splitExistingReceiptId ? null : !splitPreviewUrl ? (
                    <button
                      type="button"
                      onClick={() => splitFileInputRef.current?.click()}
                      style={{
                        padding: '24px',
                        border: '2px dashed var(--border-color)',
                        borderRadius: '8px',
                        background: 'var(--bg-tertiary)',
                        cursor: 'pointer',
                        fontSize: '14px',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      Choose receipt file (image or PDF)
                    </button>
                  ) : (
                    <div style={{ borderRadius: '8px', overflow: 'hidden', backgroundColor: 'var(--bg-tertiary)', minHeight: '200px' }}>
                      {splitFile?.type === 'application/pdf' ? (
                        <iframe
                          src={splitPreviewUrl}
                          title="Receipt PDF"
                          style={{ width: '100%', height: '280px', border: 'none' }}
                        />
                      ) : (
                        <img src={splitPreviewUrl} alt="Receipt preview" style={{ maxWidth: '100%', maxHeight: '280px', objectFit: 'contain', display: 'block', margin: '0 auto' }} />
                      )}
                      <div style={{ padding: '8px' }}>
                        <button type="button" onClick={() => splitFileInputRef.current?.click()} style={{ fontSize: '12px', color: 'var(--primary-color)', border: 'none', background: 'none', cursor: 'pointer' }}>
                          Replace file
                        </button>
                      </div>
                    </div>
                  )}
                  <div>
                    <label style={labelStyle}>Bill subtotal before tax ($)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={splitForm.amount}
                      onChange={(e) => setSplitForm({ ...splitForm, amount: e.target.value })}
                      style={inputStyle}
                      placeholder="e.g. 1272.00"
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Tax on bill ($)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={splitForm.gst}
                      onChange={(e) => setSplitForm({ ...splitForm, gst: e.target.value })}
                      style={inputStyle}
                      placeholder="e.g. 114.48"
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Expense date</label>
                    <input
                      type="date"
                      value={splitForm.expense_date}
                      onChange={(e) => setSplitForm({ ...splitForm, expense_date: e.target.value })}
                      style={inputStyle}
                    />
                  </div>
                </div>
              )}

              {splitWizardStep === 2 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <p style={{ margin: 0, fontSize: '14px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    Select every service-ticket hotel line that this bill covers (for example each night on its own ticket). Allocation uses each line&apos;s <strong>billed to client</strong> amount as the weight.
                  </p>
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => {
                        const all = hotelLinesStillNeedReceipt.map((r: any) => String(r.id));
                        setSplitSelectedLineIds(new Set(all));
                      }}
                      style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', cursor: 'pointer', fontSize: '12px', fontWeight: '600' }}
                    >
                      Select all below
                    </button>
                    <button
                      type="button"
                      onClick={() => setSplitSelectedLineIds(new Set())}
                      style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', cursor: 'pointer', fontSize: '12px', fontWeight: '600' }}
                    >
                      Clear selection
                    </button>
                    <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', alignSelf: 'center' }}>
                      {splitSelectedLineIds.size} selected (need at least 2)
                    </span>
                  </div>
                  <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden' }}>
                    {hotelLinesStillNeedReceipt.map((row: any) => {
                      const id = String(row.id);
                      const tn = row.service_tickets?.ticket_number || '—';
                      const billed = (Number(row.quantity) || 0) * (Number(row.rate) || 0);
                      return (
                        <label
                          key={id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '12px',
                            padding: '10px 12px',
                            borderBottom: '1px solid var(--border-color)',
                            cursor: 'pointer',
                            fontSize: '13px',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={splitSelectedLineIds.has(id)}
                            onChange={(e) => {
                              setSplitSelectedLineIds((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(id);
                                else next.delete(id);
                                return next;
                              });
                            }}
                          />
                          <span style={{ flex: 1 }}>
                            <strong>{row.description || 'Hotel'}</strong>
                            <span style={{ color: 'var(--text-tertiary)' }}>{' · Ticket '}{tn}</span>
                          </span>
                          <span style={{ fontWeight: '600', fontFamily: 'monospace' }}>${billed.toFixed(2)}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {splitWizardStep === 3 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <p style={{ margin: 0, fontSize: '14px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    <strong>Your share of bill</strong> is the portion of the receipt (room subtotal + tax from step 1) you assign to each ticket. Edit the amounts to match how the hotel charge maps to client billings.{' '}
                    <strong>Markup</strong> = billed to client − that share. If the allocated total is less than the full bill, the rest is saved as a separate <strong>non-billable</strong> expense (reimbursement only, not tied to a ticket).
                  </p>
                  {!splitEffectiveAllocation ? (
                    <div style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>
                      Go back and check subtotal, tax, and selected lines (each needs a positive billed amount).
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          onClick={() => {
                            if (!splitAllocationPreview) return;
                            prevSplitAllocKeyRef.current = '';
                            const next: Record<string, string> = {};
                            for (const l of splitAllocationPreview) {
                              next[String(l.row.id)] = l.cost.toFixed(2);
                            }
                            setSplitManualCostOverrides(next);
                            prevSplitAllocKeyRef.current = splitAllocKey;
                          }}
                          style={{
                            padding: '6px 12px',
                            borderRadius: '6px',
                            border: '1px solid var(--border-color)',
                            background: 'var(--bg-secondary)',
                            cursor: 'pointer',
                            fontSize: '12px',
                            fontWeight: '600',
                          }}
                        >
                          Reset to proportional split
                        </button>
                      </div>
                      {splitEffectiveAllocation.sumAllocated > splitEffectiveAllocation.totalBill + 0.02 && (
                        <div style={{ color: '#b91c1c', fontSize: '13px', fontWeight: '600' }}>
                          Allocated ${splitEffectiveAllocation.sumAllocated.toFixed(2)} exceeds bill $
                          {splitEffectiveAllocation.totalBill.toFixed(2)} — reduce amounts or fix step 1 totals.
                        </div>
                      )}
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                          <thead>
                            <tr style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: '11px', textTransform: 'uppercase', borderBottom: '1px solid var(--border-color)' }}>
                              <th style={{ padding: '8px 6px' }}>Ticket</th>
                              <th style={{ padding: '8px 6px' }}>Line</th>
                              <th style={{ padding: '8px 6px', textAlign: 'right' }}>% of billed</th>
                              <th style={{ padding: '8px 6px', textAlign: 'right' }}>Billed</th>
                              <th style={{ padding: '8px 6px', textAlign: 'right' }}>Your share of bill</th>
                              <th style={{ padding: '8px 6px', textAlign: 'right' }}>Markup</th>
                            </tr>
                          </thead>
                          <tbody>
                            {splitEffectiveAllocation.lines.map((line) => {
                              const tn = line.row.service_tickets?.ticket_number || '—';
                              const id = String(line.row.id);
                              return (
                                <tr key={id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                  <td style={{ padding: '8px 6px', fontFamily: 'monospace' }}>{tn}</td>
                                  <td style={{ padding: '8px 6px' }}>{line.row.description || 'Hotel'}</td>
                                  <td style={{ padding: '8px 6px', textAlign: 'right' }}>{line.pct.toFixed(1)}%</td>
                                  <td style={{ padding: '8px 6px', textAlign: 'right', fontWeight: '600' }}>${line.billed.toFixed(2)}</td>
                                  <td style={{ padding: '8px 6px', textAlign: 'right' }}>
                                    <span style={{ color: 'var(--text-tertiary)', marginRight: '4px' }}>$</span>
                                    <input
                                      type="number"
                                      step="0.01"
                                      min={0}
                                      value={splitManualCostOverrides[id] ?? line.cost.toFixed(2)}
                                      onChange={(e) => {
                                        setSplitManualCostOverrides((prev) => ({
                                          ...prev,
                                          [id]: e.target.value,
                                        }));
                                      }}
                                      style={{
                                        width: '88px',
                                        padding: '4px 6px',
                                        borderRadius: '4px',
                                        border: '1px solid var(--border-color)',
                                        fontSize: '13px',
                                        textAlign: 'right',
                                      }}
                                    />
                                  </td>
                                  <td style={{ padding: '8px 6px', textAlign: 'right', color: line.markup >= 0 ? '#15803d' : '#b91c1c' }}>${line.markup.toFixed(2)}</td>
                                </tr>
                              );
                            })}
                            {splitEffectiveAllocation.remainder > 0.02 && (
                              <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'rgba(245, 158, 11, 0.08)' }}>
                                <td colSpan={3} style={{ padding: '8px 6px', fontStyle: 'italic', color: 'var(--text-secondary)' }}>
                                  Unallocated (not billed to client)
                                </td>
                                <td style={{ padding: '8px 6px', textAlign: 'right', color: 'var(--text-tertiary)' }}>—</td>
                                <td style={{ padding: '8px 6px', textAlign: 'right', fontWeight: '600' }}>
                                  ${splitEffectiveAllocation.remainder.toFixed(2)}
                                </td>
                                <td style={{ padding: '8px 6px', textAlign: 'right', color: 'var(--text-tertiary)' }}>—</td>
                              </tr>
                            )}
                            <tr style={{ fontWeight: '700', borderTop: '2px solid var(--border-color)' }}>
                              <td colSpan={3} style={{ padding: '10px 6px' }}>Totals</td>
                              <td style={{ padding: '10px 6px', textAlign: 'right' }}>
                                ${splitEffectiveAllocation.lines.reduce((s, l) => s + l.billed, 0).toFixed(2)}
                              </td>
                              <td style={{ padding: '10px 6px', textAlign: 'right' }}>
                                ${splitEffectiveAllocation.sumAllocated.toFixed(2)} / ${splitEffectiveAllocation.totalBill.toFixed(2)}
                              </td>
                              <td style={{ padding: '10px 6px', textAlign: 'right' }}>
                                ${splitEffectiveAllocation.lines.reduce((s, l) => s + l.markup, 0).toFixed(2)}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            <div
              style={{
                padding: '14px 20px',
                borderTop: '1px solid var(--border-color)',
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '10px',
                flexWrap: 'wrap',
              }}
            >
              {splitWizardStep > 1 && (
                <button
                  type="button"
                  onClick={() => {
                    setSplitError(null);
                    setSplitWizardStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3) : s));
                  }}
                  style={{ padding: '10px 16px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'transparent', cursor: 'pointer' }}
                >
                  Back
                </button>
              )}
              <button
                type="button"
                onClick={closeSplitWizard}
                style={{ padding: '10px 16px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'transparent', cursor: 'pointer' }}
              >
                Cancel
              </button>
              {splitWizardStep < 3 ? (
                <button
                  type="button"
                  onClick={() => {
                    setSplitError(null);
                    if (splitWizardStep === 1) {
                      if (!splitFile && !splitExistingReceiptId) {
                        setSplitError('Choose the receipt file or pick an existing receipt.');
                        return;
                      }
                      if (!(parseFloat(splitForm.amount) > 0)) {
                        setSplitError('Enter the bill subtotal before tax.');
                        return;
                      }
                      setSplitWizardStep(2);
                      return;
                    }
                    if (splitWizardStep === 2) {
                      if (splitSelectedLineIds.size < 2) {
                        setSplitError('Select at least two ticket lines.');
                        return;
                      }
                      const rows = hotelLinesStillNeedReceipt.filter((r: any) => splitSelectedLineIds.has(String(r.id)));
                      const bad = rows.some(
                        (r: any) => !((Number(r.quantity) || 1) * (Number(r.rate) || 0) > 0)
                      );
                      if (bad) {
                        setSplitError('Each selected line must have an amount billed to the client.');
                        return;
                      }
                      setSplitWizardStep(3);
                    }
                  }}
                  style={{
                    padding: '10px 18px',
                    borderRadius: '6px',
                    border: 'none',
                    backgroundColor: 'var(--primary-color)',
                    color: 'white',
                    fontWeight: '600',
                    cursor: 'pointer',
                  }}
                >
                  Next
                </button>
              ) : (
                <button
                  type="button"
                  disabled={
                    splitSaving ||
                    !splitEffectiveAllocation ||
                    (!splitFile && !splitExistingReceiptId) ||
                    splitEffectiveAllocation.sumAllocated > splitEffectiveAllocation.totalBill + 0.02
                  }
                  onClick={() => void handleSplitWizardSave()}
                  style={{
                    padding: '10px 18px',
                    borderRadius: '6px',
                    border: 'none',
                    backgroundColor: 'var(--primary-color)',
                    color: 'white',
                    fontWeight: '600',
                    cursor:
                      splitSaving ||
                      !splitEffectiveAllocation ||
                      (!splitFile && !splitExistingReceiptId) ||
                      splitEffectiveAllocation.sumAllocated > splitEffectiveAllocation.totalBill + 0.02
                        ? 'not-allowed'
                        : 'pointer',
                    opacity:
                      splitSaving ||
                      !splitEffectiveAllocation ||
                      (!splitFile && !splitExistingReceiptId) ||
                      splitEffectiveAllocation.sumAllocated > splitEffectiveAllocation.totalBill + 0.02
                        ? 0.6
                        : 1,
                  }}
                >
                  {splitSaving ? 'Saving…' : 'Save all lines'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Admin: Employee Overview (like Service Tickets) */}
      {isAdmin && expenseEmployeeSummary.length > 0 && (
        <div style={{ marginBottom: '24px' }}>
          <button
            onClick={() => setShowExpenseEmployeeOverview(!showExpenseEmployeeOverview)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: '600',
              color: 'var(--text-primary)',
              padding: '8px 0',
            }}
          >
            <span style={{
              display: 'inline-block',
              transition: 'transform 0.2s ease',
              transform: showExpenseEmployeeOverview ? 'rotate(90deg)' : 'rotate(0deg)',
              fontSize: '12px',
            }}>&#9654;</span>
            Employee Overview
            <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', fontWeight: '400' }}>
              ({expenseEmployeeSummary.length} employee{expenseEmployeeSummary.length !== 1 ? 's' : ''})
            </span>
            {(() => {
              const totalUnpaid = expenseEmployeeSummary.reduce((s, e) => s + e.unpaid, 0);
              if (totalUnpaid === 0) return null;
              return (
                <span style={{
                  marginLeft: '4px',
                  padding: '2px 8px',
                  borderRadius: '10px',
                  fontSize: '11px',
                  fontWeight: '700',
                  backgroundColor: '#ff9800',
                  color: 'white',
                }}>{totalUnpaid} unpaid</span>
              );
            })()}
          </button>

          {showExpenseEmployeeOverview && (
            <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
                    <th style={{ padding: '14px 16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Employee</th>
                    <th style={{ padding: '14px 16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: '#ff9800', textTransform: 'uppercase', width: '100px' }}>Unpaid</th>
                    <th style={{ padding: '14px 16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: '#3b82f6', textTransform: 'uppercase', width: '100px' }}>Paid</th>
                  </tr>
                </thead>
                <tbody>
                  {expenseEmployeeSummary.map((emp) => {
                    const isExpanded = expandedExpenseEmployeeId === emp.userId;
                    return (
                      <Fragment key={emp.userId}>
                        <tr
                          onClick={() => setExpandedExpenseEmployeeId(isExpanded ? null : emp.userId)}
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
                            <span style={{ color: emp.unpaid > 0 ? '#ff9800' : 'var(--text-tertiary)', fontWeight: emp.unpaid > 0 ? '700' : '400' }}>{emp.unpaid}</span>
                          </td>
                          <td style={{ padding: '14px 16px', textAlign: 'center', fontSize: '14px', fontFamily: 'monospace' }}>
                            <span style={{ color: emp.paid > 0 ? '#3b82f6' : 'var(--text-tertiary)' }}>{emp.paid}</span>
                          </td>
                        </tr>
                        {isExpanded && (() => {
                          const allItems = [...expandedExpenseEmployeeByStatus.unpaid, ...expandedExpenseEmployeeByStatus.paid] as any[];
                          const selectedRowsForEmp = allItems
                            .filter((it) => overviewSelectedKeys.has(`${it._source}-${it.id}`))
                            .map((it) => ({ id: String(it.id), source: it._source as 'receipt' | 'ticket', status: it._status as 'paid' | 'unpaid' }));
                          const selectedAmount = allItems
                            .filter((it) => overviewSelectedKeys.has(`${it._source}-${it.id}`))
                            .reduce((s, it) => s + (Number(it._amount) || 0), 0);
                          return (
                          <tr>
                            <td colSpan={3} style={{ padding: '0' }}>
                              <div style={{ backgroundColor: 'var(--bg-secondary)', borderBottom: '2px solid var(--border-color)', padding: '4px 0' }}>
                                {/* Batch action bar — shows when any rows in this employee are selected. */}
                                {selectedRowsForEmp.length > 0 && (
                                  <div style={{ padding: '8px 16px 8px 32px', display: 'flex', alignItems: 'center', gap: '10px', backgroundColor: 'rgba(33, 150, 243, 0.06)', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
                                    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                                      {selectedRowsForEmp.length} selected · ${selectedAmount.toFixed(2)}
                                    </span>
                                    {selectedRowsForEmp.some((r) => r.status === 'unpaid') && (
                                      <button
                                        type="button"
                                        disabled={overviewBatchBusy}
                                        onClick={() => handleOverviewBatchStatusChange(selectedRowsForEmp.filter((r) => r.status === 'unpaid').map(({ id, source }) => ({ id, source })), 'paid')}
                                        style={{ padding: '4px 10px', backgroundColor: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6', border: '1px solid rgba(59, 130, 246, 0.4)', borderRadius: '4px', fontSize: '11px', fontWeight: 600, cursor: overviewBatchBusy ? 'not-allowed' : 'pointer' }}
                                      >
                                        {overviewBatchBusy ? 'Working…' : 'Mark Paid'}
                                      </button>
                                    )}
                                    {selectedRowsForEmp.some((r) => r.status === 'paid') && (
                                      <button
                                        type="button"
                                        disabled={overviewBatchBusy}
                                        onClick={() => handleOverviewBatchStatusChange(selectedRowsForEmp.filter((r) => r.status === 'paid').map(({ id, source }) => ({ id, source })), 'pending')}
                                        style={{ padding: '4px 10px', backgroundColor: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.4)', borderRadius: '4px', fontSize: '11px', fontWeight: 600, cursor: overviewBatchBusy ? 'not-allowed' : 'pointer' }}
                                      >
                                        {overviewBatchBusy ? 'Working…' : 'Mark Unpaid'}
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => setOverviewSelectedKeys(new Set())}
                                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '11px', color: 'var(--text-secondary)', textDecoration: 'underline' }}
                                    >
                                      Clear selection
                                    </button>
                                  </div>
                                )}
                                {([
                                  { key: 'unpaid', label: 'Unpaid', color: '#ff9800', items: expandedExpenseEmployeeByStatus.unpaid },
                                  { key: 'paid', label: 'Paid', color: '#3b82f6', items: expandedExpenseEmployeeByStatus.paid },
                                ] as const).map(section => {
                                  const sectionOpen = expandedExpenseStatusSections[emp.userId]?.has(section.key) || false;
                                  const sectionKeys = section.items.map((it: any) => `${it._source}-${it.id}`);
                                  const allSelected = sectionKeys.length > 0 && sectionKeys.every((k) => overviewSelectedKeys.has(k));
                                  const anySelected = sectionKeys.some((k) => overviewSelectedKeys.has(k));
                                  return (
                                    <div key={section.key}>
                                      <div
                                        style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: '8px',
                                          width: '100%',
                                          padding: '8px 16px 8px 16px',
                                        }}
                                      >
                                        {section.items.length > 0 && (
                                          <input
                                            type="checkbox"
                                            checked={allSelected}
                                            ref={(el) => { if (el) el.indeterminate = !allSelected && anySelected; }}
                                            onClick={(e) => e.stopPropagation()}
                                            onChange={(e) => {
                                              setOverviewSelectedKeys((prev) => {
                                                const next = new Set(prev);
                                                if (e.target.checked) sectionKeys.forEach((k) => next.add(k));
                                                else sectionKeys.forEach((k) => next.delete(k));
                                                return next;
                                              });
                                            }}
                                            style={{ marginLeft: '8px' }}
                                            title={allSelected ? `Deselect all ${section.label.toLowerCase()}` : `Select all ${section.label.toLowerCase()}`}
                                          />
                                        )}
                                        <button
                                          onClick={(e) => { e.stopPropagation(); toggleExpenseStatusSection(emp.userId, section.key); }}
                                          style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '8px',
                                            flex: 1,
                                            padding: 0,
                                            background: 'none',
                                            border: 'none',
                                            cursor: 'pointer',
                                            fontSize: '13px',
                                            fontWeight: '600',
                                            color: section.color,
                                            textAlign: 'left',
                                          }}
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
                                            backgroundColor: section.items.length > 0 ? `${section.color}18` : 'transparent',
                                            color: section.items.length > 0 ? section.color : 'var(--text-tertiary)',
                                          }}>{section.items.length}</span>
                                        </button>
                                      </div>
                                      {sectionOpen && section.items.length > 0 && (
                                        <div style={{ paddingBottom: '4px' }}>
                                          {section.items.map((exp: any) => {
                                            const key = `${exp._source}-${exp.id}`;
                                            const isChecked = overviewSelectedKeys.has(key);
                                            return (
                                              <div
                                                key={key}
                                                style={{
                                                  padding: '8px 16px 8px 36px',
                                                  fontSize: '13px',
                                                  color: 'var(--text-secondary)',
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  gap: '10px',
                                                  borderBottom: '1px solid var(--border-color)',
                                                  backgroundColor: isChecked ? 'rgba(33, 150, 243, 0.06)' : undefined,
                                                }}
                                              >
                                                <input
                                                  type="checkbox"
                                                  checked={isChecked}
                                                  onClick={(e) => e.stopPropagation()}
                                                  onChange={(e) => {
                                                    setOverviewSelectedKeys((prev) => {
                                                      const next = new Set(prev);
                                                      if (e.target.checked) next.add(key);
                                                      else next.delete(key);
                                                      return next;
                                                    });
                                                  }}
                                                />
                                                <span
                                                  role={exp._source === 'receipt' ? 'button' : undefined}
                                                  tabIndex={exp._source === 'receipt' ? 0 : undefined}
                                                  onClick={exp._source === 'receipt' ? () => handleStartEdit(exp) : undefined}
                                                  onKeyDown={exp._source === 'receipt' ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleStartEdit(exp); } } : undefined}
                                                  style={{ flex: 1, cursor: exp._source === 'receipt' ? 'pointer' : 'default' }}
                                                >
                                                  {exp.description} {exp._ticketNumber ? `(${exp._ticketNumber})` : ''}
                                                </span>
                                                <span style={{ fontWeight: '600' }}>${exp._amount.toFixed(2)}</span>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </td>
                          </tr>
                          );
                        })()}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', fontWeight: '700' }}>
                    <td style={{ padding: '14px 16px', fontSize: '13px', color: 'var(--text-secondary)' }}>Total</td>
                    <td style={{ padding: '14px 16px', textAlign: 'center', fontSize: '14px', fontFamily: 'monospace', color: '#ff9800' }}>
                      {expenseEmployeeSummary.reduce((s, e) => s + e.unpaid, 0)}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'center', fontSize: '14px', fontFamily: 'monospace', color: '#3b82f6' }}>
                      {expenseEmployeeSummary.reduce((s, e) => s + e.paid, 0)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Drag and Drop Zone */}
      <input
        type="file"
        accept="image/*,.pdf"
        ref={fileInputRef}
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFileDrop(file);
          e.target.value = '';
        }}
      />
      {!receiptPreviewUrl && linkingTicketExpenseIds.length === 0 && (
        <div
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); }}
          onDragLeave={(e) => { e.preventDefault(); setIsDragOver(false); }}
          onDrop={(e) => {
            e.preventDefault(); e.stopPropagation();
            setIsDragOver(false);
            const file = e.dataTransfer.files?.[0];
            if (file) handleFileDrop(file);
          }}
          onClick={() => fileInputRef.current?.click()}
          style={{
            padding: '40px 24px',
            borderRadius: '10px',
            border: `2px dashed ${isDragOver ? 'var(--primary-color)' : 'var(--border-color)'}`,
            backgroundColor: isDragOver ? 'rgba(33, 150, 243, 0.04)' : 'var(--bg-tertiary)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-tertiary)',
            fontSize: '15px',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'border-color 0.2s, background-color 0.2s',
            marginBottom: '24px',
          }}
        >
          <div style={{ fontSize: '32px', marginBottom: '8px', opacity: 0.5 }}>&#128206;</div>
          <div style={{ fontWeight: '600', color: 'var(--text-secondary)' }}>Drop a receipt here, or click to upload</div>
          <div style={{ fontSize: '12px', marginTop: '4px' }}>Supports images and PDFs</div>
        </div>
      )}

      {/* Split View: Receipt Preview + Form (also shown in linking mode without a file yet) */}
      {(receiptPreviewUrl || linkingTicketExpenseIds.length > 0) && (
        <div ref={receiptFormSectionRef} style={{
          display: 'flex',
          gap: '20px',
          marginBottom: '24px',
          backgroundColor: 'var(--bg-primary)',
          borderRadius: '10px',
          border: '1px solid var(--border-color)',
          overflow: 'hidden',
          minHeight: '400px',
        }}>
          {/* Left: Receipt Preview (or drop zone if linking mode without file yet) */}
          <div style={{
            flex: 1,
            backgroundColor: 'var(--bg-tertiary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
            overflow: 'auto',
          }}>
            {receiptPreviewUrl ? (
              receiptFile && receiptFile.type === 'application/pdf' ? (
                <iframe
                  src={receiptPreviewUrl}
                  title="PDF receipt preview"
                  style={{ width: '100%', height: '100%', minHeight: '380px', border: 'none', borderRadius: '4px' }}
                />
              ) : (
                <img
                  src={receiptPreviewUrl}
                  alt="Receipt preview"
                  style={{ maxWidth: '100%', maxHeight: '60vh', objectFit: 'contain', borderRadius: '4px' }}
                />
              )
            ) : (
              <div
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); }}
                onDragLeave={(e) => { e.preventDefault(); setIsDragOver(false); }}
                onDrop={(e) => {
                  e.preventDefault(); e.stopPropagation();
                  setIsDragOver(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file) handleFileDrop(file);
                }}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  width: '100%',
                  minHeight: '360px',
                  padding: '24px',
                  borderRadius: '10px',
                  border: `2px dashed ${isDragOver ? 'var(--primary-color)' : 'var(--border-color)'}`,
                  backgroundColor: isDragOver ? 'rgba(33, 150, 243, 0.04)' : 'var(--bg-secondary)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text-tertiary)',
                  fontSize: '14px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  transition: 'border-color 0.2s, background-color 0.2s',
                }}
              >
                <div style={{ fontSize: '28px', marginBottom: '8px', opacity: 0.5 }}>&#128206;</div>
                <div style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>Drop the receipt here</div>
                <div style={{ fontSize: '12px', marginTop: '4px' }}>or click to upload (image/PDF)</div>
              </div>
            )}
          </div>

          {/* Right: Form Inputs */}
          <div style={{ flex: 1, padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)' }}>
              {linkingTicketExpenseIds.length > 0 ? 'Submit Receipt for Ticket Expenses' : 'New Receipt Expense'}
            </h3>
            {uploadError && <div style={{ color: '#ef5350', fontSize: '13px' }}>{uploadError}</div>}
            {receiptAutofillBusy && (
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Reading receipt…</div>
            )}
            {receiptAutofillNote && !receiptAutofillBusy && (
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>{receiptAutofillNote}</div>
            )}

            {linkingTicketExpenseIds.length > 0 && (() => {
              const billedTotal = linkingTicketExpenseRows.reduce(
                (sum, r: any) => sum + (Number(r.quantity) || 0) * (Number(r.rate) || 0),
                0
              );
              const receiptAmount = receiptForm.lineItems.reduce(
                (sum, li) => sum + lineItemSubtotal(li) + (parseFloat(li.gst) || 0),
                0
              );
              const diff = receiptAmount - billedTotal;
              return (
                <div
                  style={{
                    padding: '12px 14px',
                    borderRadius: '8px',
                    border: '1px solid rgba(33, 150, 243, 0.35)',
                    backgroundColor: 'rgba(33, 150, 243, 0.06)',
                    fontSize: '12px',
                    lineHeight: 1.5,
                    color: 'var(--text-secondary)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', gap: '8px' }}>
                    <strong style={{ color: 'var(--text-primary)', fontSize: '13px' }}>
                      Linking to {linkingTicketExpenseRows.length} ticket expense
                      {linkingTicketExpenseRows.length === 1 ? '' : 's'}
                    </strong>
                    <button
                      type="button"
                      onClick={cancelReceiptLinking}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '11px', color: 'var(--text-secondary)', textDecoration: 'underline' }}
                    >
                      Cancel link
                    </button>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '18px', maxHeight: '120px', overflowY: 'auto' }}>
                    {linkingTicketExpenseRows.map((r: any) => {
                      const tn = r.service_tickets?.ticket_number || '—';
                      const dt = r.service_tickets?.date || '';
                      const billed = (Number(r.quantity) || 0) * (Number(r.rate) || 0);
                      return (
                        <li key={r.id} style={{ marginBottom: '2px' }}>
                          {r.expense_type} — {tn} {dt ? `(${dt})` : ''} <span style={{ float: 'right', fontWeight: 600, color: 'var(--text-primary)' }}>${billed.toFixed(2)}</span>
                        </li>
                      );
                    })}
                  </ul>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr 1fr',
                      gap: '8px',
                      marginTop: '10px',
                      paddingTop: '10px',
                      borderTop: '1px solid rgba(33, 150, 243, 0.25)',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)' }}>Billed to client</div>
                      <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>${billedTotal.toFixed(2)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)' }}>Your receipt</div>
                      <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>${receiptAmount.toFixed(2)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)' }}>Difference</div>
                      <div
                        style={{
                          fontSize: '14px',
                          fontWeight: 700,
                          color: Math.abs(diff) < 0.005 ? 'var(--text-tertiary)' : diff > 0 ? '#b45309' : '#15803d',
                        }}
                      >
                        {diff >= 0 ? '+' : ''}${diff.toFixed(2)}
                      </div>
                    </div>
                  </div>
                  {Math.abs(diff) >= 0.005 && (
                    <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                      {diff > 0
                        ? 'Receipt is more than billed — company absorbs the difference. You will be reimbursed for the receipt amount.'
                        : 'Receipt is less than billed — the client was billed more than your actual cost.'}
                    </div>
                  )}
                </div>
              );
            })()}

            <div>
              <label style={labelStyle}>Date</label>
              <input type="date" value={receiptForm.expense_date} onChange={(e) => setReceiptForm({ ...receiptForm, expense_date: e.target.value })} style={inputStyle} />
            </div>

            <div>
              {/* Section header with "mark all" toggle */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <label style={labelStyle}>Line Items</label>
                {receiptForm.lineItems.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      const allOn = receiptForm.lineItems.every((li) => li.is_billable);
                      setReceiptForm({ ...receiptForm, lineItems: receiptForm.lineItems.map((li) => ({ ...li, is_billable: !allOn })) });
                    }}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '11px', color: 'var(--primary-color)', fontWeight: 600 }}
                  >
                    {receiptForm.lineItems.every((li) => li.is_billable) ? 'Clear all billable' : 'Mark all billable'}
                  </button>
                )}
              </div>

              {/* Column headers */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 56px 80px 72px 78px 24px', gap: '6px', marginBottom: '4px' }}>
                <span style={labelStyle}>Description</span>
                <span style={labelStyle}>Qty</span>
                <span style={labelStyle}>Rate ($)</span>
                <span style={labelStyle}>GST ($)</span>
                <span />
                <span />
              </div>

              {/* Line item rows */}
              {receiptForm.lineItems.map((item, idx) => {
                const subtotal = lineItemSubtotal(item);
                const qtyNum = parseFloat(item.quantity) || 0;
                return (
                <div key={item.id} style={{ display: 'grid', gridTemplateColumns: '1fr 56px 80px 72px 78px 24px', gap: '6px', marginBottom: '6px', alignItems: 'center' }}>
                  <div>
                    <input
                      type="text"
                      value={item.description}
                      onChange={(e) => setReceiptForm({ ...receiptForm, lineItems: receiptForm.lineItems.map((li, i) => i === idx ? { ...li, description: e.target.value } : li) })}
                      placeholder="e.g. Power cord, Fuel…"
                      style={{ ...inputStyle, margin: 0 }}
                    />
                    {qtyNum > 1 && subtotal > 0 && (
                      <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
                        Line subtotal: ${subtotal.toFixed(2)}
                      </div>
                    )}
                  </div>
                  <input
                    type="number" step="0.01" min="0"
                    value={item.quantity}
                    onChange={(e) => setReceiptForm({ ...receiptForm, lineItems: receiptForm.lineItems.map((li, i) => i === idx ? { ...li, quantity: e.target.value } : li) })}
                    placeholder="1"
                    style={{ ...inputStyle, margin: 0 }}
                  />
                  <input
                    type="number" step="0.01"
                    value={item.rate}
                    onChange={(e) => setReceiptForm({ ...receiptForm, lineItems: receiptForm.lineItems.map((li, i) => i === idx ? { ...li, rate: e.target.value } : li) })}
                    placeholder="0.00"
                    style={{ ...inputStyle, margin: 0 }}
                  />
                  <input
                    type="number" step="0.01"
                    value={item.gst}
                    onChange={(e) => setReceiptForm({ ...receiptForm, lineItems: receiptForm.lineItems.map((li, i) => i === idx ? { ...li, gst: e.target.value } : li) })}
                    placeholder="0.00"
                    style={{ ...inputStyle, margin: 0 }}
                  />
                  <button
                    type="button"
                    onClick={() => setReceiptForm({ ...receiptForm, lineItems: receiptForm.lineItems.map((li, i) => i === idx ? { ...li, is_billable: !li.is_billable } : li) })}
                    style={{
                      padding: '6px 0',
                      borderRadius: '20px',
                      border: `1px solid ${item.is_billable ? 'var(--primary-color)' : 'var(--border-color)'}`,
                      backgroundColor: item.is_billable ? 'var(--primary-color)' : 'transparent',
                      color: item.is_billable ? 'white' : 'var(--text-tertiary)',
                      fontSize: '11px',
                      fontWeight: 600,
                      letterSpacing: '0.03em',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                  >
                    {item.is_billable ? '✓ Billable' : 'Billable'}
                  </button>
                  {receiptForm.lineItems.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => setReceiptForm({ ...receiptForm, lineItems: receiptForm.lineItems.filter((_, i) => i !== idx) })}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: '18px', lineHeight: 1, padding: 0 }}
                      title="Remove line item"
                    >
                      ×
                    </button>
                  ) : <span />}
                </div>
                );
              })}

              {/* Totals row — only when multiple items */}
              {receiptForm.lineItems.length > 1 && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 56px 80px 72px 78px 24px', gap: '6px', borderTop: '1px solid var(--border-color)', paddingTop: '6px', marginBottom: '4px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', textAlign: 'right' }}>Total</span>
                  <span />
                  <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    ${receiptForm.lineItems.reduce((s, li) => s + lineItemSubtotal(li), 0).toFixed(2)}
                  </span>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    ${receiptForm.lineItems.reduce((s, li) => s + (parseFloat(li.gst) || 0), 0).toFixed(2)}
                  </span>
                  <span /><span />
                </div>
              )}

              {linkingTicketExpenseIds.length === 0 && (
                <button
                  type="button"
                  onClick={() => setReceiptForm({ ...receiptForm, lineItems: [...receiptForm.lineItems, newLineItem()] })}
                  style={{ marginTop: '4px', padding: '5px 10px', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}
                >
                  + Add line item
                </button>
              )}
            </div>

            <div>
              <label style={labelStyle}>Notes (optional)</label>
              <textarea value={receiptForm.notes} onChange={(e) => setReceiptForm({ ...receiptForm, notes: e.target.value })} rows={2} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
            </div>

            <div style={{ display: 'flex', gap: '8px', marginTop: 'auto', paddingTop: '12px' }}>
              <button
                onClick={() => {
                  if (linkingTicketExpenseIds.length > 0) {
                    cancelReceiptLinking();
                  } else {
                    setReceiptFile(null);
                    setReceiptPreviewUrl(null);
                    setReceiptForm(initialReceiptForm);
                    setUploadError(null);
                    setReceiptAutofillNote(null);
                    setReceiptAutofillBusy(false);
                  }
                }}
                style={{ flex: 1, padding: '10px', backgroundColor: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', cursor: 'pointer', fontSize: '14px' }}
              >
                Cancel
              </button>
              <button
                disabled={isUploading}
                onClick={handleSubmitReceipt}
                style={{ flex: 1, padding: '10px', backgroundColor: 'var(--primary-color)', color: 'white', border: 'none', borderRadius: '6px', cursor: isUploading ? 'not-allowed' : 'pointer', fontSize: '14px', fontWeight: '600', opacity: isUploading ? 0.7 : 1 }}
              >
                {isUploading ? 'Saving...' : 'Save Receipt'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Expenses Table */}
      {isLoading ? (
        <div style={{ color: 'var(--text-tertiary)', padding: '24px', textAlign: 'center' }}>Loading expenses...</div>
      ) : (
        <div style={{ backgroundColor: 'var(--bg-primary)', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)' }}>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Date</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Description</th>
                <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Amount</th>
                <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>GST</th>
                <th style={{ padding: '12px 16px', textAlign: 'center', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Billable</th>
                <th style={{ padding: '12px 16px', textAlign: 'center', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Status</th>
                <th style={{ padding: '12px 16px', textAlign: 'center', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Ticket</th>
                <th style={{ padding: '12px 16px', textAlign: 'center', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase', width: '50px' }}></th>
              </tr>
            </thead>
            <tbody>
              {myExpenses.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '14px' }}>
                    No expenses found. Drop a receipt above to get started.
                  </td>
                </tr>
              ) : (
                myExpensesGroupedByDate.map(({ dateKey, items }) => {
                  const collapsed = collapsedMyExpenseDateKeys.has(dateKey);
                  const sharedReceiptMeta = sharedReceiptLabelMetaForGroup(items);
                  const receiptGroupTotals = sharedReceiptGroupTotalsInOrder(items, sharedReceiptMeta);
                  return (
                    <Fragment key={dateKey}>
                      <tr style={{ backgroundColor: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)' }}>
                        <td colSpan={8} style={{ padding: 0 }}>
                          <button
                            type="button"
                            onClick={() => toggleMyExpenseDateGroup(dateKey)}
                            aria-expanded={!collapsed}
                            style={{
                              width: '100%',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '10px',
                              padding: '10px 16px',
                              border: 'none',
                              background: 'transparent',
                              cursor: 'pointer',
                              textAlign: 'left',
                              fontSize: '14px',
                              fontWeight: '600',
                              color: 'var(--text-primary)',
                              fontFamily: 'inherit',
                            }}
                          >
                            <span style={{ fontSize: '11px', color: 'var(--text-secondary)', width: '14px', flexShrink: 0 }} aria-hidden>
                              {collapsed ? '▶' : '▼'}
                            </span>
                            <span>{formatExpenseGroupDateLabel(dateKey)}</span>
                            <span style={{ fontSize: '12px', fontWeight: '500', color: 'var(--text-tertiary)' }}>
                              ({items.length} {items.length === 1 ? 'expense' : 'expenses'})
                            </span>
                          </button>
                        </td>
                      </tr>
                      {!collapsed &&
                        items.flatMap((exp: any, rowIdx: number) => {
                          const u = (exp.receipt_url && String(exp.receipt_url).trim()) || '';
                          const isFirstOfSharedReceipt =
                            u &&
                            sharedReceiptMeta.has(String(exp.id)) &&
                            !items.slice(0, rowIdx).some(
                              (x: any) =>
                                (x.receipt_url && String(x.receipt_url).trim()) === u &&
                                sharedReceiptMeta.has(String(x.id))
                            );
                          const groupRow =
                            isFirstOfSharedReceipt &&
                            receiptGroupTotals.find((g) => g.url === u);
                          const summaryTr = groupRow ? (
                            <tr
                              key={`receipt-total-${dateKey}-${exp.id}`}
                              style={{
                                backgroundColor: 'rgba(124, 58, 237, 0.07)',
                                borderBottom: '1px solid var(--border-color)',
                              }}
                              aria-label="Receipt total for split lines"
                            >
                              <td colSpan={2} style={{ padding: '8px 16px', fontSize: '12px', color: '#4c1d95', lineHeight: 1.45 }}>
                                <span style={{ fontWeight: 700 }}>Receipt total</span>
                                <span style={{ fontWeight: 500, color: 'var(--text-secondary)', marginLeft: '8px' }}>
                                  {groupRow.lineCount} lines · Subtotal ${groupRow.amountSum.toFixed(2)} · GST $
                                  {groupRow.gstSum.toFixed(2)} · Total ${groupRow.combinedTotal.toFixed(2)}
                                </span>
                              </td>
                              <td
                                style={{
                                  padding: '8px 16px',
                                  textAlign: 'right',
                                  fontWeight: 700,
                                  fontSize: '13px',
                                  color: '#4c1d95',
                                }}
                              >
                                ${groupRow.amountSum.toFixed(2)}
                              </td>
                              <td
                                style={{
                                  padding: '8px 16px',
                                  textAlign: 'right',
                                  fontWeight: 700,
                                  fontSize: '13px',
                                  color: '#4c1d95',
                                }}
                              >
                                ${groupRow.gstSum.toFixed(2)}
                              </td>
                              <td colSpan={4} style={{ padding: '8px 16px', fontSize: '12px', color: 'var(--text-tertiary)' }}>
                                —
                              </td>
                            </tr>
                          ) : null;
                          const expenseTr = (
                <tr
                  key={exp.id}
                  onClick={() => handleStartEdit(exp)}
                  style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer', transition: 'background-color 0.15s' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'var(--bg-secondary)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = ''; }}
                >
                  <td style={{ padding: '12px 16px', fontSize: '14px', color: 'var(--text-tertiary)' }}>—</td>
                  <td style={{ padding: '12px 16px', fontSize: '14px' }}>
                    <div style={{ fontWeight: '500' }}>{exp.description}</div>
                    {(() => {
                      const part = sharedReceiptMeta.get(String(exp.id));
                      if (!part) return null;
                      return (
                        <div
                          style={{
                            fontSize: '11px',
                            fontWeight: '600',
                            color: '#5b21b6',
                            marginTop: '4px',
                            padding: '3px 8px',
                            borderRadius: '6px',
                            backgroundColor: 'rgba(124, 58, 237, 0.1)',
                            display: 'inline-block',
                            maxWidth: '100%',
                            lineHeight: 1.35,
                          }}
                        >
                          {`Same receipt · $${part.combinedTotal.toFixed(2)} combined (subtotal + GST) · line ${part.index} of ${part.total}`}
                        </div>
                      );
                    })()}
                    {exp.receipt_url && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleViewReceipt(exp); }}
                        style={{ fontSize: '12px', color: 'var(--primary-color)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: '2px' }}
                      >
                        {loadingReceiptId === exp.id ? 'Loading...' : 'View Receipt'}
                      </button>
                    )}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'right', fontWeight: '500', fontSize: '14px' }}>${parseFloat(exp.amount).toFixed(2)}</td>
                  <td style={{ padding: '12px 16px', textAlign: 'right', fontSize: '14px', color: 'var(--text-tertiary)' }}>${parseFloat(exp.gst || 0).toFixed(2)}</td>
                  <td style={{ padding: '12px 16px', textAlign: 'center', fontSize: '13px' }}>
                    {exp.is_billable ? (
                      <span style={{ color: '#2196F3', fontWeight: '600' }}>Yes</span>
                    ) : (
                      <span style={{ color: 'var(--text-tertiary)' }}>No</span>
                    )}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                    <span style={{
                      padding: '4px 8px',
                      borderRadius: '12px',
                      fontSize: '12px',
                      backgroundColor: exp.status === 'paid' ? 'rgba(59, 130, 246, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                      color: exp.status === 'paid' ? '#3b82f6' : '#f59e0b',
                    }}>
                      {exp.status === 'paid' ? 'Paid' : 'Unpaid'}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'center', fontSize: '13px' }}>
                    {exp.service_tickets?.ticket_number ? (
                      exp.service_ticket_id ? (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setViewingTicketRecordId(String(exp.service_ticket_id)); }}
                          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--primary-color)', fontWeight: 600, fontFamily: 'inherit', fontSize: 'inherit', textDecoration: 'underline' }}
                          title="Open service ticket"
                        >
                          {exp.service_tickets.ticket_number}
                        </button>
                      ) : exp.service_tickets.ticket_number
                    ) : (
                      exp.is_billable && !exp.service_ticket_id ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            // Ignore the click if a previous Apply-to-Ticket flow hasn't
                            // closed yet — otherwise re-opening with a different expenseId
                            // stacks state from two flows on top of each other.
                            if (isApplyToTicketFlowOpen) return;
                            setApplyExpenseId(exp.id);
                            setShowTicketPickerModal(true);
                            setTicketSearchQuery('');
                          }}
                          style={{ padding: '3px 8px', backgroundColor: 'rgba(33, 150, 243, 0.1)', color: '#2196F3', border: '1px solid rgba(33, 150, 243, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: 'pointer' }}
                        >
                          Apply to Ticket
                        </button>
                      ) : '-'
                    )}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                    <button
                      onClick={(e) => requestDeleteExpense(exp, e)}
                      disabled={deleteExpenseMutation.isPending && deleteExpenseMutation.variables === exp.id}
                      title="Delete"
                      style={{
                        color: '#ef5350',
                        background: 'none',
                        border: 'none',
                        cursor: deleteExpenseMutation.isPending && deleteExpenseMutation.variables === exp.id ? 'not-allowed' : 'pointer',
                        fontSize: '16px',
                        padding: '6px',
                        lineHeight: 1,
                        borderRadius: '4px',
                        transition: 'background-color 0.15s',
                        opacity: deleteExpenseMutation.isPending && deleteExpenseMutation.variables === exp.id ? 0.45 : 1,
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(239, 83, 80, 0.15)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                    </button>
                  </td>
                </tr>
                          );
                          return summaryTr ? [summaryTr, expenseTr] : [expenseTr];
                        })}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Admin: Expense Approval Section */}
      {isAdmin && (
        <div style={{ marginTop: '40px' }}>
          <h2 style={{ fontSize: '20px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '16px' }}>
            Expense Management
          </h2>

          {/* Status tabs (primary) + active-filter chips + Filters popover. */}
          {(() => {
            const today = new Date();
            const ymd = (d: Date) => d.toISOString().split('T')[0];
            const presets: Array<{ label: string; start: string; end: string }> = [
              (() => {
                const d = new Date(today); d.setDate(d.getDate() - 6);
                return { label: '7d', start: ymd(d), end: ymd(today) };
              })(),
              (() => {
                const d = new Date(today); d.setDate(d.getDate() - 29);
                return { label: '30d', start: ymd(d), end: ymd(today) };
              })(),
              (() => {
                const start = new Date(today.getFullYear(), today.getMonth(), 1);
                return { label: 'This month', start: ymd(start), end: ymd(today) };
              })(),
              (() => {
                const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                const end = new Date(today.getFullYear(), today.getMonth(), 0);
                return { label: 'Last month', start: ymd(start), end: ymd(end) };
              })(),
            ];
            const activePreset = presets.find((p) => p.start === adminDateStart && p.end === adminDateEnd) || null;
            const activeEmpName =
              adminEmployeeFilter !== 'all'
                ? adminEmployeeOptions.find((e) => e.id === adminEmployeeFilter)?.name || null
                : null;
            const activeFilterCount =
              (adminEmployeeFilter !== 'all' ? 1 : 0) +
              (adminTypeFilter !== 'all' ? 1 : 0) +
              ((adminDateStart || adminDateEnd) ? 1 : 0);
            const fmtDate = (s: string) =>
              s ? new Date(`${s}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '…';
            const dateChipLabel =
              activePreset
                ? activePreset.label
                : (adminDateStart || adminDateEnd)
                  ? `${fmtDate(adminDateStart)} → ${fmtDate(adminDateEnd)}`
                  : null;

            const chipStyle: React.CSSProperties = {
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '4px 8px 4px 10px', borderRadius: '999px',
              backgroundColor: 'rgba(33, 150, 243, 0.10)',
              color: 'var(--primary-color)', fontSize: '12px', fontWeight: 600,
              border: '1px solid rgba(33, 150, 243, 0.25)',
            };
            const chipXStyle: React.CSSProperties = {
              border: 'none', background: 'transparent', color: 'inherit',
              cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: 0,
              opacity: 0.7,
            };

            return (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '16px' }}>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {(['unpaid', 'paid', 'all'] as const).map((status) => (
                    <button
                      key={status}
                      onClick={() => setAdminStatusFilter(status)}
                      style={{
                        padding: '6px 14px',
                        borderRadius: '6px',
                        border: adminStatusFilter === status ? '1px solid var(--primary-color)' : '1px solid var(--border-color)',
                        backgroundColor: adminStatusFilter === status ? 'rgba(33, 150, 243, 0.1)' : 'transparent',
                        color: adminStatusFilter === status ? 'var(--primary-color)' : 'var(--text-secondary)',
                        fontSize: '13px',
                        fontWeight: '600',
                        cursor: 'pointer',
                        textTransform: 'capitalize',
                      }}
                    >
                      {status}{status !== 'all' ? ` (${mergedAdminExpensesForApproval.filter((e: any) => e._status === status).length})` : ` (${mergedAdminExpensesForApproval.length})`}
                    </button>
                  ))}
                </div>

                {/* Active filter chips. */}
                {activeEmpName && (
                  <span style={chipStyle}>
                    {activeEmpName}
                    <button type="button" onClick={() => setAdminEmployeeFilter('all')} style={chipXStyle} aria-label="Remove employee filter">×</button>
                  </span>
                )}
                {adminTypeFilter !== 'all' && (
                  <span style={chipStyle}>
                    {adminTypeFilter}
                    <button type="button" onClick={() => setAdminTypeFilter('all')} style={chipXStyle} aria-label="Remove type filter">×</button>
                  </span>
                )}
                {dateChipLabel && (
                  <span style={chipStyle}>
                    {dateChipLabel}
                    <button type="button" onClick={() => { setAdminDateStart(''); setAdminDateEnd(''); }} style={chipXStyle} aria-label="Remove date filter">×</button>
                  </span>
                )}

                <div ref={adminFiltersAnchorRef} style={{ position: 'relative', marginLeft: 'auto' }}>
                  <button
                    type="button"
                    onClick={() => setAdminFiltersOpen((v) => !v)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '6px',
                      padding: '6px 12px', borderRadius: '6px',
                      border: activeFilterCount > 0 ? '1px solid var(--primary-color)' : '1px solid var(--border-color)',
                      backgroundColor: activeFilterCount > 0 ? 'rgba(33, 150, 243, 0.08)' : 'var(--bg-secondary)',
                      color: activeFilterCount > 0 ? 'var(--primary-color)' : 'var(--text-secondary)',
                      fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                    }}
                    aria-expanded={adminFiltersOpen}
                  >
                    <span aria-hidden>⚙</span>
                    Filters
                    {activeFilterCount > 0 && (
                      <span style={{
                        minWidth: '18px', padding: '0 6px', height: '18px',
                        borderRadius: '999px', backgroundColor: 'var(--primary-color)',
                        color: 'white', fontSize: '11px', fontWeight: 700,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      }}>{activeFilterCount}</span>
                    )}
                    <span aria-hidden style={{ fontSize: '10px', opacity: 0.7 }}>{adminFiltersOpen ? '▲' : '▼'}</span>
                  </button>

                  {adminFiltersOpen && (
                    <div
                      role="dialog"
                      style={{
                        position: 'absolute', top: 'calc(100% + 6px)', right: 0,
                        zIndex: 50, width: 'min(420px, 90vw)',
                        backgroundColor: 'var(--bg-primary)',
                        border: '1px solid var(--border-color)', borderRadius: '8px',
                        boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
                        padding: '14px',
                        display: 'flex', flexDirection: 'column', gap: '12px',
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Employee</label>
                        <select
                          value={adminEmployeeFilter}
                          onChange={(e) => setAdminEmployeeFilter(e.target.value)}
                          style={{ padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '13px' }}
                        >
                          <option value="all">All employees</option>
                          {adminEmployeeOptions.map((emp) => (
                            <option key={emp.id} value={emp.id}>{emp.name}</option>
                          ))}
                        </select>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Type</label>
                        <select
                          value={adminTypeFilter}
                          onChange={(e) => setAdminTypeFilter(e.target.value)}
                          style={{ padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '13px' }}
                        >
                          <option value="all">All types</option>
                          {adminTypeOptions.map((t) => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Date range</label>
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                          {presets.map((p) => {
                            const isActive = activePreset?.label === p.label;
                            return (
                              <button
                                key={p.label}
                                type="button"
                                onClick={() => { setAdminDateStart(p.start); setAdminDateEnd(p.end); }}
                                style={{
                                  padding: '5px 10px', borderRadius: '6px',
                                  border: isActive ? '1px solid var(--primary-color)' : '1px solid var(--border-color)',
                                  backgroundColor: isActive ? 'rgba(33, 150, 243, 0.10)' : 'var(--bg-secondary)',
                                  color: isActive ? 'var(--primary-color)' : 'var(--text-secondary)',
                                  fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                                }}
                              >
                                {p.label}
                              </button>
                            );
                          })}
                        </div>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                          <input
                            type="date"
                            value={adminDateStart}
                            onChange={(e) => setAdminDateStart(e.target.value)}
                            style={{ flex: 1, padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '13px' }}
                          />
                          <span style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}>→</span>
                          <input
                            type="date"
                            value={adminDateEnd}
                            onChange={(e) => setAdminDateEnd(e.target.value)}
                            style={{ flex: 1, padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '13px' }}
                          />
                        </div>
                      </div>

                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '10px' }}>
                        <button
                          type="button"
                          onClick={() => { setAdminEmployeeFilter('all'); setAdminTypeFilter('all'); setAdminDateStart(''); setAdminDateEnd(''); }}
                          disabled={activeFilterCount === 0}
                          style={{
                            padding: '5px 10px', borderRadius: '6px', border: 'none',
                            background: 'transparent',
                            color: activeFilterCount === 0 ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                            fontSize: '12px',
                            cursor: activeFilterCount === 0 ? 'not-allowed' : 'pointer',
                            textDecoration: activeFilterCount === 0 ? 'none' : 'underline',
                          }}
                        >
                          Clear all
                        </button>
                        <button
                          type="button"
                          onClick={() => setAdminFiltersOpen(false)}
                          style={{ padding: '6px 14px', borderRadius: '6px', border: 'none', backgroundColor: 'var(--primary-color)', color: 'white', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
                        >
                          Done
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          <div style={{ backgroundColor: 'var(--bg-primary)', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
            <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1100px' }}>
              <thead>
                <tr style={{ backgroundColor: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)' }}>
                  <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Employee</th>
                  <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Date</th>
                  <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Description</th>
                  <th style={{ padding: '10px 14px', textAlign: 'right', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Amount</th>
                  <th style={{ padding: '10px 14px', textAlign: 'right', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>GST</th>
                  <th style={{ padding: '10px 14px', textAlign: 'center', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Billable</th>
                  <th style={{ padding: '10px 14px', textAlign: 'center', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Status</th>
                  <th style={{ padding: '10px 14px', textAlign: 'center', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Ticket</th>
                  <th style={{ padding: '10px 14px', textAlign: 'right', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {adminFilteredExpenses.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '14px' }}>
                      No {adminStatusFilter === 'all' ? '' : adminStatusFilter} expenses found.
                    </td>
                  </tr>
                ) : (
                  adminFilteredExpensesGroupedByDate.map(({ dateKey, items }) => {
                    const collapsed = collapsedAdminExpenseDateKeys.has(dateKey);
                    const sharedReceiptMeta = sharedReceiptLabelMetaForGroup(items);
                    const receiptGroupTotals = sharedReceiptGroupTotalsInOrder(items, sharedReceiptMeta);
                    // Per-group summary: total $ + GST + paid/unpaid + receipt-pending count + per-employee.
                    let groupAmount = 0;
                    let groupGst = 0;
                    let paidCount = 0;
                    let unpaidCount = 0;
                    let receiptPendingCount = 0;
                    const empSet = new Set<string>();
                    for (const it of items as any[]) {
                      groupAmount += Number(it._amount) || 0;
                      if (it._source === 'receipt') groupGst += parseFloat(String(it.gst || 0)) || 0;
                      if (it._status === 'paid') paidCount += 1; else unpaidCount += 1;
                      if (it._employeeName) empSet.add(String(it._employeeName));
                      if (it._source === 'ticket' && it.needs_reimbursement) {
                        const t = String(it.expense_type || '').toLowerCase();
                        const desc = String(it.description || '').toLowerCase();
                        const needsR = t === 'hotel' || t === 'expenses' || desc.includes('hotel');
                        const hasR = (Number(it.actual_cost) || 0) > 0 || !!it.user_expense_id;
                        const ownerId = String(it.service_tickets?.user_id ?? it._userId ?? '');
                        const isContractor = ownerId ? !!contractorByUserId.get(ownerId) : false;
                        if (needsR && !hasR && !isContractor) receiptPendingCount += 1;
                      }
                    }
                    return (
                      <Fragment key={dateKey}>
                        <tr style={{ backgroundColor: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)' }}>
                          <td colSpan={9} style={{ padding: 0 }}>
                            <button
                              type="button"
                              onClick={() => toggleAdminExpenseDateGroup(dateKey)}
                              aria-expanded={!collapsed}
                              style={{
                                width: '100%',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '10px',
                                padding: '8px 14px',
                                border: 'none',
                                background: 'transparent',
                                cursor: 'pointer',
                                textAlign: 'left',
                                fontSize: '13px',
                                fontWeight: '600',
                                color: 'var(--text-primary)',
                                fontFamily: 'inherit',
                                flexWrap: 'wrap',
                              }}
                            >
                              <span style={{ fontSize: '11px', color: 'var(--text-secondary)', width: '14px', flexShrink: 0 }} aria-hidden>
                                {collapsed ? '▶' : '▼'}
                              </span>
                              <span>{formatExpenseGroupDateLabel(dateKey)}</span>
                              <span style={{ fontSize: '12px', fontWeight: '500', color: 'var(--text-tertiary)' }}>
                                ({items.length} {items.length === 1 ? 'item' : 'items'})
                              </span>
                              <span style={{ marginLeft: 'auto', display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', fontSize: '12px', fontWeight: 500 }}>
                                <span>
                                  <span style={{ color: 'var(--text-tertiary)' }}>Total: </span>
                                  <strong style={{ color: 'var(--text-primary)' }}>${groupAmount.toFixed(2)}</strong>
                                </span>
                                {groupGst > 0 && (
                                  <span style={{ color: 'var(--text-tertiary)' }}>GST <strong style={{ color: 'var(--text-secondary)' }}>${groupGst.toFixed(2)}</strong></span>
                                )}
                                {paidCount > 0 && (
                                  <span style={{ padding: '1px 6px', borderRadius: '8px', backgroundColor: 'rgba(59, 130, 246, 0.12)', color: '#3b82f6', fontSize: '11px' }}>
                                    {paidCount} paid
                                  </span>
                                )}
                                {unpaidCount > 0 && (
                                  <span style={{ padding: '1px 6px', borderRadius: '8px', backgroundColor: 'rgba(245, 158, 11, 0.12)', color: '#f59e0b', fontSize: '11px' }}>
                                    {unpaidCount} unpaid
                                  </span>
                                )}
                                {/* Only show summary chip when collapsed; when expanded the per-row
                                    "Receipt pending" badge already conveys the same info per line. */}
                                {receiptPendingCount > 0 && collapsed && (
                                  <span style={{ padding: '1px 6px', borderRadius: '8px', backgroundColor: 'rgba(255, 152, 0, 0.18)', color: '#e65100', border: '1px solid rgba(255, 152, 0, 0.45)', fontSize: '11px' }}>
                                    📎 {receiptPendingCount} receipt pending
                                  </span>
                                )}
                                {empSet.size > 1 && (
                                  <span style={{ color: 'var(--text-tertiary)', fontSize: '11px' }}>{empSet.size} employees</span>
                                )}
                              </span>
                            </button>
                          </td>
                        </tr>
                        {!collapsed &&
                          items.flatMap((exp: any, rowIdx: number) => {
                  const isUpdating = updatingExpenseId === exp.id;
                  const status = exp._status;
                  const source = exp._source;
                  const u = (exp.receipt_url && String(exp.receipt_url).trim()) || '';
                  const isFirstOfSharedReceipt =
                    u &&
                    sharedReceiptMeta.has(String(exp.id)) &&
                    !items.slice(0, rowIdx).some(
                      (x: any) =>
                        (x.receipt_url && String(x.receipt_url).trim()) === u &&
                        sharedReceiptMeta.has(String(x.id))
                    );
                  const groupRow =
                    isFirstOfSharedReceipt &&
                    receiptGroupTotals.find((g) => g.url === u);
                  const summaryTr = groupRow ? (
                    <tr
                      key={`admin-receipt-total-${dateKey}-${exp.id}`}
                      style={{
                        backgroundColor: 'rgba(124, 58, 237, 0.07)',
                        borderBottom: '1px solid var(--border-color)',
                      }}
                      aria-label="Receipt total for split lines"
                    >
                      <td colSpan={3} style={{ padding: '6px 14px', fontSize: '11px', color: '#4c1d95', lineHeight: 1.45 }}>
                        <span style={{ fontWeight: 700 }}>Receipt total</span>
                        <span style={{ fontWeight: 500, color: 'var(--text-secondary)', marginLeft: '8px' }}>
                          {groupRow.lineCount} lines · Subtotal ${groupRow.amountSum.toFixed(2)} · GST $
                          {groupRow.gstSum.toFixed(2)} · Total ${groupRow.combinedTotal.toFixed(2)}
                        </span>
                      </td>
                      <td
                        style={{
                          padding: '6px 14px',
                          textAlign: 'right',
                          fontWeight: 700,
                          fontSize: '12px',
                          color: '#4c1d95',
                        }}
                      >
                        ${groupRow.amountSum.toFixed(2)}
                      </td>
                      <td
                        style={{
                          padding: '6px 14px',
                          textAlign: 'right',
                          fontWeight: 700,
                          fontSize: '12px',
                          color: '#4c1d95',
                        }}
                      >
                        ${groupRow.gstSum.toFixed(2)}
                      </td>
                      <td colSpan={4} style={{ padding: '6px 14px', fontSize: '11px', color: 'var(--text-tertiary)' }}>
                        —
                      </td>
                    </tr>
                  ) : null;
                  const expenseTr = (
                    <tr
                      key={`${source}-${exp.id}`}
                      style={{
                        borderBottom: '1px solid var(--border-color)',
                        cursor: source === 'receipt' ? 'pointer' : undefined,
                      }}
                      onClick={source === 'receipt' ? () => handleStartEdit(exp) : undefined}
                      role={source === 'receipt' ? 'button' : undefined}
                      tabIndex={source === 'receipt' ? 0 : undefined}
                      onKeyDown={source === 'receipt' ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleStartEdit(exp); } } : undefined}
                    >
                      <td style={{ padding: '10px 14px', fontSize: '13px', fontWeight: '500' }}>
                        {exp._employeeName || '-'}
                        {source === 'ticket' && <div style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>Ticket Expense</div>}
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: '13px', color: 'var(--text-tertiary)' }}>—</td>
                      <td style={{ padding: '10px 14px', fontSize: '13px' }}>
                        <div style={{ fontWeight: '500' }}>{exp.description}</div>
                        {source === 'receipt' && (() => {
                          const part = sharedReceiptMeta.get(String(exp.id));
                          if (!part) return null;
                          return (
                            <div
                              style={{
                                fontSize: '10px',
                                fontWeight: '600',
                                color: '#5b21b6',
                                marginTop: '4px',
                                padding: '2px 6px',
                                borderRadius: '5px',
                                backgroundColor: 'rgba(124, 58, 237, 0.1)',
                                display: 'inline-block',
                                maxWidth: '100%',
                                lineHeight: 1.35,
                              }}
                            >
                              {`Same receipt · $${part.combinedTotal.toFixed(2)} combined · line ${part.index} of ${part.total}`}
                            </div>
                          );
                        })()}
                        {source === 'receipt' && exp.receipt_url && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleViewReceipt(exp); }}
                            style={{ fontSize: '11px', color: 'var(--primary-color)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: '2px' }}
                          >
                            {loadingReceiptId === exp.id ? 'Loading...' : 'View Receipt'}
                          </button>
                        )}
                        {source === 'ticket' && exp.expense_type && (
                          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{exp.expense_type}{exp.unit ? ` (${exp.quantity} ${exp.unit})` : ''}</div>
                        )}
                        {exp.notes && <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>Note: {exp.notes}</div>}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: '500', fontSize: '13px' }}>${exp._amount.toFixed(2)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: '13px', color: 'var(--text-tertiary)' }}>{source === 'receipt' ? `$${parseFloat(exp.gst || 0).toFixed(2)}` : '-'}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'center', fontSize: '12px' }}>
                        {source === 'receipt' ? (exp.is_billable ? <span style={{ color: '#2196F3', fontWeight: '600' }}>Yes</span> : <span style={{ color: 'var(--text-tertiary)' }}>No</span>) : <span style={{ color: 'var(--text-tertiary)' }}>-</span>}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                        <span style={{
                          padding: '3px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: '600',
                          backgroundColor: status === 'paid' ? 'rgba(59, 130, 246, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                          color: status === 'paid' ? '#3b82f6' : '#f59e0b',
                        }}>
                          {status === 'paid' ? 'Paid' : 'Unpaid'}
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'center', fontSize: '12px' }}>
                        {exp._ticketNumber && exp.service_ticket_id ? (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setViewingTicketRecordId(String(exp.service_ticket_id)); }}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--primary-color)', fontWeight: 600, fontFamily: 'inherit', fontSize: 'inherit', textDecoration: 'underline' }}
                            title="Open service ticket"
                          >
                            {exp._ticketNumber}
                          </button>
                        ) : (
                          exp._ticketNumber || '-'
                        )}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                        {status === 'unpaid' && (
                          <button
                            disabled={isUpdating}
                            onClick={(e) => { e.stopPropagation(); handleAdminStatusChange(exp.id, 'paid', source, exp); }}
                            style={{ padding: '3px 8px', backgroundColor: 'rgba(59, 130, 246, 0.1)', color: '#3b82f6', border: '1px solid rgba(59, 130, 246, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: isUpdating ? 'not-allowed' : 'pointer' }}
                          >
                            Mark Paid
                          </button>
                        )}
                        {status === 'paid' && (
                          <button
                            disabled={isUpdating}
                            onClick={(e) => { e.stopPropagation(); handleAdminStatusChange(exp.id, 'pending', source); }}
                            style={{ padding: '3px 8px', backgroundColor: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: isUpdating ? 'not-allowed' : 'pointer' }}
                          >
                            Mark Unpaid
                          </button>
                        )}
                        {source === 'ticket' && (() => {
                          // Receipt-required types (Hotel, Other) flag a "Receipt pending" badge when
                          // they're reimbursable but no receipt is attached (no actual_cost AND no
                          // user_expense_id). Click opens the service ticket so admin can attach.
                          // Contractors invoice us for expenses → never need a receipt → show
                          // a neutral "Contractor" pill instead.
                          if (!exp.needs_reimbursement) return null;
                          const t = String(exp.expense_type || '').toLowerCase();
                          const desc = String(exp.description || '').toLowerCase();
                          const needsReceipt = t === 'hotel' || t === 'expenses' || desc.includes('hotel');
                          if (!needsReceipt) return null;
                          const ownerId = String(exp.service_tickets?.user_id ?? exp._userId ?? '');
                          const isContractor = ownerId ? !!contractorByUserId.get(ownerId) : false;
                          if (isContractor) {
                            return (
                              <span
                                style={{
                                  marginLeft: '6px',
                                  padding: '3px 8px',
                                  backgroundColor: 'rgba(99, 102, 241, 0.12)',
                                  color: '#4f46e5',
                                  border: '1px solid rgba(99, 102, 241, 0.35)',
                                  borderRadius: '4px',
                                  fontSize: '11px',
                                  fontWeight: 600,
                                  whiteSpace: 'nowrap',
                                }}
                                title="Contractor — invoices us for expenses, no receipt required"
                              >
                                Contractor
                              </span>
                            );
                          }
                          const hasReceipt =
                            (Number(exp.actual_cost) || 0) > 0 || !!exp.user_expense_id;
                          if (hasReceipt) return null;
                          return (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (exp.service_ticket_id) {
                                  setViewingTicketRecordId(String(exp.service_ticket_id));
                                }
                              }}
                              style={{
                                marginLeft: '6px',
                                padding: '3px 8px',
                                backgroundColor: 'rgba(255, 152, 0, 0.18)',
                                color: '#e65100',
                                border: '1px solid rgba(255, 152, 0, 0.45)',
                                borderRadius: '4px',
                                fontSize: '11px',
                                fontWeight: 600,
                                cursor: 'pointer',
                                whiteSpace: 'nowrap',
                              }}
                              title="Receipt not attached yet — click to open ticket and attach"
                            >
                              📎 Receipt pending
                            </button>
                          );
                        })()}
                        {source === 'receipt' && (() => {
                          // Non-billable receipts (e.g. internal tools, supplies kept for shop)
                          // never get linked to a service-ticket expense — hide all link UI.
                          if (!exp.is_billable) return null;
                          const linkedRows = linkedByReceiptId.get(String(exp.id)) || [];
                          const hasLinks = linkedRows.length > 0;
                          // A receipt is "applied" if either: it was directly assigned to a ticket
                          // (service_ticket_id) via the Apply-to-Ticket flow, OR a service_ticket_expense
                          // row points back to it via user_expense_id (the new linking flow).
                          const directTicketNumber = exp.service_tickets?.ticket_number || null;
                          const isDirectApplied = !!exp.service_ticket_id;
                          const isExpanded = expandedLinkedReceiptId === String(exp.id);
                          if (isDirectApplied && !hasLinks) {
                            // Already applied via the legacy Apply-to-Ticket flow — show a badge instead of Link.
                            return (
                              <span
                                style={{ marginLeft: '6px', padding: '3px 8px', backgroundColor: 'rgba(34, 197, 94, 0.12)', color: '#15803d', border: '1px solid rgba(34, 197, 94, 0.4)', borderRadius: '4px', fontSize: '11px', fontWeight: 600 }}
                                title={`Applied to ticket ${directTicketNumber ?? ''}`}
                              >
                                ✓ Applied{directTicketNumber ? ` to ${directTicketNumber}` : ''}
                              </span>
                            );
                          }
                          return (
                            <>
                              {hasLinks && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedLinkedReceiptId(isExpanded ? null : String(exp.id));
                                  }}
                                  style={{
                                    marginLeft: '6px',
                                    padding: '3px 8px',
                                    backgroundColor: 'rgba(34, 197, 94, 0.12)',
                                    color: '#15803d',
                                    border: '1px solid rgba(34, 197, 94, 0.4)',
                                    borderRadius: '4px',
                                    fontSize: '11px',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                  }}
                                  title="View / unlink the ticket expenses this receipt covers"
                                >
                                  ✓ Linked ({linkedRows.length}) {isExpanded ? '▴' : '▾'}
                                </button>
                              )}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setLinkReceiptModal({ receipt: exp });
                                  setLinkReceiptSelectedIds(new Set());
                                  setLinkReceiptError(null);
                                }}
                                style={{ marginLeft: '6px', padding: '3px 8px', backgroundColor: 'rgba(0, 137, 123, 0.1)', color: '#00897b', border: '1px solid rgba(0, 137, 123, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: 'pointer' }}
                                title={hasLinks ? 'Link to additional ticket expenses' : 'Link this receipt to ticket expenses awaiting it'}
                              >
                                {hasLinks ? '+ Link more' : 'Link'}
                              </button>
                            </>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                  // When admin expands a linked receipt, show its linked ticket expenses + per-row Unlink.
                  let linkedTr: JSX.Element | null = null;
                  if (source === 'receipt' && expandedLinkedReceiptId === String(exp.id)) {
                    const linkedRows = linkedByReceiptId.get(String(exp.id)) || [];
                    if (linkedRows.length > 0) {
                      linkedTr = (
                        <tr key={`${source}-${exp.id}-linked`} style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'rgba(34, 197, 94, 0.04)' }}>
                          <td colSpan={9} style={{ padding: '10px 16px 12px 42px' }}>
                            <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#15803d', marginBottom: '6px' }}>
                              Receipt is linked to {linkedRows.length} ticket expense{linkedRows.length === 1 ? '' : 's'}
                            </div>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                              <thead>
                                <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left', color: 'var(--text-secondary)', fontSize: '10px', textTransform: 'uppercase' }}>
                                  <th style={{ padding: '4px 6px' }}>Type</th>
                                  <th style={{ padding: '4px 6px' }}>Description</th>
                                  <th style={{ padding: '4px 6px' }}>Ticket</th>
                                  <th style={{ padding: '4px 6px' }}>Date</th>
                                  <th style={{ padding: '4px 6px', textAlign: 'right' }}>Billed</th>
                                  <th style={{ padding: '4px 6px', textAlign: 'right' }}>Action</th>
                                </tr>
                              </thead>
                              <tbody>
                                {linkedRows.map((lr: any) => {
                                  const billed = (Number(lr.quantity) || 0) * (Number(lr.rate) || 0);
                                  const tn = lr.service_tickets?.ticket_number || '—';
                                  const dt = lr.service_tickets?.date || '—';
                                  return (
                                    <tr key={String(lr.id)} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                      <td style={{ padding: '6px', fontWeight: 600 }}>{lr.expense_type || '—'}</td>
                                      <td style={{ padding: '6px', color: 'var(--text-secondary)' }}>{lr.description || '—'}</td>
                                      <td style={{ padding: '6px', fontFamily: 'monospace' }}>
                                        {lr.service_ticket_id ? (
                                          <button
                                            type="button"
                                            onClick={() => setViewingTicketRecordId(String(lr.service_ticket_id))}
                                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--primary-color)', fontWeight: 600, fontFamily: 'monospace', fontSize: 'inherit', textDecoration: 'underline' }}
                                          >
                                            {tn}
                                          </button>
                                        ) : tn}
                                      </td>
                                      <td style={{ padding: '6px', color: 'var(--text-secondary)' }}>{dt}</td>
                                      <td style={{ padding: '6px', textAlign: 'right', fontWeight: 600 }}>${billed.toFixed(2)}</td>
                                      <td style={{ padding: '6px', textAlign: 'right' }}>
                                        <button
                                          type="button"
                                          disabled={unlinkingTicketExpenseId === String(lr.id)}
                                          onClick={() => handleUnlinkTicketExpense(String(lr.id))}
                                          style={{ padding: '3px 8px', backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#dc2626', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: 600, cursor: unlinkingTicketExpenseId === String(lr.id) ? 'not-allowed' : 'pointer' }}
                                        >
                                          {unlinkingTicketExpenseId === String(lr.id) ? 'Unlinking…' : 'Unlink'}
                                        </button>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      );
                    }
                  }
                  return [
                    summaryTr,
                    expenseTr,
                    linkedTr,
                  ].filter(Boolean) as JSX.Element[];
                })}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
              {adminFilteredExpenses.length > 0 && (
                <tfoot>
                  <tr style={{ backgroundColor: 'var(--bg-secondary)', borderTop: '2px solid var(--border-color)' }}>
                    <td colSpan={2} style={{ padding: '12px 14px', fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Totals ({adminFilteredTotals.count} {adminFilteredTotals.count === 1 ? 'item' : 'items'})
                    </td>
                    <td style={{ padding: '12px 14px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                      {Object.keys(adminFilteredTotals.byType).length > 1 && (
                        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '8px' }}>
                          {Object.entries(adminFilteredTotals.byType)
                            .sort((a, b) => b[1].amount - a[1].amount)
                            .map(([t, v]) => (
                              <span key={t} style={{ whiteSpace: 'nowrap' }}>
                                <strong style={{ color: 'var(--text-primary)' }}>{t}:</strong> ${v.amount.toFixed(2)} ({v.count})
                              </span>
                            ))}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '12px 14px', textAlign: 'right', fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)' }}>
                      ${adminFilteredTotals.amount.toFixed(2)}
                    </td>
                    <td style={{ padding: '12px 14px', textAlign: 'right', fontWeight: 600, fontSize: '13px', color: 'var(--text-secondary)' }}>
                      {adminFilteredTotals.gst > 0 ? `$${adminFilteredTotals.gst.toFixed(2)}` : '—'}
                    </td>
                    <td colSpan={4} />
                  </tr>
                </tfoot>
              )}
            </table>
            </div>
          </div>
        </div>
      )}

      {/* Ticket Picker Modal */}
      {showTicketPickerModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10003, backgroundColor: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={closeApplyToTicketFlow}>
          <div onClick={(e) => e.stopPropagation()} style={{
            backgroundColor: 'var(--bg-primary)', borderRadius: '10px', width: '90%', maxWidth: '600px',
            maxHeight: '70vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }}>
            <div style={{ padding: '20px 24px 12px', borderBottom: '1px solid var(--border-color)' }}>
              <h3 style={{ margin: '0 0 12px', fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)' }}>Select a Service Ticket</h3>
              <input
                type="text"
                placeholder="Search by ticket #, customer, project, or location..."
                value={ticketSearchQuery}
                onChange={(e) => setTicketSearchQuery(e.target.value)}
                style={{ ...inputStyle, marginBottom: '4px' }}
                autoFocus
              />
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 24px 24px' }}>
              {filteredPickerTickets.length === 0 ? (
                <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '14px' }}>
                  No un-invoiced tickets found.
                </div>
              ) : (
                filteredPickerTickets.map((t: any) => (
                  <div key={t.id} style={{ marginBottom: '8px' }}>
                    <div
                      onClick={() => handlePickTicketForMarkup(t.id, t.ticket_number || 'Draft')}
                      style={{
                        padding: '12px',
                        borderRadius: detailsTicketId === t.id ? '6px 6px 0 0' : '6px',
                        border: '1px solid var(--border-color)',
                        borderBottom: detailsTicketId === t.id ? 'none' : '1px solid var(--border-color)',
                        cursor: 'pointer',
                        transition: 'background-color 0.15s',
                        backgroundColor: 'var(--bg-secondary)',
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--bg-tertiary)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--bg-secondary)'; }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1, textAlign: 'left' }}>
                          {t.ticket_number && (
                            <span style={{ fontWeight: '600', fontSize: '14px', color: 'var(--text-primary)', flexShrink: 0 }}>
                              {t.ticket_number}
                            </span>
                          )}
                          <span style={{ fontSize: '13px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {t.customers?.name || 'No Customer'}{t.projects?.name ? ` — ${t.projects.name}` : ''}{t.projects?.project_number ? ` (${t.projects.project_number})` : ''}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, marginLeft: '8px' }}>
                          <button
                            onClick={(e) => { e.stopPropagation(); setDetailsTicketId(detailsTicketId === t.id ? null : t.id); }}
                            style={{
                              padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--border-color)',
                              backgroundColor: detailsTicketId === t.id ? 'var(--primary-color)' : 'transparent',
                              color: detailsTicketId === t.id ? 'white' : 'var(--text-secondary)',
                              fontSize: '11px', cursor: 'pointer', fontWeight: '500', whiteSpace: 'nowrap',
                            }}
                          >
                            {detailsTicketId === t.id ? 'Hide' : 'Details'}
                          </button>
                          <span style={{ fontSize: '12px', padding: '2px 8px', borderRadius: '10px', backgroundColor: t.workflow_status === 'approved' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)', color: t.workflow_status === 'approved' ? '#10b981' : '#f59e0b' }}>
                            {t.workflow_status || 'draft'}
                          </span>
                        </div>
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '4px' }}>
                        {t.location ? t.location : 'No location'} &middot; {t.date ? new Date(t.date + 'T12:00:00').toLocaleDateString() : 'No date'}
                      </div>
                    </div>

                    {detailsTicketId === t.id && (
                      <div style={{
                        border: '1px solid var(--border-color)', borderTop: '1px dashed var(--border-color)',
                        borderRadius: '0 0 6px 6px', padding: '12px 14px',
                        backgroundColor: 'var(--bg-primary)', fontSize: '13px',
                      }}>
                        {isLoadingDetails ? (
                          <div style={{ textAlign: 'center', color: 'var(--text-tertiary)', padding: '12px 0' }}>Loading...</div>
                        ) : !ticketDetails ? (
                          <div style={{ textAlign: 'center', color: 'var(--text-tertiary)', padding: '12px 0' }}>No data.</div>
                        ) : (
                          <>
                            {/* Time Entries */}
                            <div style={{ marginBottom: ticketDetails.expenses.length > 0 ? '12px' : 0 }}>
                              <div style={{ fontWeight: '700', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '6px' }}>
                                Time Entries ({ticketDetails.timeEntries.length})
                              </div>
                              {ticketDetails.timeEntries.length === 0 ? (
                                <div style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}>No time entries.</div>
                              ) : (
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                                  <thead>
                                    <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                      <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-secondary)', fontWeight: '600' }}>Type</th>
                                      <th style={{ textAlign: 'right', padding: '4px 6px', color: 'var(--text-secondary)', fontWeight: '600' }}>Hours</th>
                                      <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-secondary)', fontWeight: '600' }}>Description</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {ticketDetails.timeEntries.map((te: any) => (
                                      <tr key={te.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                        <td style={{ padding: '4px 6px', color: 'var(--text-primary)' }}>{te.rate_type || 'Shop Time'}</td>
                                        <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: '600', color: 'var(--text-primary)' }}>{Number(te.hours).toFixed(1)}</td>
                                        <td style={{ padding: '4px 6px', color: 'var(--text-tertiary)', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{te.description || '—'}</td>
                                      </tr>
                                    ))}
                                    <tr>
                                      <td style={{ padding: '4px 6px', fontWeight: '700', color: 'var(--text-primary)' }}>Total</td>
                                      <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: '700', color: 'var(--text-primary)' }}>
                                        {ticketDetails.timeEntries.reduce((s: number, te: any) => s + Number(te.hours), 0).toFixed(1)}
                                      </td>
                                      <td />
                                    </tr>
                                  </tbody>
                                </table>
                              )}
                            </div>

                            {/* Expenses */}
                            {ticketDetails.expenses.length > 0 && (
                              <div>
                                <div style={{ fontWeight: '700', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '6px' }}>
                                  Expenses ({ticketDetails.expenses.length})
                                </div>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                                  <thead>
                                    <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                      <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-secondary)', fontWeight: '600' }}>Type</th>
                                      <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-secondary)', fontWeight: '600' }}>Description</th>
                                      <th style={{ textAlign: 'right', padding: '4px 6px', color: 'var(--text-secondary)', fontWeight: '600' }}>Amount</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {ticketDetails.expenses.map((ex: any) => (
                                      <tr key={ex.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                        <td style={{ padding: '4px 6px', color: 'var(--text-primary)' }}>{ex.expense_type || '—'}</td>
                                        <td style={{ padding: '4px 6px', color: 'var(--text-primary)' }}>{ex.description || '—'}</td>
                                        <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: '600', color: 'var(--text-primary)' }}>
                                          ${(Number(ex.quantity || 0) * Number(ex.rate || 0)).toFixed(2)}
                                        </td>
                                      </tr>
                                    ))}
                                    <tr>
                                      <td colSpan={2} style={{ padding: '4px 6px', fontWeight: '700', color: 'var(--text-primary)' }}>Total</td>
                                      <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: '700', color: 'var(--text-primary)' }}>
                                        ${ticketDetails.expenses.reduce((s: number, ex: any) => s + Number(ex.quantity || 0) * Number(ex.rate || 0), 0).toFixed(2)}
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )))
              }
            </div>
          </div>
        </div>
      )}

      {/* Markup Modal (step 2 after picking a ticket) */}
      {markupModalTicket && applyExpenseId && (() => {
        const expense = expenses.find((e: any) => e.id === applyExpenseId);
        if (!expense) return null;
        const expTotal = parseFloat(expense.amount) + parseFloat(expense.gst || 0);
        const val = parseFloat(markupValue) || 0;
        const markup = markupType === 'percent' ? (expTotal * val) / 100 : val;
        const total = expTotal + markup;

        return (
          <div className="ionex-modal-backdrop" style={{
            position: 'fixed', inset: 0, zIndex: 10003, backgroundColor: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }} onMouseDown={(e) => { if (e.target === e.currentTarget) closeApplyToTicketFlow(); }}>
            <div className="ionex-modal-card" onMouseDown={(e) => e.stopPropagation()} style={{
              backgroundColor: 'var(--bg-primary)', borderRadius: '12px', padding: '24px',
              maxWidth: '420px', width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '700', color: 'var(--text-primary)' }}>Apply Markup</h3>
                <button onClick={closeApplyToTicketFlow} style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-secondary)' }}>&times;</button>
              </div>

              <div style={{ marginBottom: '16px', padding: '10px 12px', backgroundColor: 'var(--bg-secondary)', borderRadius: '6px', fontSize: '13px' }}>
                <div><span style={{ color: 'var(--text-secondary)' }}>Expense:</span> <span style={{ fontWeight: '600' }}>{expense.description}</span></div>
                <div><span style={{ color: 'var(--text-secondary)' }}>Total (incl. GST):</span> <span style={{ fontWeight: '600' }}>${expTotal.toFixed(2)}</span></div>
                <div><span style={{ color: 'var(--text-secondary)' }}>Ticket:</span> <span style={{ fontWeight: '600' }}>{markupModalTicket.ticketNumber}</span></div>
              </div>

              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '6px' }}>Markup</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={markupValue}
                    onChange={(e) => setMarkupValue(e.target.value)}
                    style={{ ...inputStyle, flex: 1 }}
                    autoFocus
                  />
                  <div style={{ display: 'flex', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
                    <button
                      onClick={() => setMarkupType('dollar')}
                      style={{
                        padding: '8px 12px', border: 'none', fontSize: '13px', fontWeight: '600', cursor: 'pointer',
                        backgroundColor: markupType === 'dollar' ? 'var(--primary-color)' : 'var(--bg-secondary)',
                        color: markupType === 'dollar' ? 'white' : 'var(--text-secondary)',
                      }}
                    >$</button>
                    <button
                      onClick={() => setMarkupType('percent')}
                      style={{
                        padding: '8px 12px', border: 'none', borderLeft: '1px solid var(--border-color)', fontSize: '13px', fontWeight: '600', cursor: 'pointer',
                        backgroundColor: markupType === 'percent' ? 'var(--primary-color)' : 'var(--bg-secondary)',
                        color: markupType === 'percent' ? 'white' : 'var(--text-secondary)',
                      }}
                    >%</button>
                  </div>
                </div>
              </div>

              <div style={{ padding: '10px 12px', backgroundColor: 'rgba(33, 150, 243, 0.08)', borderRadius: '6px', marginBottom: '20px', fontSize: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Markup:</span>
                  <span style={{ fontWeight: '600', color: markup > 0 ? '#2196F3' : 'var(--text-tertiary)' }}>${markup.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', paddingTop: '4px', borderTop: '1px solid var(--border-color)' }}>
                  <span style={{ fontWeight: '700', color: 'var(--text-primary)' }}>Total on Ticket:</span>
                  <span style={{ fontWeight: '700', color: 'var(--text-primary)', fontSize: '16px' }}>${total.toFixed(2)}</span>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={handleBackToTicketPicker}
                  style={{ flex: 1, padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: '600', cursor: 'pointer' }}
                >
                  Back
                </button>
                <button
                  onClick={handleConfirmMarkup}
                  disabled={isApplyingMarkup}
                  style={{ flex: 1, padding: '10px', borderRadius: '6px', border: 'none', backgroundColor: 'var(--primary-color)', color: 'white', fontSize: '13px', fontWeight: '600', cursor: isApplyingMarkup ? 'not-allowed' : 'pointer', opacity: isApplyingMarkup ? 0.7 : 1 }}
                >
                  {isApplyingMarkup ? 'Applying...' : 'Apply to Ticket'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Receipt Viewer Modal */}
      {viewingReceiptUrl && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10004, backgroundColor: 'rgba(0,0,0,0.8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setViewingReceiptUrl(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'relative', width: viewingReceiptIsPdf ? '80vw' : 'auto', height: viewingReceiptIsPdf ? '90vh' : 'auto', maxWidth: '90vw', maxHeight: '90vh' }}>
            <button
              onClick={() => setViewingReceiptUrl(null)}
              style={{ position: 'absolute', top: -12, right: -12, zIndex: 1, width: '28px', height: '28px', borderRadius: '50%', backgroundColor: '#333', color: 'white', border: 'none', cursor: 'pointer', fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              &times;
            </button>
            {viewingReceiptIsPdf ? (
              <iframe src={viewingReceiptUrl} title="Receipt PDF" style={{ width: '100%', height: '100%', border: 'none', borderRadius: '8px', backgroundColor: 'white' }} />
            ) : (
              <img src={viewingReceiptUrl} alt="Receipt" style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: '8px' }} />
            )}
          </div>
        </div>
      )}

      {/* Admin: Link receipt to ticket expenses modal */}
      {linkReceiptModal && (() => {
        const receipt = linkReceiptModal.receipt;
        const receiptAmount =
          (parseFloat(receipt.amount) || 0) + (parseFloat(receipt.gst) || 0);
        // Only show receipt-required types (Hotel / Expenses). Mileage, Truck Hours,
        // Equipment, Per Diem etc. don't need receipts and shouldn't be link targets.
        const lines = (linkReceiptPendingLines as any[]).filter((r) =>
          pendingReceiptRequiringTypes.has(String(r.expense_type || ''))
        );
        const selectedRows = lines.filter((r) => linkReceiptSelectedIds.has(String(r.id)));
        const selectedBilledTotal = selectedRows.reduce(
          (s, r) => s + (Number(r.quantity) || 0) * (Number(r.rate) || 0),
          0
        );
        const closeModal = () => {
          setLinkReceiptModal(null);
          setLinkReceiptSelectedIds(new Set());
          setLinkReceiptSuggested(new Set());
          setLinkReceiptError(null);
          linkReceiptAutoAppliedRef.current = null;
        };
        const handleLink = async () => {
          if (linkReceiptSelectedIds.size === 0) {
            setLinkReceiptError('Select at least one ticket expense to link.');
            return;
          }
          setIsLinkingReceipt(true);
          setLinkReceiptError(null);
          try {
            await serviceTicketExpensesService.linkUserExpense(
              [...linkReceiptSelectedIds],
              String(receipt.id)
            );
            queryClient.invalidateQueries({ queryKey: ['pendingReceiptLines'] });
            queryClient.invalidateQueries({ queryKey: ['ticketReimbExpenses'] });
            queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
            queryClient.invalidateQueries({ queryKey: ['hotelTicketLinesNeedingReceipt'] });
            queryClient.invalidateQueries({ queryKey: ['linkedTicketExpenses'] });
            // Mark the receipt row as freshly linked so admin can see the result inline.
            setExpandedLinkedReceiptId(String(receipt.id));
            closeModal();
          } catch (err: any) {
            setLinkReceiptError(err?.message || 'Failed to link.');
          } finally {
            setIsLinkingReceipt(false);
          }
        };
        return (
          <div
            role="dialog"
            aria-modal="true"
            className="ionex-modal-backdrop"
            style={{
              position: 'fixed', inset: 0, zIndex: 10005,
              backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex',
              alignItems: 'center', justifyContent: 'center', padding: '16px',
            }}
            onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}
          >
            <div
              className="ionex-modal-card"
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                backgroundColor: 'var(--bg-primary)', borderRadius: '12px',
                width: '100%', maxWidth: 720, maxHeight: '85vh',
                display: 'flex', flexDirection: 'column',
                boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
                border: '1px solid var(--border-color)',
              }}
            >
              <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--border-color)' }}>
                <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>
                  Link receipt to ticket expenses
                </h2>
                <div style={{ marginTop: '6px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                  <strong style={{ color: 'var(--text-primary)' }}>{receipt.description || 'Receipt'}</strong>
                  {' '}· {receipt._employeeName || ''}
                  {' '}· Receipt total: <strong style={{ color: 'var(--text-primary)' }}>${receiptAmount.toFixed(2)}</strong>
                </div>
                {linkReceiptSuggested.size > 0 && (
                  <div
                    style={{
                      marginTop: '8px',
                      padding: '8px 10px',
                      borderRadius: '6px',
                      backgroundColor: 'rgba(33, 150, 243, 0.10)',
                      border: '1px solid rgba(33, 150, 243, 0.35)',
                      fontSize: '12px',
                      color: 'var(--text-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                    }}
                  >
                    <span>
                      <strong style={{ color: '#1976d2' }}>Suggested matches pre-selected</strong>
                      {' '}— based on amount and ticket date proximity. Review before linking.
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setLinkReceiptSuggested(new Set());
                        setLinkReceiptSelectedIds(new Set());
                      }}
                      style={{
                        padding: '4px 10px',
                        backgroundColor: 'transparent',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '4px',
                        fontSize: '11px',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
                {linkReceiptError && (
                  <div style={{ color: '#ef5350', fontSize: '13px', marginBottom: '8px' }}>{linkReceiptError}</div>
                )}
                {lines.length === 0 ? (
                  <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '13px' }}>
                    No ticket expenses for this employee are awaiting a receipt.
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left', color: 'var(--text-secondary)', fontSize: '11px', textTransform: 'uppercase' }}>
                        <th style={{ padding: '8px 6px', width: '32px' }}>
                          <input
                            type="checkbox"
                            checked={lines.length > 0 && linkReceiptSelectedIds.size === lines.length}
                            onChange={(e) => {
                              if (e.target.checked) setLinkReceiptSelectedIds(new Set(lines.map((r: any) => String(r.id))));
                              else setLinkReceiptSelectedIds(new Set());
                            }}
                          />
                        </th>
                        <th style={{ padding: '8px 6px' }}>Type</th>
                        <th style={{ padding: '8px 6px' }}>Description</th>
                        <th style={{ padding: '8px 6px' }}>Ticket</th>
                        <th style={{ padding: '8px 6px' }}>Date</th>
                        <th style={{ padding: '8px 6px', textAlign: 'right' }}>Billed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((row: any) => {
                        const id = String(row.id);
                        const tn = row.service_tickets?.ticket_number || '—';
                        const dt = row.service_tickets?.date || '';
                        const billed = (Number(row.quantity) || 0) * (Number(row.rate) || 0);
                        const isSel = linkReceiptSelectedIds.has(id);
                        return (
                          <tr key={id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                            <td style={{ padding: '8px 6px' }}>
                              <input
                                type="checkbox"
                                checked={isSel}
                                onChange={(e) => {
                                  setLinkReceiptSelectedIds((prev) => {
                                    const next = new Set(prev);
                                    if (e.target.checked) next.add(id); else next.delete(id);
                                    return next;
                                  });
                                }}
                              />
                            </td>
                            <td style={{ padding: '8px 6px', fontWeight: 600 }}>
                              {row.expense_type || '—'}
                              {linkReceiptSuggested.has(id) && (
                                <span
                                  title="Auto-suggested by amount/date match"
                                  style={{
                                    marginLeft: '6px',
                                    padding: '1px 6px',
                                    fontSize: '10px',
                                    fontWeight: 700,
                                    color: '#1976d2',
                                    backgroundColor: 'rgba(33, 150, 243, 0.12)',
                                    border: '1px solid rgba(33, 150, 243, 0.35)',
                                    borderRadius: '10px',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.04em',
                                    verticalAlign: 'middle',
                                  }}
                                >
                                  Suggested
                                </span>
                              )}
                            </td>
                            <td style={{ padding: '8px 6px', color: 'var(--text-secondary)' }}>{row.description || '—'}</td>
                            <td style={{ padding: '8px 6px', fontFamily: 'monospace' }}>{tn}</td>
                            <td style={{ padding: '8px 6px', color: 'var(--text-secondary)' }}>{dt || '—'}</td>
                            <td style={{ padding: '8px 6px', textAlign: 'right', fontWeight: 600 }}>${billed.toFixed(2)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              {linkReceiptSelectedIds.size > 0 && (() => {
                const diff = receiptAmount - selectedBilledTotal;
                return (
                  <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border-color)', backgroundColor: 'rgba(33, 150, 243, 0.05)', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', fontSize: '12px' }}>
                    <div>
                      <div style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-tertiary)', letterSpacing: '0.04em' }}>Selected (billed)</div>
                      <div style={{ fontSize: '14px', fontWeight: 700 }}>${selectedBilledTotal.toFixed(2)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-tertiary)', letterSpacing: '0.04em' }}>Receipt</div>
                      <div style={{ fontSize: '14px', fontWeight: 700 }}>${receiptAmount.toFixed(2)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-tertiary)', letterSpacing: '0.04em' }}>Difference</div>
                      <div
                        style={{ fontSize: '14px', fontWeight: 700, color: Math.abs(diff) < 0.005 ? 'var(--text-tertiary)' : diff > 0 ? '#15803d' : '#b45309' }}
                      >
                        {diff >= 0 ? '+' : ''}${diff.toFixed(2)}
                      </div>
                    </div>
                  </div>
                );
              })()}
              <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border-color)', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={closeModal}
                  style={{ padding: '8px 16px', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '13px', fontWeight: 500, cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isLinkingReceipt || linkReceiptSelectedIds.size === 0}
                  onClick={handleLink}
                  style={{ padding: '8px 16px', backgroundColor: 'var(--primary-color)', color: 'white', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: 600, cursor: isLinkingReceipt ? 'not-allowed' : 'pointer', opacity: isLinkingReceipt ? 0.7 : 1 }}
                >
                  {isLinkingReceipt
                    ? 'Linking…'
                    : `Link ${linkReceiptSelectedIds.size} ticket expense${linkReceiptSelectedIds.size === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Edit Expense Modal */}
      {editingExpense && (
        <div className="ionex-modal-backdrop" style={{
          position: 'fixed', inset: 0, zIndex: 10003, backgroundColor: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => { setEditingExpense(null); setEditReceiptPreviewUrl(null); }}>
          <div className="ionex-modal-card" onClick={(e) => e.stopPropagation()} style={{
            backgroundColor: 'var(--bg-primary)', borderRadius: '12px', overflow: 'hidden',
            maxWidth: editingExpense.receipt_url ? '800px' : '480px', width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            display: 'flex', flexDirection: editingExpense.receipt_url ? 'row' : 'column', minHeight: editingExpense.receipt_url ? '450px' : undefined,
          }}>
            {editingExpense.receipt_url && (
              <div style={{
                flex: 1,
                backgroundColor: 'var(--bg-tertiary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '16px',
                overflow: 'auto',
                minWidth: 0,
              }}>
                {loadingEditReceipt ? (
                  <div style={{ color: 'var(--text-tertiary)', fontSize: '14px' }}>Loading receipt...</div>
                ) : editReceiptPreviewUrl ? (
                  editReceiptIsPdf ? (
                    <iframe
                      src={editReceiptPreviewUrl}
                      title="Receipt preview"
                      style={{ width: '100%', height: '100%', minHeight: '380px', border: 'none', borderRadius: '4px' }}
                    />
                  ) : (
                    <img
                      src={editReceiptPreviewUrl}
                      alt="Receipt preview"
                      style={{ maxWidth: '100%', maxHeight: '60vh', objectFit: 'contain', borderRadius: '4px' }}
                    />
                  )
                ) : null}
              </div>
            )}
            <div style={{ flex: 1, padding: '24px', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '700', color: 'var(--text-primary)' }}>Edit Expense</h3>
                <button onClick={() => { setEditingExpense(null); setEditReceiptPreviewUrl(null); }} style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-secondary)' }}>&times;</button>
              </div>
              {editingExpense.service_ticket_id && (
                <div style={{ marginBottom: '16px', padding: '8px 12px', backgroundColor: 'rgba(33, 150, 243, 0.1)', borderRadius: '6px', fontSize: '12px', color: '#2196F3', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>Applied to ticket {editingExpense.service_tickets?.ticket_number ?? 'Pending'}. Changes will sync to the service ticket.</span>
                  <button
                    onClick={async () => {
                      if (!confirm('Remove this expense from the service ticket? The ticket expense line will be deleted.')) return;
                      try {
                        await userExpensesService.unapplyFromTicket(editingExpense.id);
                        queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
                        queryClient.invalidateQueries({ queryKey: ['unappliedBillableReceipts'] });
                        queryClient.invalidateQueries({ queryKey: ['serviceTicketExpenseTotals'] });
                        queryClient.invalidateQueries({ queryKey: ['hotelTicketLinesNeedingReceipt'] });
                        setEditingExpense({ ...editingExpense, service_ticket_id: null, service_tickets: null, markup_amount: null });
                      } catch (err: any) {
                        alert('Failed to unapply: ' + (err.message || 'Unknown error'));
                      }
                    }}
                    style={{ marginLeft: '8px', padding: '4px 10px', backgroundColor: 'rgba(244, 67, 54, 0.1)', color: '#f44336', border: '1px solid rgba(244, 67, 54, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: 'pointer', whiteSpace: 'nowrap' }}
                  >
                    Unapply
                  </button>
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Description</label>
                  <input type="text" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} style={inputStyle} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr 1fr', gap: '12px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Qty</label>
                    <input type="number" step="0.01" min="0" value={editForm.quantity} onChange={(e) => setEditForm({ ...editForm, quantity: e.target.value })} style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Rate ($)</label>
                    <input type="number" step="0.01" min="0" value={editForm.rate} onChange={(e) => setEditForm({ ...editForm, rate: e.target.value })} style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>GST ($)</label>
                    <input type="number" step="0.01" min="0" value={editForm.gst} onChange={(e) => setEditForm({ ...editForm, gst: e.target.value })} style={inputStyle} />
                  </div>
                </div>
                {(() => {
                  const q = parseFloat(editForm.quantity) || 0;
                  const r = parseFloat(editForm.rate) || 0;
                  if (q > 1 && r > 0) {
                    return (
                      <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                        Line subtotal: <strong style={{ color: 'var(--text-primary)' }}>${(Math.round(q * r * 100) / 100).toFixed(2)}</strong>
                      </div>
                    );
                  }
                  return null;
                })()}
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Date</label>
                  <input type="date" value={editForm.expense_date} onChange={(e) => setEditForm({ ...editForm, expense_date: e.target.value })} style={inputStyle} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input type="checkbox" id="edit-billable" checked={editForm.is_billable} onChange={(e) => setEditForm({ ...editForm, is_billable: e.target.checked })} />
                  <label htmlFor="edit-billable" style={{ fontSize: '13px', cursor: 'pointer' }}>Billable</label>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Notes</label>
                  <textarea value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} rows={2} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: 'auto', paddingTop: '20px' }}>
                <button onClick={() => { setEditingExpense(null); setEditReceiptPreviewUrl(null); }} style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
                <button onClick={handleSaveEdit} disabled={isSavingEdit} style={{ padding: '8px 16px', borderRadius: '6px', border: 'none', backgroundColor: 'var(--primary-color)', color: 'white', fontSize: '13px', fontWeight: '600', cursor: isSavingEdit ? 'not-allowed' : 'pointer', opacity: isSavingEdit ? 0.7 : 1 }}>
                  {isSavingEdit ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}


      {viewingTicketRecordId && (
        <ServiceTickets
          pendingOpenRecord={viewingTicketRecordId}
          modalOnlyMode={{
            onClose: () => {
              setViewingTicketRecordId(null);
              queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
              queryClient.invalidateQueries({ queryKey: ['ticketReimbExpenses'] });
              queryClient.invalidateQueries({ queryKey: ['pendingReceiptLines'] });
            },
          }}
        />
      )}
    </div>
  );
}
