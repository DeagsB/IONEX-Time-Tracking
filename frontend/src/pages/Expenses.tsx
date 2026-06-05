import React, { useState, useRef, useMemo, Fragment, useEffect } from 'react';
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
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
import { useBackdropClose } from '../hooks/useBackdropClose';
import {
  payPeriodBoundsForYmd,
  formatPayPeriodRangeLabel,
  payPeriodBoundsForDate,
} from '../utils/payPeriod';
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

  // Top-level tab: "Receipt expenses" (action-required) vs. "Auto-reimbursed" (view-only).
  // Persisted across reloads so the user lands where they last were. URL params already
  // claim `?tab=` for the admin status filter (see effect below), so this only uses
  // localStorage to avoid collision.
  const [activeExpensesTab, setActiveExpensesTab] = useState<'receipts' | 'auto' | 'contractors' | 'management' | 'reconcile'>(() => {
    try {
      const v = localStorage.getItem('ionex-expenses-tab');
      if (v === 'auto' || v === 'contractors' || v === 'management' || v === 'reconcile') return v;
      return 'receipts';
    } catch { return 'receipts'; }
  });
  useEffect(() => {
    try { localStorage.setItem('ionex-expenses-tab', activeExpensesTab); } catch {}
  }, [activeExpensesTab]);
  // Brief inline notice surfaced when switching to the Auto tab cancels an in-progress
  // receipt link. Auto-clears after 4 seconds.
  const [tabSwitchNotice, setTabSwitchNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!tabSwitchNotice) return;
    const t = setTimeout(() => setTabSwitchNotice(null), 4000);
    return () => clearTimeout(t);
  }, [tabSwitchNotice]);

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
  // Drag-aware backdrop close: only dismisses when the click actually starts on the backdrop,
  // so drag-selecting text or images inside the preview and releasing outside doesn't close it.
  const viewingReceiptBackdropClose = useBackdropClose(() => setViewingReceiptUrl(null));

  // Admin approval
  const [adminStatusFilter, setAdminStatusFilter] = useState<'unpaid' | 'paid' | 'all'>('unpaid');
  const [adminEmployeeFilter, setAdminEmployeeFilter] = useState<string>('all');
  const [adminDateStart, setAdminDateStart] = useState<string>('');
  const [adminDateEnd, setAdminDateEnd] = useState<string>('');
  /** Type filter values: 'all' | 'Receipt' (standalone receipts) | one of the ticket expense_type strings. */
  const [adminTypeFilter, setAdminTypeFilter] = useState<string>('all');
  const [collapsedMyExpenseDateKeys, setCollapsedMyExpenseDateKeys] = useState<Set<string>>(() => new Set());
  const hasSeededMyExpenseDateCollapse = useRef(false);
  // Pay-period collapse state — keyed by period index ("0", "-1", "12"…). Pay periods sit
  // above the per-day groups so the user lands on the current 14-day window first, with
  // older periods folded away. Persisted alongside (not in place of) the date-group state.
  const [collapsedMyExpensePeriodKeys, setCollapsedMyExpensePeriodKeys] = useState<Set<string>>(() => new Set());
  const [collapsedAdminExpensePeriodKeys, setCollapsedAdminExpensePeriodKeys] = useState<Set<string>>(() => new Set());
  const hasSeededMyExpensePeriodCollapse = useRef(false);
  const hasSeededAdminExpensePeriodCollapse = useRef(false);
  // Auto-reimbursed tab uses a parallel set of collapse state so toggles there
  // don't bleed back into the Receipts-tab grouping (and vice versa).
  const [collapsedAutoExpensePeriodKeys, setCollapsedAutoExpensePeriodKeys] = useState<Set<string>>(() => new Set());
  const hasSeededAutoExpensePeriodCollapse = useRef(false);
  // Admin-only employee filter inside the Auto tab. Mirrors the Awaiting Receipts dropdown.
  const [autoEmployeeFilter, setAutoEmployeeFilter] = useState<string>('all');
  const [updatingExpenseId, setUpdatingExpenseId] = useState<string | null>(null);

  /** Selected rows in the admin expense approval table for batch actions.
   *  Key format: "<source>-<id>" where source is "receipt" | "ticket". */
  const [selectedExpenseKeys, setSelectedExpenseKeys] = useState<Set<string>>(new Set());
  const [batchActionBusy, setBatchActionBusy] = useState(false);
  // Clearing selection when filters change keeps bulk actions honest — the user shouldn't be
  // able to keep rows "selected" that are no longer visible after switching filters.
  useEffect(() => {
    setSelectedExpenseKeys(new Set());
  }, [adminStatusFilter, adminEmployeeFilter, adminTypeFilter, adminDateStart, adminDateEnd]);

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

  // Dashboard action items: switch admin status filter via URL params. The old `overview=open`
  // hint pointed at the standalone Employee Overview that was folded back into the main table;
  // it now just falls through to "unpaid" filtering, which is where the actionable work lives.
  useEffect(() => {
    const overview = searchParams.get('overview');
    const tab = searchParams.get('tab');
    if (overview === 'open' || tab === 'pending' || tab === 'unpaid') {
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
  const [expenseManagementCollapsed, setExpenseManagementCollapsed] = useState<boolean>(true);

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
      const createdReceipt = await userExpensesService.create({
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
        // Backlink the freshly-created receipt to the hotel ticket-expense line so payroll
        // dedup never reimburses both sides of the same charge.
        user_expense_id: createdReceipt?.id ?? null,
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
        const createdReceipt = await userExpensesService.create({
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
          // Link the freshly-created receipt to the hotel ticket-expense so payroll dedup
          // doesn't reimburse both sides of the same charge across pay-period boundaries.
          user_expense_id: createdReceipt?.id ?? null,
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

  // Admin toggle: flag a receipt as not eligible for employee reimbursement. Drops it from
  // payroll + the employee's My Expenses table, but the row stays so admin can still apply
  // it to a service ticket (e.g. company paid for the gas, still bill the customer).
  const setNotReimbursableMutation = useMutation({
    mutationFn: async ({ id, value }: { id: string; value: boolean }) => {
      return userExpensesService.update(id, { not_reimbursable: value });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['unappliedBillableReceipts'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      alert('Failed to update reimbursement flag: ' + msg);
    },
  });

  // Admin-side delete prompt — same destructive confirm + cache pop as the employee flow
  // (requestDeleteExpense), but reachable from the approval table row for any employee.
  const requestAdminDeleteReceipt = (exp: any, e: React.MouseEvent) => {
    e.stopPropagation();
    const desc = (exp.description || 'Expense').trim();
    const short = desc.length > 60 ? `${desc.slice(0, 60)}…` : desc || 'this expense';
    const amount = Number(exp.amount) || 0;
    const owner = exp._employeeName || exp.users?.email || 'this employee';
    const proceed = window.confirm(
      `Delete "${short}"${amount > 0 ? ` ($${amount.toFixed(2)})` : ''} from ${owner}'s expenses?\n\n` +
      'This permanently removes the receipt. If you only want to drop reimbursement but keep it for ticket billing, use "Not Reimbursable" instead.'
    );
    if (!proceed) return;
    if (editingExpense?.id === exp.id) {
      setEditingExpense(null);
      setEditReceiptPreviewUrl(null);
    }
    removeExpenseFromCache(exp.id);
    deleteExpenseMutation.mutate(exp.id);
  };

  const handleToggleNotReimbursable = (exp: any, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !exp.not_reimbursable;
    const owner = exp._employeeName || exp.users?.email || 'this employee';
    if (next) {
      const proceed = window.confirm(
        `Mark this receipt as Not Reimbursable for ${owner}?\n\n` +
        'It will be removed from their expense table and skipped in payroll, but stays available to Apply-to-Ticket so the cost is still billed to the customer.'
      );
      if (!proceed) return;
    }
    setNotReimbursableMutation.mutate({ id: String(exp.id), value: next });
  };

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
   * ticket expenses hit service_ticket_expenses.reimbursement_status. Used by the admin
   * approval table's bulk-action bar.
   */
  const handleAdminBatchStatusChange = async (
    rows: Array<{ id: string; source: 'receipt' | 'ticket' }>,
    newStatus: 'pending' | 'paid'
  ) => {
    if (rows.length === 0) return;
    // Confirm before flipping a batch — single-row marks already prompt for the
    // receipt-required case, but batch actions had no guard and could flip dozens of
    // rows in one click. Show count + intended state so admins can sanity check.
    const verb = newStatus === 'paid' ? 'accounted for' : 'unaccounted';
    const proceed = window.confirm(`Mark ${rows.length} expense${rows.length === 1 ? '' : 's'} as ${verb}?`);
    if (!proceed) return;
    setBatchActionBusy(true);
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
      setSelectedExpenseKeys(new Set());
    } catch (err: any) {
      alert('Failed to update some rows: ' + (err?.message || 'Unknown error'));
    } finally {
      setBatchActionBusy(false);
    }
  };

  /** Bulk admin actions on selected receipts: mark not_reimbursable (or restore) and delete. */
  const handleAdminBatchSetNotReimbursable = async (
    receiptIds: string[],
    value: boolean
  ) => {
    if (receiptIds.length === 0) return;
    if (value) {
      const proceed = window.confirm(
        `Mark ${receiptIds.length} receipt${receiptIds.length === 1 ? '' : 's'} as Not Reimbursable?\n\n` +
        'They drop out of payroll and the employees\' expense tables, but remain available for Apply-to-Ticket.'
      );
      if (!proceed) return;
    }
    setBatchActionBusy(true);
    try {
      await Promise.all(receiptIds.map((id) => userExpensesService.update(id, { not_reimbursable: value })));
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['unappliedBillableReceipts'] });
      setSelectedExpenseKeys(new Set());
    } catch (err: any) {
      alert('Failed to update some rows: ' + (err?.message || 'Unknown error'));
    } finally {
      setBatchActionBusy(false);
    }
  };

  const handleAdminBatchDeleteReceipts = async (receiptIds: string[]) => {
    if (receiptIds.length === 0) return;
    const proceed = window.confirm(
      `Delete ${receiptIds.length} receipt${receiptIds.length === 1 ? '' : 's'} permanently?\n\n` +
      'If you only want to drop reimbursement but keep them for ticket billing, use Not Reimbursable instead.'
    );
    if (!proceed) return;
    setBatchActionBusy(true);
    try {
      // Pop optimistic from cache so the table updates immediately, then run deletes serially
      // to keep the error messaging accurate (Promise.all would hide individual failures).
      for (const id of receiptIds) {
        removeExpenseFromCache(id);
      }
      for (const id of receiptIds) {
        await userExpensesService.delete(id);
      }
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['unappliedBillableReceipts'] });
      setSelectedExpenseKeys(new Set());
    } catch (err: any) {
      alert('Failed to delete some receipts: ' + (err?.message || 'Unknown error'));
    } finally {
      setBatchActionBusy(false);
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
          'This ticket expense does not have a receipt attached yet. Mark as accounted for anyway?\n\n' +
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
    if (t === 'Equipment') {
      // Truck-as-equipment stays its own bucket; everything else (laptops, basic
      // field gear, etc.) reads as the friendlier "Laptop/Basic Equipment".
      const desc = String(exp.description || '').toLowerCase();
      if (desc.includes('truck')) return 'Truck';
      return 'Laptop/Basic Equipment';
    }
    return t;
  };

  /**
   * Hide hotel ticket-expense rows from the admin User Expense Management
   * list — the employee's uploaded receipt is the artifact admin should
   * see/act on for hotels, not the ticket-line placeholder. Once the
   * receipt is uploaded it appears in `user_expenses` and shows as
   * `_source === 'receipt'`. Missing-receipt awareness for hotel ticket
   * lines lives on the ServiceTickets page (Suggested Billable Receipts +
   * the per-ticket receipt-attach modal), so this hide doesn't lose any
   * admin signal.
   */
  const isHiddenHotelTicketPlaceholder = (exp: any): boolean => {
    if (!exp || exp._source !== 'ticket') return false;
    const t = String(exp.expense_type || '').toLowerCase();
    const desc = String(exp.description || '').toLowerCase();
    return t === 'hotel' || desc.includes('hotel');
  };

  const adminTypeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of mergedAdminExpensesForApproval as any[]) set.add(expenseTypeOf(e));
    return [...set].sort();
  }, [mergedAdminExpensesForApproval]);

  const adminFilteredExpenses = mergedAdminExpensesForApproval.filter((exp: any) => {
    // On the Receipts tab, drop auto-reimbursed types (Travel/Subsistence/Equipment) —
    // they live in the Auto-reimbursed tab.
    if (activeExpensesTab === 'receipts') {
      const t = expenseTypeOf(exp);
      if (!(t === 'Receipt' || t === 'Hotel' || t === 'Expenses')) return false;
    }
    if (isHiddenHotelTicketPlaceholder(exp)) return false;
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

  // Expense table: admin sees own only; non-admin sees own only (filtered for defense in depth).
  // Receipts admin has marked `not_reimbursable` drop out of this table — they're no longer
  // the employee's reimbursable expense, they just sit in the system for Apply-to-Ticket /
  // admin auditing in the approval section below.
  const myExpenses = useMemo(() => {
    if (!user?.id) return expenses.filter((e: any) => !e.not_reimbursable);
    return expenses.filter((e: any) => e.user_id === user.id && !e.not_reimbursable);
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

  /** Roll the date-grouped lists up by 14-day pay period. Each period carries totals
   *  (subtotal, GST, total, line count) so the period header can show what the operator
   *  would key into payroll for that window. The pay-period anchor matches the Payroll
   *  page so windows align with what each employee is actually paid for. */
  type PayPeriodGroup = {
    /** Stable key — the period index as a string. */
    periodKey: string;
    periodIndex: number;
    /** "Apr 6 – Apr 19, 2026" */
    periodLabel: string;
    periodStartYmd: string;
    periodEndYmd: string;
    isCurrent: boolean;
    isFuture: boolean;
    dateGroups: { dateKey: string; items: any[] }[];
    totals: { amount: number; gst: number; total: number; count: number };
  };

  const todayPeriodIndex = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return payPeriodBoundsForDate(t).index;
  }, []);

  const groupDateGroupsByPayPeriod = (dateGroups: { dateKey: string; items: any[] }[], dateAccessor: (exp: any) => string): PayPeriodGroup[] => {
    if (dateGroups.length === 0) return [];
    const byIndex = new Map<number, PayPeriodGroup>();
    for (const grp of dateGroups) {
      // Use the first item's date (date groups are homogeneous on date key) to find the
      // period bounds. Fall back to today's period when the date is missing so orphan
      // entries still appear somewhere.
      const sample = grp.items[0];
      const rawDate = sample ? String(dateAccessor(sample) || '').trim() : '';
      let periodIndex: number;
      let startYmd: string;
      let endYmd: string;
      if (rawDate) {
        const b = payPeriodBoundsForYmd(rawDate);
        periodIndex = b.index;
        startYmd = b.startYmd;
        endYmd = b.endYmd;
      } else {
        // No-date orphans → bucket them with the current period rather than spawn a
        // separate header that's hard to scan past.
        periodIndex = todayPeriodIndex;
        const b = payPeriodBoundsForYmd(new Date().toISOString().split('T')[0]);
        startYmd = b.startYmd;
        endYmd = b.endYmd;
      }
      if (!byIndex.has(periodIndex)) {
        const b = payPeriodBoundsForYmd(startYmd);
        byIndex.set(periodIndex, {
          periodKey: String(periodIndex),
          periodIndex,
          periodLabel: formatPayPeriodRangeLabel(b.start, b.end),
          periodStartYmd: startYmd,
          periodEndYmd: endYmd,
          isCurrent: periodIndex === todayPeriodIndex,
          isFuture: periodIndex > todayPeriodIndex,
          dateGroups: [],
          totals: { amount: 0, gst: 0, total: 0, count: 0 },
        });
      }
      const period = byIndex.get(periodIndex)!;
      period.dateGroups.push(grp);
      for (const exp of grp.items) {
        const amt = parseFloat(String(exp.amount ?? exp._amount ?? 0)) || 0;
        const gst = parseFloat(String(exp.gst ?? exp._gst ?? 0)) || 0;
        period.totals.amount += amt;
        period.totals.gst += gst;
        period.totals.total += amt + gst;
        period.totals.count += 1;
      }
    }
    return Array.from(byIndex.values()).sort((a, b) => b.periodIndex - a.periodIndex);
  };

  const myExpensesGroupedByPayPeriod = useMemo(
    () => groupDateGroupsByPayPeriod(myExpensesGroupedByDate, (e) => e.expense_date),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [myExpensesGroupedByDate, todayPeriodIndex]
  );

  const adminFilteredExpensesGroupedByPayPeriod = useMemo(
    () => groupDateGroupsByPayPeriod(adminFilteredExpensesGroupedByDate, (e) => e._date || e.expense_date),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adminFilteredExpensesGroupedByDate, todayPeriodIndex]
  );

  // Reconcile tab: every unaccounted expense across the whole company, grouped by pay
  // period (the natural cadence for bookkeeping data entry). Independent of UEM's filter
  // rail so admin always has the full reconcile picture in this tab. Hidden hotel
  // ticket placeholders are stripped — the employee's actual receipt is what gets entered.
  // Contractor rows are excluded — they invoice the company directly and don't run
  // through the reimbursement workflow, so they live in the dedicated Contractors tab.
  const reconcileGroupedByDate = useMemo(() => {
    const rows = (mergedAdminExpensesForApproval as any[]).filter((e) => {
      if (isHiddenHotelTicketPlaceholder(e)) return false;
      const uid = String(e._userId ?? '');
      if (uid && contractorByUserId.get(uid)) return false;
      return e._status === 'unpaid';
    });
    const sorted = [...rows].sort((a: any, b: any) => {
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
      if (k !== lastKey) { groups.push({ dateKey: k, items: [] }); lastKey = k; }
      groups[groups.length - 1].items.push(exp);
    }
    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedAdminExpensesForApproval, contractorByUserId]);

  const reconcileGroupedByPayPeriod = useMemo(
    () => groupDateGroupsByPayPeriod(reconcileGroupedByDate, (e) => e._date || e.expense_date),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reconcileGroupedByDate, todayPeriodIndex]
  );

  const [collapsedReconcilePeriodKeys, setCollapsedReconcilePeriodKeys] = useState<Set<string>>(new Set());
  const hasSeededReconcilePeriodCollapse = useRef<boolean>(false);
  useEffect(() => {
    if (reconcileGroupedByPayPeriod.length === 0) {
      hasSeededReconcilePeriodCollapse.current = false;
      setCollapsedReconcilePeriodKeys(new Set());
      return;
    }
    if (hasSeededReconcilePeriodCollapse.current) return;
    hasSeededReconcilePeriodCollapse.current = true;
    // Same quiet default — every period collapsed. Reconcile is a focused per-period task,
    // so the admin opens the one they're entering into the books and ignores the rest.
    setCollapsedReconcilePeriodKeys(new Set(reconcileGroupedByPayPeriod.map((p) => p.periodKey)));
  }, [reconcileGroupedByPayPeriod]);
  const toggleReconcilePeriodGroup = (periodKey: string) => {
    setCollapsedReconcilePeriodKeys((prev) => {
      const next = new Set(prev);
      if (next.has(periodKey)) next.delete(periodKey);
      else next.add(periodKey);
      return next;
    });
  };

  // Collapse state for the project and category sub-groups inside each Reconcile period.
  // Keyed by composite (period::project / period::project::category) so the same project
  // name under two periods toggles independently.
  //   Projects use a COLLAPSED set (default expanded) — opening a period shows its projects.
  //   Categories use an EXPANDED set (default collapsed) — each project lists its category
  //   summaries and the user drills into the one they're entering. Inverting the set lets
  //   "collapsed by default" work without pre-seeding keys that are computed during render.
  const [collapsedReconcileProjectKeys, setCollapsedReconcileProjectKeys] = useState<Set<string>>(new Set());
  const [expandedReconcileCategoryKeys, setExpandedReconcileCategoryKeys] = useState<Set<string>>(new Set());
  const toggleReconcileGroupKey = (
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    key: string
  ) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** Selected reconcile rows for bulk Account-for. Keyed the same as the UEM bulk bar
   *  ("<source>-<id>") so the existing selection-handling code can be reused. */
  const [selectedReconcileKeys, setSelectedReconcileKeys] = useState<Set<string>>(new Set());

  // User Expense Management: outer grouping by employee, inner grouping by pay period.
  // Admins want to focus on one person's reconciliation at a time rather than scanning
  // across all employees in one period — switching to user-first puts the pay-period
  // splits underneath each user so the within-user comparison stays intact.
  type AdminUserGroup = {
    userId: string;
    userName: string;
    periods: PayPeriodGroup[];
    totals: { count: number; amount: number; gst: number; total: number };
    unpaidCount: number;
  };
  const adminFilteredExpensesGroupedByUser = useMemo(() => {
    const byUser = new Map<string, AdminUserGroup>();
    for (const period of adminFilteredExpensesGroupedByPayPeriod) {
      // Sub-bucket each period's items by userId so we can rebuild a per-user view of
      // the period without recomputing date groupings or totals from scratch.
      const periodItemsByUser = new Map<string, { dateGroups: { dateKey: string; items: any[] }[]; totals: PayPeriodGroup['totals']; userName: string; unpaidCount: number }>();
      for (const grp of period.dateGroups) {
        // Items inside a date group may belong to multiple users — split per item.
        const itemsByUser = new Map<string, any[]>();
        const namesByUser = new Map<string, string>();
        for (const exp of grp.items) {
          const uid = String(exp._userId ?? '');
          if (!itemsByUser.has(uid)) itemsByUser.set(uid, []);
          itemsByUser.get(uid)!.push(exp);
          if (!namesByUser.has(uid)) {
            namesByUser.set(uid, String(exp._employeeName || 'Unknown'));
          }
        }
        for (const [uid, items] of itemsByUser) {
          if (!periodItemsByUser.has(uid)) {
            periodItemsByUser.set(uid, {
              dateGroups: [],
              totals: { amount: 0, gst: 0, total: 0, count: 0 },
              userName: namesByUser.get(uid) || 'Unknown',
              unpaidCount: 0,
            });
          }
          const bucket = periodItemsByUser.get(uid)!;
          bucket.dateGroups.push({ dateKey: grp.dateKey, items });
          for (const exp of items) {
            const amt = parseFloat(String(exp.amount ?? exp._amount ?? 0)) || 0;
            const gst = parseFloat(String(exp.gst ?? exp._gst ?? 0)) || 0;
            bucket.totals.amount += amt;
            bucket.totals.gst += gst;
            bucket.totals.total += amt + gst;
            bucket.totals.count += 1;
            if (exp._status === 'unpaid') bucket.unpaidCount += 1;
          }
        }
      }
      for (const [uid, bucket] of periodItemsByUser) {
        if (!byUser.has(uid)) {
          byUser.set(uid, {
            userId: uid,
            userName: bucket.userName,
            periods: [],
            totals: { count: 0, amount: 0, gst: 0, total: 0 },
            unpaidCount: 0,
          });
        }
        const userGroup = byUser.get(uid)!;
        userGroup.periods.push({
          ...period,
          dateGroups: bucket.dateGroups,
          totals: bucket.totals,
        });
        userGroup.totals.amount += bucket.totals.amount;
        userGroup.totals.gst += bucket.totals.gst;
        userGroup.totals.total += bucket.totals.total;
        userGroup.totals.count += bucket.totals.count;
        userGroup.unpaidCount += bucket.unpaidCount;
      }
    }
    // Alphabetical by name — predictable scanning beats sorting by amount, which would
    // make the order jump around as the date filters change.
    return Array.from(byUser.values()).sort((a, b) => a.userName.localeCompare(b.userName));
  }, [adminFilteredExpensesGroupedByPayPeriod]);

  /** Per-user collapse state. Seeded so every user is collapsed except the ones that
   *  have unpaid items in the current period — that's the only thing the admin actually
   *  needs to look at on the first scan. */
  const [collapsedAdminExpenseUserKeys, setCollapsedAdminExpenseUserKeys] = useState<Set<string>>(new Set());
  const hasSeededAdminExpenseUserCollapse = useRef<boolean>(false);
  useEffect(() => {
    if (adminFilteredExpensesGroupedByUser.length === 0) {
      hasSeededAdminExpenseUserCollapse.current = false;
      setCollapsedAdminExpenseUserKeys(new Set());
      return;
    }
    if (hasSeededAdminExpenseUserCollapse.current) return;
    hasSeededAdminExpenseUserCollapse.current = true;
    const collapsed = adminFilteredExpensesGroupedByUser
      .filter((u) => u.unpaidCount === 0)
      .map((u) => u.userId);
    setCollapsedAdminExpenseUserKeys(new Set(collapsed));
  }, [adminFilteredExpensesGroupedByUser]);
  const toggleAdminExpenseUserGroup = (userId: string) => {
    setCollapsedAdminExpenseUserKeys((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  // ---- Auto-reimbursed tab: source rows ------------------------------------------------
  // Both queries (`pendingReceiptLines` for employees, `ticketReimbExpenses` for admins)
  // are already loaded for the Receipts tab. We just filter them to the auto-pay types.
  const AUTO_REIMB_TYPES = useMemo(() => new Set(['Travel', 'Subsistence', 'Equipment']), []);

  const autoReimbursedRows = useMemo(() => {
    const arr = isAdmin ? (ticketReimbExpenses as any[]) : (pendingReceiptLines as any[]);
    const rows = arr.filter((r) => {
      if (!AUTO_REIMB_TYPES.has(String(r.expense_type || ''))) return false;
      // Admin query (getNeedsReimbursement) doesn't strip inline-cost rows; do it here
      // so the auto view stays "no employee action" — anything with actual_cost set is
      // an explicit override and not really auto-paid.
      if ((Number(r.actual_cost) || 0) > 0) return false;
      if (r.service_tickets?.is_discarded) return false;
      // Contractor lines live in the dedicated Contractors tab — keep this view clean of
      // anything that needs invoice-based accounting rather than payroll auto-pay.
      const ownerId = String(r.service_tickets?.user_id ?? '');
      if (ownerId && contractorByUserId.get(ownerId)) return false;
      if (isAdmin && autoEmployeeFilter !== 'all') {
        if (ownerId !== autoEmployeeFilter) return false;
      }
      return true;
    });
    // Decorate with the same _date/_userId/_amount shape used by groupDateGroupsByPayPeriod
    // so we don't need a parallel grouping closure. Auto rows have no `amount`/`gst` —
    // line total is quantity * rate, and these types don't carry GST in the payroll flow.
    return rows.map((r: any) => ({
      ...r,
      _date: r.service_tickets?.date || r.created_at?.split('T')[0] || '',
      _userId: r.service_tickets?.user_id,
      _amount: (Number(r.quantity) || 0) * (Number(r.rate) || 0),
      _gst: 0,
    }));
  }, [isAdmin, ticketReimbExpenses, pendingReceiptLines, AUTO_REIMB_TYPES, autoEmployeeFilter, contractorByUserId]);

  // Contractors tab: every ticket-expense row owned by a user flagged Contractor on the
  // employees table. All expense types — receipt-required (Hotel/Expenses) and auto-pay
  // (Travel/Subsistence/Equipment) — surface here together so admins have a single view
  // of contractor activity, since contractors invoice the company directly and don't
  // run through payroll reimbursement.
  const [contractorEmployeeFilter, setContractorEmployeeFilter] = useState<string>('all');
  const contractorTicketExpenseRows = useMemo(() => {
    if (!isAdmin) return [] as any[];
    const rows = (ticketReimbExpenses as any[]).filter((r) => {
      if (r.service_tickets?.is_discarded) return false;
      const ownerId = String(r.service_tickets?.user_id ?? '');
      if (!ownerId || !contractorByUserId.get(ownerId)) return false;
      if (contractorEmployeeFilter !== 'all' && ownerId !== contractorEmployeeFilter) return false;
      return true;
    });
    return rows.map((r: any) => ({
      ...r,
      _date: r.service_tickets?.date || r.created_at?.split('T')[0] || '',
      _userId: r.service_tickets?.user_id,
      _amount: (() => {
        const actual = Number(r.actual_cost) || 0;
        if (actual > 0) return actual;
        return (Number(r.quantity) || 0) * (Number(r.rate) || 0);
      })(),
      _gst: 0,
    }));
  }, [isAdmin, ticketReimbExpenses, contractorByUserId, contractorEmployeeFilter]);

  // Distinct contractor employees in the data — used for the per-employee filter dropdown.
  // Unfiltered by contractorEmployeeFilter so all options remain selectable.
  const contractorEmployeeOptions = useMemo(() => {
    if (!isAdmin) return [] as { id: string; name: string }[];
    const map = new Map<string, string>();
    for (const r of (ticketReimbExpenses as any[])) {
      const id = String(r.service_tickets?.user_id ?? '');
      if (!id || !contractorByUserId.get(id)) continue;
      if (map.has(id)) continue;
      const u = r.service_tickets?.user;
      const name = u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email || 'Unknown' : 'Unknown';
      map.set(id, name);
    }
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [isAdmin, ticketReimbExpenses, contractorByUserId]);

  const contractorRowsGroupedByDate = useMemo(() => {
    const sorted = [...contractorTicketExpenseRows].sort((a, b) => {
      const ka = normalizeExpenseTableDateKey(String(a._date || ''));
      const kb = normalizeExpenseTableDateKey(String(b._date || ''));
      if (ka !== kb) return kb.localeCompare(ka);
      return String(b.created_at || b.id || '').localeCompare(String(a.created_at || a.id || ''));
    });
    const groups: { dateKey: string; items: any[] }[] = [];
    let lastKey = '';
    for (const r of sorted) {
      const k = normalizeExpenseTableDateKey(String(r._date || ''));
      if (k !== lastKey) {
        groups.push({ dateKey: k, items: [] });
        lastKey = k;
      }
      groups[groups.length - 1].items.push(r);
    }
    return groups;
  }, [contractorTicketExpenseRows]);

  const contractorRowsGroupedByPayPeriod = useMemo(
    () => groupDateGroupsByPayPeriod(contractorRowsGroupedByDate, (e) => e._date),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contractorRowsGroupedByDate, todayPeriodIndex]
  );

  // User-first grouping for the Contractors tab. Same shape and rationale as the
  // Auto and User Expense Management tabs — contractors invoice separately so the
  // outer-user / inner-period layout makes per-contractor reconciliation faster.
  const contractorRowsGroupedByUser = useMemo(() => {
    const byUser = new Map<string, AutoUserGroup>();
    for (const period of contractorRowsGroupedByPayPeriod) {
      const periodItemsByUser = new Map<string, { dateGroups: { dateKey: string; items: any[] }[]; totals: PayPeriodGroup['totals']; userName: string; unaccountedCount: number }>();
      for (const grp of period.dateGroups) {
        const itemsByUser = new Map<string, any[]>();
        const namesByUser = new Map<string, string>();
        for (const exp of grp.items) {
          const uid = String(exp._userId ?? exp.service_tickets?.user_id ?? '');
          if (!itemsByUser.has(uid)) itemsByUser.set(uid, []);
          itemsByUser.get(uid)!.push(exp);
          if (!namesByUser.has(uid)) {
            const u = exp.service_tickets?.user;
            const name = u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email || 'Unknown' : 'Unknown';
            namesByUser.set(uid, name);
          }
        }
        for (const [uid, items] of itemsByUser) {
          if (!periodItemsByUser.has(uid)) {
            periodItemsByUser.set(uid, {
              dateGroups: [],
              totals: { amount: 0, gst: 0, total: 0, count: 0 },
              userName: namesByUser.get(uid) || 'Unknown',
              unaccountedCount: 0,
            });
          }
          const bucket = periodItemsByUser.get(uid)!;
          bucket.dateGroups.push({ dateKey: grp.dateKey, items });
          for (const exp of items) {
            const amt = parseFloat(String(exp._amount ?? 0)) || 0;
            bucket.totals.amount += amt;
            bucket.totals.total += amt;
            bucket.totals.count += 1;
            if (String(exp.reimbursement_status || '') !== 'paid') bucket.unaccountedCount += 1;
          }
        }
      }
      for (const [uid, bucket] of periodItemsByUser) {
        if (!byUser.has(uid)) {
          byUser.set(uid, {
            userId: uid,
            userName: bucket.userName,
            periods: [],
            totals: { count: 0, amount: 0, gst: 0, total: 0 },
            unaccountedCount: 0,
          });
        }
        const userGroup = byUser.get(uid)!;
        userGroup.periods.push({
          ...period,
          dateGroups: bucket.dateGroups,
          totals: bucket.totals,
        });
        userGroup.totals.amount += bucket.totals.amount;
        userGroup.totals.total += bucket.totals.total;
        userGroup.totals.count += bucket.totals.count;
        userGroup.unaccountedCount += bucket.unaccountedCount;
      }
    }
    return Array.from(byUser.values()).sort((a, b) => a.userName.localeCompare(b.userName));
  }, [contractorRowsGroupedByPayPeriod]);

  const [collapsedContractorUserKeys, setCollapsedContractorUserKeys] = useState<Set<string>>(new Set());
  const hasSeededContractorUserCollapse = useRef<boolean>(false);
  useEffect(() => {
    if (contractorRowsGroupedByUser.length === 0) {
      hasSeededContractorUserCollapse.current = false;
      setCollapsedContractorUserKeys(new Set());
      return;
    }
    if (hasSeededContractorUserCollapse.current) return;
    hasSeededContractorUserCollapse.current = true;
    const collapsed = contractorRowsGroupedByUser.filter((u) => u.unaccountedCount === 0).map((u) => u.userId);
    setCollapsedContractorUserKeys(new Set(collapsed));
  }, [contractorRowsGroupedByUser]);
  const toggleContractorUserGroup = (userId: string) => {
    setCollapsedContractorUserKeys((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const [collapsedContractorPeriodKeys, setCollapsedContractorPeriodKeys] = useState<Set<string>>(new Set());
  const hasSeededContractorPeriodCollapse = useRef<boolean>(false);
  useEffect(() => {
    if (contractorRowsGroupedByPayPeriod.length === 0) {
      hasSeededContractorPeriodCollapse.current = false;
      setCollapsedContractorPeriodKeys(new Set());
      return;
    }
    if (hasSeededContractorPeriodCollapse.current) return;
    hasSeededContractorPeriodCollapse.current = true;
    // Same quiet default as the other tabs — composite (userId|periodKey) so toggling one
    // contractor's period doesn't drag every other contractor's matching period open.
    const collapsed: string[] = [];
    for (const u of contractorRowsGroupedByUser) {
      for (const p of u.periods) collapsed.push(`${u.userId}|${p.periodKey}`);
    }
    setCollapsedContractorPeriodKeys(new Set(collapsed));
  }, [contractorRowsGroupedByPayPeriod, contractorRowsGroupedByUser]);
  const toggleContractorPeriodGroup = (compositeKey: string) => {
    setCollapsedContractorPeriodKeys((prev) => {
      const next = new Set(prev);
      if (next.has(compositeKey)) next.delete(compositeKey);
      else next.add(compositeKey);
      return next;
    });
  };

  const autoEmployeeOptions = useMemo(() => {
    if (!isAdmin) return [] as { id: string; name: string }[];
    const map = new Map<string, string>();
    for (const r of (ticketReimbExpenses as any[])) {
      if (!AUTO_REIMB_TYPES.has(String(r.expense_type || ''))) continue;
      const id = String(r.service_tickets?.user_id ?? '');
      if (!id || map.has(id)) continue;
      const emp = employees?.find((e: any) => e.user_id === id);
      const name = emp?.user ? `${emp.user.first_name || ''} ${emp.user.last_name || ''}`.trim() || emp.user.email || 'Unknown' : 'Unknown';
      map.set(id, name);
    }
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [isAdmin, ticketReimbExpenses, employees, AUTO_REIMB_TYPES]);

  const autoReimbursedGroupedByDate = useMemo(() => {
    const sorted = [...autoReimbursedRows].sort((a, b) => {
      const ka = normalizeExpenseTableDateKey(String(a._date || ''));
      const kb = normalizeExpenseTableDateKey(String(b._date || ''));
      if (ka !== kb) return kb.localeCompare(ka);
      return String(b.created_at || b.id || '').localeCompare(String(a.created_at || a.id || ''));
    });
    const groups: { dateKey: string; items: any[] }[] = [];
    let lastKey = '';
    for (const r of sorted) {
      const k = normalizeExpenseTableDateKey(String(r._date || ''));
      if (k !== lastKey) {
        groups.push({ dateKey: k, items: [] });
        lastKey = k;
      }
      groups[groups.length - 1].items.push(r);
    }
    return groups;
  }, [autoReimbursedRows]);

  const autoReimbursedGroupedByPayPeriod = useMemo(
    () => groupDateGroupsByPayPeriod(autoReimbursedGroupedByDate, (e) => e._date),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [autoReimbursedGroupedByDate, todayPeriodIndex]
  );

  // User-first grouping for the Auto-reimbursed tab — outer accordion is the
  // employee, inner card is the pay-period split. Mirrors the User Expense
  // Management layout so admins reconcile one person at a time.
  type AutoUserGroup = {
    userId: string;
    userName: string;
    periods: PayPeriodGroup[];
    totals: { count: number; amount: number; gst: number; total: number };
    unaccountedCount: number;
  };
  const autoReimbursedGroupedByUser = useMemo(() => {
    const byUser = new Map<string, AutoUserGroup>();
    for (const period of autoReimbursedGroupedByPayPeriod) {
      const periodItemsByUser = new Map<string, { dateGroups: { dateKey: string; items: any[] }[]; totals: PayPeriodGroup['totals']; userName: string; unaccountedCount: number }>();
      for (const grp of period.dateGroups) {
        const itemsByUser = new Map<string, any[]>();
        const namesByUser = new Map<string, string>();
        for (const exp of grp.items) {
          const uid = String(exp._userId ?? exp.service_tickets?.user_id ?? '');
          if (!itemsByUser.has(uid)) itemsByUser.set(uid, []);
          itemsByUser.get(uid)!.push(exp);
          if (!namesByUser.has(uid)) {
            const u = exp.service_tickets?.user;
            const name = u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email || 'Unknown' : 'Unknown';
            namesByUser.set(uid, name);
          }
        }
        for (const [uid, items] of itemsByUser) {
          if (!periodItemsByUser.has(uid)) {
            periodItemsByUser.set(uid, {
              dateGroups: [],
              totals: { amount: 0, gst: 0, total: 0, count: 0 },
              userName: namesByUser.get(uid) || 'Unknown',
              unaccountedCount: 0,
            });
          }
          const bucket = periodItemsByUser.get(uid)!;
          bucket.dateGroups.push({ dateKey: grp.dateKey, items });
          for (const exp of items) {
            const amt = parseFloat(String(exp._amount ?? 0)) || 0;
            bucket.totals.amount += amt;
            bucket.totals.total += amt;
            bucket.totals.count += 1;
            if (String(exp.reimbursement_status || '') !== 'paid') bucket.unaccountedCount += 1;
          }
        }
      }
      for (const [uid, bucket] of periodItemsByUser) {
        if (!byUser.has(uid)) {
          byUser.set(uid, {
            userId: uid,
            userName: bucket.userName,
            periods: [],
            totals: { count: 0, amount: 0, gst: 0, total: 0 },
            unaccountedCount: 0,
          });
        }
        const userGroup = byUser.get(uid)!;
        userGroup.periods.push({
          ...period,
          dateGroups: bucket.dateGroups,
          totals: bucket.totals,
        });
        userGroup.totals.amount += bucket.totals.amount;
        userGroup.totals.total += bucket.totals.total;
        userGroup.totals.count += bucket.totals.count;
        userGroup.unaccountedCount += bucket.unaccountedCount;
      }
    }
    return Array.from(byUser.values()).sort((a, b) => a.userName.localeCompare(b.userName));
  }, [autoReimbursedGroupedByPayPeriod]);

  const [collapsedAutoUserKeys, setCollapsedAutoUserKeys] = useState<Set<string>>(new Set());
  const hasSeededAutoUserCollapse = useRef<boolean>(false);
  useEffect(() => {
    if (autoReimbursedGroupedByUser.length === 0) {
      hasSeededAutoUserCollapse.current = false;
      setCollapsedAutoUserKeys(new Set());
      return;
    }
    if (hasSeededAutoUserCollapse.current) return;
    hasSeededAutoUserCollapse.current = true;
    // Seed collapse on users with zero unaccounted lines — first scan surfaces
    // only the people who still need attention.
    const collapsed = autoReimbursedGroupedByUser.filter((u) => u.unaccountedCount === 0).map((u) => u.userId);
    setCollapsedAutoUserKeys(new Set(collapsed));
  }, [autoReimbursedGroupedByUser]);
  const toggleAutoUserGroup = (userId: string) => {
    setCollapsedAutoUserKeys((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const toggleAutoExpensePeriodGroup = (compositeKey: string) => {
    setCollapsedAutoExpensePeriodKeys((prev) => {
      const next = new Set(prev);
      if (next.has(compositeKey)) next.delete(compositeKey);
      else next.add(compositeKey);
      return next;
    });
  };

  useEffect(() => {
    if (autoReimbursedGroupedByPayPeriod.length === 0) {
      hasSeededAutoExpensePeriodCollapse.current = false;
      setCollapsedAutoExpensePeriodKeys(new Set());
      return;
    }
    if (hasSeededAutoExpensePeriodCollapse.current) return;
    hasSeededAutoExpensePeriodCollapse.current = true;
    // Start with every pay-period card collapsed — composite (userId|periodKey) so each
    // user's period collapses independently rather than all sharing one period state.
    const collapsed: string[] = [];
    for (const u of autoReimbursedGroupedByUser) {
      for (const p of u.periods) collapsed.push(`${u.userId}|${p.periodKey}`);
    }
    setCollapsedAutoExpensePeriodKeys(new Set(collapsed));
  }, [autoReimbursedGroupedByPayPeriod, autoReimbursedGroupedByUser]);

  useEffect(() => {
    hasSeededAutoExpensePeriodCollapse.current = false;
    setCollapsedAutoExpensePeriodKeys(new Set());
  }, [autoEmployeeFilter]);

  const toggleMyExpensePeriodGroup = (periodKey: string) => {
    setCollapsedMyExpensePeriodKeys((prev) => {
      const next = new Set(prev);
      if (next.has(periodKey)) next.delete(periodKey);
      else next.add(periodKey);
      return next;
    });
  };
  /** Composite key (userId|periodKey) — the user-first layout means the same period
   *  appears under every employee, so a plain periodKey would toggle all of them at
   *  once. Composite keying scopes each toggle to a single user-card row. */
  const toggleAdminExpensePeriodGroup = (compositeKey: string) => {
    setCollapsedAdminExpensePeriodKeys((prev) => {
      const next = new Set(prev);
      if (next.has(compositeKey)) next.delete(compositeKey);
      else next.add(compositeKey);
      return next;
    });
  };

  // On first load, collapse every pay period except the current one so the page opens to
  // "what you're working on right now". Re-seeds when the underlying data changes shape.
  useEffect(() => {
    if (myExpensesGroupedByPayPeriod.length === 0) {
      hasSeededMyExpensePeriodCollapse.current = false;
      setCollapsedMyExpensePeriodKeys(new Set());
      return;
    }
    if (hasSeededMyExpensePeriodCollapse.current) return;
    hasSeededMyExpensePeriodCollapse.current = true;
    const collapsed = myExpensesGroupedByPayPeriod.map((p) => p.periodKey);
    setCollapsedMyExpensePeriodKeys(new Set(collapsed));
  }, [myExpensesGroupedByPayPeriod]);

  useEffect(() => {
    hasSeededAdminExpensePeriodCollapse.current = false;
    setCollapsedAdminExpensePeriodKeys(new Set());
  }, [adminStatusFilter]);

  useEffect(() => {
    if (adminFilteredExpensesGroupedByPayPeriod.length === 0) {
      hasSeededAdminExpensePeriodCollapse.current = false;
      setCollapsedAdminExpensePeriodKeys(new Set());
      return;
    }
    if (hasSeededAdminExpensePeriodCollapse.current) return;
    hasSeededAdminExpensePeriodCollapse.current = true;
    // Seed composite keys (one per user × period) so the initial "everything collapsed"
    // state covers every card on the page, not just one row per period.
    const collapsed: string[] = [];
    for (const u of adminFilteredExpensesGroupedByUser) {
      for (const p of u.periods) collapsed.push(`${u.userId}|${p.periodKey}`);
    }
    setCollapsedAdminExpensePeriodKeys(new Set(collapsed));
  }, [adminFilteredExpensesGroupedByPayPeriod, adminFilteredExpensesGroupedByUser]);

  const toggleMyExpenseDateGroup = (dateKey: string) => {
    setCollapsedMyExpenseDateKeys((prev) => {
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

  // Admin employee overview: per-employee counts (unpaid, paid). Excludes
  // hidden hotel ticket placeholders so the badges match what's visible
  // in the User Expense Management table.
  const expenseEmployeeSummary = useMemo(() => {
    if (!isAdmin || !employees?.length) return [];
    const map = new Map<string, { userId: string; name: string; unpaid: number; paid: number }>();
    for (const e of mergedAdminExpenses) {
      if (isHiddenHotelTicketPlaceholder(e)) continue;
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
          // Receipt is being linked to ticket expense lines that already carry their
          // own billing — mark billed so the receipt reads correctly downstream and
          // hide the per-line toggle in the form.
          is_billable: true,
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
        // Backlink so payroll dedup catches this pair without falling back to description
        // matching (the missing link is what caused the Chase Gibbon double-reimbursement).
        user_expense_id: applyExpenseId,
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

      {/* Top-level view tabs: Receipt expenses (action-required) vs. Auto-reimbursed
          (informational, no buttons). Same rail look as Invoices for consistency.
          The ::before "Workflow" eyebrow is shared across the app — accepted here. */}
      <div className="ionex-tabs-rail" role="tablist" aria-label="Expenses view">
        {([
          // Each tab's badge counts only rows that still need admin action — the receipt-
          // expenses tab is already action-only (rows still need a receipt linked), so its
          // length is the natural count. The Auto and Contractors tabs aggregate "anything
          // that's been entered" so we have to filter to reimbursement_status != 'paid' for
          // the count badge to mean "do something here".
          { id: 'receipts' as const, label: 'Receipt expenses', count: pendingReceiptLinesView.length },
          {
            id: 'auto' as const,
            label: 'Auto-reimbursed',
            count: autoReimbursedRows.filter((r: any) => String(r.reimbursement_status || '') !== 'paid').length,
          },
          // Admin-only — contractors invoice the company, so the tab is irrelevant to
          // employee logins. Filtered out of the rail below rather than hidden via CSS so
          // the rail measures correctly without a phantom slot.
          ...(isAdmin ? [{
            id: 'contractors' as const,
            label: 'Contractors',
            count: contractorTicketExpenseRows.filter((r: any) => String(r.reimbursement_status || '') !== 'paid').length,
          }] : []),
          // Admin User Expense Management — surfaces every receipt + reimbursable
          // ticket-expense across the company, grouped by employee. Promoted from a
          // collapsible panel into a tab so the workflow rail is the single nav.
          ...(isAdmin ? [{
            id: 'management' as const,
            label: 'User Expense Management',
            count: expenseEmployeeSummary.reduce((s, e) => s + e.unpaid, 0),
          }] : []),
          // Reconcile — pay-period-first view of every unaccounted line, optimized
          // for entering expenses into the books. Same source data as UEM but laid
          // out for sequential bookkeeping work rather than per-employee audit.
          ...(isAdmin ? [{
            id: 'reconcile' as const,
            label: 'Reconcile',
            count: reconcileGroupedByPayPeriod.reduce((s, p) => s + p.totals.count, 0),
          }] : []),
        ]).map((tab) => {
          const isActive = activeExpensesTab === tab.id;
          const classes = ['ionex-tab-chip'];
          if (isActive) classes.push('is-active');
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => {
                // Switching to Auto while a receipt-link is in progress would unmount
                // the form mid-edit. Cancel cleanly + surface a brief notice.
                if (tab.id === 'auto' && linkingTicketExpenseIds.length > 0) {
                  cancelReceiptLinking();
                  setTabSwitchNotice('In-progress receipt link cancelled.');
                }
                setActiveExpensesTab(tab.id);
              }}
              className={classes.join(' ')}
            >
              <span>{tab.label}</span>
              <span className={`ionex-tab-count${tab.count === 0 ? ' is-zero' : ''}`}>{tab.count}</span>
            </button>
          );
        })}
      </div>
      {tabSwitchNotice && (
        <div
          role="status"
          style={{
            marginBottom: '16px',
            padding: '8px 12px',
            borderRadius: '8px',
            backgroundColor: 'rgba(245, 158, 11, 0.10)',
            border: '1px solid rgba(245, 158, 11, 0.35)',
            color: '#92400e',
            fontSize: '13px',
          }}
        >
          {tabSwitchNotice}
        </div>
      )}

      {activeExpensesTab === 'receipts' && pendingReceiptLinesGated.length > 0 && (
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
                  ? "All reimbursable ticket charges across employees with no receipt and no inline reimbursement amount set. Filter by employee, then submit a receipt or link an existing one. (Lines where the employee entered the reimbursement amount directly on the ticket don't appear here.)"
                  : "Reimbursable charges you've added to service tickets that still need an amount. Two ways to clear a line: select it and upload the receipt, or open the ticket, Edit the line, and enter the amount in the blue \"Your reimbursement amount\" box."}
              </p>
              )}
              {!pendingReceiptCollapsed && (<>
              <p style={{ margin: '8px 0 0', fontSize: '12px', color: 'var(--text-primary)', lineHeight: 1.45, maxWidth: '720px', padding: '8px 10px', borderRadius: '6px', backgroundColor: 'rgba(0, 137, 123, 0.08)', border: '1px solid rgba(0, 137, 123, 0.3)' }}>
                <strong style={{ color: '#00897b' }}>Reimbursement note:</strong> as soon as a receipt is attached, this expense is included on the next payroll for reimbursement to the employee. Auto-reimbursed items (Mileage, Truck Hours, Per Diem, basic Equipment) live in the Auto-reimbursed tab — they're paid on the next payroll automatically.
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
              const n = pendingReceiptSelectedIds.size;
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', flexShrink: 0, alignSelf: 'center', minWidth: '280px' }}>
                  {/* One-receipt-to-many-items call-out, mirrors the Link Receipt modal's
                      banner so admins don't have to guess what "Submit receipt for N items"
                      actually does. */}
                  {n > 1 && (
                    <div
                      style={{
                        padding: '10px 12px',
                        borderRadius: '8px',
                        backgroundColor: 'color-mix(in srgb, var(--primary-color) 8%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--primary-color) 30%, transparent)',
                        fontSize: '12px',
                        color: 'var(--text-secondary)',
                        lineHeight: 1.5,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                      }}
                      aria-live="polite"
                    >
                      <span
                        style={{
                          flexShrink: 0,
                          width: '22px',
                          height: '22px',
                          borderRadius: '50%',
                          backgroundColor: 'color-mix(in srgb, var(--primary-color) 14%, var(--bg-primary))',
                          color: 'var(--primary-color)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '13px',
                          fontWeight: 800,
                        }}
                        aria-hidden
                      >
                        1
                      </span>
                      <span style={{ flex: 1 }}>
                        <strong style={{ color: 'var(--text-primary)' }}>One receipt → all {n} items.</strong>{' '}
                        Upload a single receipt and we&apos;ll attach it to every line you ticked.
                      </span>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => startReceiptLinkingForLines([...pendingReceiptSelectedIds])}
                    title={
                      n === 1
                        ? 'Upload a receipt for this ticket-expense line.'
                        : `Upload one receipt and attach it to all ${n} ticked lines in one go.`
                    }
                    style={{
                      padding: '10px 14px',
                      borderRadius: '8px',
                      backgroundColor: 'var(--primary-color)',
                      color: 'white',
                      border: 'none',
                      fontSize: '13px',
                      fontWeight: 700,
                      letterSpacing: '0.01em',
                      cursor: 'pointer',
                    }}
                  >
                    {n === 1
                      ? 'Submit receipt for 1 item'
                      : `Submit one receipt for all ${n} items`}
                  </button>
                  {canSplitHotel && (
                    <button
                      type="button"
                      onClick={() => openSplitWizard(selectedHotelIds)}
                      title="One hotel bill covering several nights — splits subtotal + tax across selected hotel lines proportionally"
                      style={{
                        padding: '9px 14px',
                        borderRadius: '8px',
                        border: '1px solid color-mix(in srgb, var(--warning-color) 60%, transparent)',
                        backgroundColor: 'color-mix(in srgb, var(--warning-color) 14%, transparent)',
                        color: 'color-mix(in srgb, var(--warning-color) 80%, var(--text-primary))',
                        fontSize: '12px',
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Split one hotel bill across {selectedHotelIds.length} nights
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
                          title="Upload a receipt for this line. Tip: tick multiple lines first to attach one receipt to all of them at once."
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

      {/* Drag and Drop Zone — Receipts tab only. */}
      {activeExpensesTab === 'receipts' && (<>
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
                  {linkingTicketExpenseIds.length > 0 ? (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '6px 0',
                        fontSize: '11px',
                        fontWeight: 600,
                        letterSpacing: '0.03em',
                        color: '#15803d',
                      }}
                      title="Billed via the linked ticket expense line(s) above — no toggle needed."
                    >
                      ✓ Billed
                    </span>
                  ) : (
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
                  )}
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
      </>)}

      {/* Expenses Table — Receipts tab only. Admins also see it; the broader
          User Expense Management section below is collapsed by default, so this
          per-user ledger is no longer a noisy duplicate. */}
      {activeExpensesTab === 'receipts' && (isLoading ? (
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
                myExpensesGroupedByPayPeriod.map((period) => {
                  const periodCollapsed = collapsedMyExpensePeriodKeys.has(period.periodKey);
                  return (
                    <Fragment key={`period-${period.periodKey}`}>
                      {/* Pay-period header: anchors the date subgroups beneath it. The teal accent +
                          eyebrow label distinguishes this from the per-day grey header. Totals
                          line up the way they'd be keyed into payroll for the window. */}
                      <tr style={{ backgroundColor: 'rgba(20, 184, 166, 0.10)', borderBottom: '2px solid rgba(20, 184, 166, 0.45)' }}>
                        <td colSpan={8} style={{ padding: 0 }}>
                          <button
                            type="button"
                            onClick={() => toggleMyExpensePeriodGroup(period.periodKey)}
                            aria-expanded={!periodCollapsed}
                            style={{
                              width: '100%', display: 'flex', alignItems: 'center', gap: '12px',
                              padding: '12px 16px', border: 'none', background: 'transparent',
                              cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                            }}
                          >
                            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', width: '14px', flexShrink: 0 }} aria-hidden>
                              {periodCollapsed ? '▶' : '▼'}
                            </span>
                            <span style={{ fontSize: '10px', fontWeight: 700, color: '#0f766e', textTransform: 'uppercase', letterSpacing: '0.06em', flexShrink: 0 }}>
                              Pay Period
                            </span>
                            <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>
                              {period.periodLabel}
                            </span>
                            {period.isCurrent && (
                              <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px', backgroundColor: 'rgba(34, 197, 94, 0.18)', color: '#15803d', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Current</span>
                            )}
                            {period.isFuture && (
                              <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Upcoming</span>
                            )}
                            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'baseline', gap: '16px', fontSize: '12px', color: 'var(--text-secondary)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                              <span><strong style={{ color: 'var(--text-primary)' }}>{period.totals.count}</strong> {period.totals.count === 1 ? 'expense' : 'expenses'}</span>
                              <span>Subtotal <strong style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>${period.totals.amount.toFixed(2)}</strong></span>
                              <span>GST <strong style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>${period.totals.gst.toFixed(2)}</strong></span>
                              <span>Total <strong style={{ fontFamily: 'monospace', color: '#0f766e' }}>${period.totals.total.toFixed(2)}</strong></span>
                            </span>
                          </button>
                        </td>
                      </tr>
                      {!periodCollapsed && period.dateGroups.map(({ dateKey, items }) => {
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
                              padding: '10px 16px 10px 32px',
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
                })}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ))}

      {/* Admin: User Expense Management — promoted to its own workflow tab. The
          collapsible header was retired with the tab move; the tab toggle is now the
          single nav surface. */}
      {activeExpensesTab === 'management' && isAdmin && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap', marginBottom: '14px' }}>
            <h2 style={{ fontSize: '20px', fontWeight: '800', color: 'var(--text-primary)', margin: 0, letterSpacing: '-0.01em' }}>
              User Expense Management
            </h2>
            {(() => {
              const totalUnpaid = expenseEmployeeSummary.reduce((s, e) => s + e.unpaid, 0);
              const totalPaid = expenseEmployeeSummary.reduce((s, e) => s + e.paid, 0);
              const employeeCount = expenseEmployeeSummary.length;
              return (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
                  <span className="ionex-status-pill" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', borderColor: 'var(--border-color)' }}>
                    {employeeCount} {employeeCount === 1 ? 'employee' : 'employees'}
                  </span>
                  {totalUnpaid > 0 && (
                    <span className="ionex-status-pill is-unpaid">{totalUnpaid} unaccounted</span>
                  )}
                  {totalPaid > 0 && (
                    <span className="ionex-status-pill is-paid">{totalPaid} accounted</span>
                  )}
                </span>
              );
            })()}
          </div>

          {/* Single inline filter rail — no popover, no separate chip strip. Status / Employee
              / Type / Date / Clear are all visible at once so the admin sees what's filtering
              the table without clicking through. */}
          <div className="ionex-filter-rail" style={{ marginBottom: '12px', alignItems: 'flex-end' }}>
            <div className="ionex-filter-cell" style={{ flex: '0 0 auto', minWidth: 0 }}>
              <span className="ionex-filter-cell-label">Status</span>
              <div style={{ display: 'flex', gap: '4px' }}>
                {(['unpaid', 'paid', 'all'] as const).map((status) => {
                  const visible = mergedAdminExpensesForApproval.filter((e: any) => !isHiddenHotelTicketPlaceholder(e));
                  const count = status === 'all'
                    ? visible.length
                    : visible.filter((e: any) => e._status === status).length;
                  // Status filter value is still 'paid'/'unpaid' internally — only the label
                  // changes to match the explicit "Accounted For" workflow the admin sees.
                  const label = status === 'unpaid' ? 'Unaccounted' : status === 'paid' ? 'Accounted' : 'All';
                  return (
                    <button
                      key={status}
                      type="button"
                      onClick={() => setAdminStatusFilter(status)}
                      className={`ionex-tab-chip${adminStatusFilter === status ? ' is-active' : ''}`}
                      style={{ padding: '6px 12px' }}
                    >
                      {label}
                      <span className={`ionex-tab-count${count === 0 ? ' is-zero' : ''}`}>{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="ionex-filter-cell" style={{ flex: '1 1 240px', minWidth: '200px' }}>
              <label className="ionex-filter-cell-label" htmlFor="uem-employee-filter">Employee</label>
              <div className="ionex-employee-select-wrap">
                <select
                  id="uem-employee-filter"
                  value={adminEmployeeFilter}
                  onChange={(e) => setAdminEmployeeFilter(e.target.value)}
                  className="ionex-field-input"
                  style={{ paddingRight: adminEmployeeFilter === 'all' ? '32px' : '52px' }}
                >
                  <option value="all">All employees</option>
                  {expenseEmployeeSummary.map((emp) => (
                    <option key={emp.userId} value={emp.userId}>
                      {emp.name}{emp.unpaid > 0 ? ` — ${emp.unpaid} unaccounted` : ''}
                    </option>
                  ))}
                </select>
                {adminEmployeeFilter !== 'all' && (() => {
                  const sel = expenseEmployeeSummary.find((e) => e.userId === adminEmployeeFilter);
                  if (!sel || sel.unpaid <= 0) return null;
                  return <span className="unpaid-pill">{sel.unpaid}</span>;
                })()}
              </div>
            </div>
            <div className="ionex-filter-cell" style={{ flex: '0 1 180px', minWidth: '150px' }}>
              <label className="ionex-filter-cell-label" htmlFor="uem-type-filter">Type</label>
              <select
                id="uem-type-filter"
                value={adminTypeFilter}
                onChange={(e) => setAdminTypeFilter(e.target.value)}
                className="ionex-field-input"
              >
                <option value="all">All types</option>
                {adminTypeOptions.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div className="ionex-filter-cell" style={{ flex: '1 1 300px', minWidth: '260px' }}>
              <span className="ionex-filter-cell-label">Date range</span>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <input
                  type="date"
                  value={adminDateStart}
                  onChange={(e) => setAdminDateStart(e.target.value)}
                  className="ionex-field-input"
                  style={{ flex: 1, minWidth: 0 }}
                />
                <span style={{ color: 'var(--text-tertiary)', fontSize: '11px', flexShrink: 0 }}>→</span>
                <input
                  type="date"
                  value={adminDateEnd}
                  onChange={(e) => setAdminDateEnd(e.target.value)}
                  className="ionex-field-input"
                  style={{ flex: 1, minWidth: 0 }}
                />
              </div>
            </div>
            {(() => {
              const anyActive =
                adminStatusFilter !== 'unpaid' ||
                adminEmployeeFilter !== 'all' ||
                adminTypeFilter !== 'all' ||
                !!adminDateStart ||
                !!adminDateEnd;
              return (
                <div className="ionex-filter-cell-action">
                  <button
                    type="button"
                    onClick={() => {
                      setAdminStatusFilter('unpaid');
                      setAdminEmployeeFilter('all');
                      setAdminTypeFilter('all');
                      setAdminDateStart('');
                      setAdminDateEnd('');
                    }}
                    disabled={!anyActive}
                    className="ionex-report-action"
                    style={{ opacity: anyActive ? 1 : 0.55 }}
                  >
                    Reset filters
                  </button>
                </div>
              );
            })()}
          </div>

          {/* Sticky bulk-action bar — pins to the top of the panel scroll area while
              there's a selection, so the admin doesn't have to scroll back to act on it. */}
          {(() => {
            const selectedRows = adminFilteredExpenses.filter((e: any) => selectedExpenseKeys.has(`${e._source}-${e.id}`));
            if (selectedRows.length === 0) return null;
            const unpaidRows = selectedRows.filter((r: any) => r._status === 'unpaid');
            const paidRows = selectedRows.filter((r: any) => r._status === 'paid');
            const receiptRows = selectedRows.filter((r: any) => r._source === 'receipt');
            const receiptsToFlag = receiptRows.filter((r: any) => r.not_reimbursable !== true).map((r: any) => String(r.id));
            const receiptsToUnflag = receiptRows.filter((r: any) => r.not_reimbursable === true).map((r: any) => String(r.id));
            const receiptIds = receiptRows.map((r: any) => String(r.id));
            const selectedAmount = selectedRows.reduce((s: number, r: any) => s + (Number(r._amount) || 0), 0);
            const toStatusPayload = (rows: any[]) => rows.map((r: any) => ({ id: String(r.id), source: r._source as 'receipt' | 'ticket' }));
            return (
              <div className="ionex-bulk-bar" role="region" aria-label="Bulk actions">
                <span className="ionex-bulk-bar-count">
                  <strong>{selectedRows.length}</strong> selected
                  <span style={{ fontFamily: 'SF Mono, monospace', color: 'var(--text-tertiary)' }}>${selectedAmount.toFixed(2)}</span>
                </span>
                <span className="ionex-bulk-bar-divider" aria-hidden />
                {unpaidRows.length > 0 && (
                  <button
                    type="button"
                    className="ionex-row-action-icon is-success"
                    disabled={batchActionBusy}
                    onClick={() => handleAdminBatchStatusChange(toStatusPayload(unpaidRows), 'paid')}
                  >
                    Mark {unpaidRows.length} accounted
                  </button>
                )}
                {paidRows.length > 0 && (
                  <button
                    type="button"
                    className="ionex-row-action-icon is-warning"
                    disabled={batchActionBusy}
                    onClick={() => handleAdminBatchStatusChange(toStatusPayload(paidRows), 'pending')}
                  >
                    Mark {paidRows.length} unaccounted
                  </button>
                )}
                {receiptsToFlag.length > 0 && (
                  <button
                    type="button"
                    className="ionex-row-action-icon is-primary"
                    disabled={batchActionBusy}
                    onClick={() => handleAdminBatchSetNotReimbursable(receiptsToFlag, true)}
                    title="Drop these receipts from employee reimbursement; keep them for Apply-to-Ticket."
                  >
                    Not reimbursable ({receiptsToFlag.length})
                  </button>
                )}
                {receiptsToUnflag.length > 0 && (
                  <button
                    type="button"
                    className="ionex-row-action-icon is-primary"
                    disabled={batchActionBusy}
                    onClick={() => handleAdminBatchSetNotReimbursable(receiptsToUnflag, false)}
                    title="Re-include these receipts in employee reimbursement."
                  >
                    ↺ Restore ({receiptsToUnflag.length})
                  </button>
                )}
                {receiptIds.length > 0 && (
                  <button
                    type="button"
                    className="ionex-row-action-icon is-danger"
                    disabled={batchActionBusy}
                    onClick={() => handleAdminBatchDeleteReceipts(receiptIds)}
                    title="Delete the selected receipts permanently."
                  >
                    Delete {receiptIds.length}
                  </button>
                )}
                <button
                  type="button"
                  className="ionex-bulk-bar-clear"
                  onClick={() => setSelectedExpenseKeys(new Set())}
                >
                  Clear selection
                </button>
              </div>
            );
          })()}

          {adminFilteredExpenses.length === 0 ? (
            <div className="ionex-empty">
              <div className="title">No {adminStatusFilter === 'all' ? '' : adminStatusFilter} expenses match your filters</div>
              <div className="body">
                Try a different status, employee, type, or date range — or click <strong>Reset filters</strong> above.
              </div>
            </div>
          ) : (
            adminFilteredExpensesGroupedByUser.map((userGroup) => {
              const userCollapsed = collapsedAdminExpenseUserKeys.has(userGroup.userId);
              return (
                <div
                  key={`admin-user-${userGroup.userId}`}
                  className="ionex-customer-section"
                  style={{ marginBottom: '14px' }}
                >
                  <button
                    type="button"
                    className="ionex-customer-section-toggle"
                    onClick={() => toggleAdminExpenseUserGroup(userGroup.userId)}
                    aria-expanded={!userCollapsed}
                  >
                    <span aria-hidden className={`ionex-customer-section-chevron${userCollapsed ? ' is-collapsed' : ''}`}>▾</span>
                    <span className="ionex-customer-section-name">
                      {userGroup.userName}
                      {userGroup.unpaidCount > 0 && (
                        <span
                          title={`${userGroup.unpaidCount} unaccounted line${userGroup.unpaidCount === 1 ? '' : 's'} across all periods`}
                          style={{
                            marginLeft: '10px',
                            padding: '2px 9px',
                            fontSize: '11px',
                            fontWeight: 700,
                            borderRadius: '999px',
                            backgroundColor: 'rgba(245, 158, 11, 0.16)',
                            color: '#92400e',
                            letterSpacing: '0.04em',
                            textTransform: 'uppercase',
                            verticalAlign: 'middle',
                          }}
                        >
                          {userGroup.unpaidCount} unaccounted
                        </span>
                      )}
                    </span>
                    <span
                      className="ionex-customer-section-meta"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '5px' }}>
                        <strong style={{ color: 'var(--text-primary)', fontFamily: 'SF Mono, monospace', fontSize: '13px', fontVariantNumeric: 'tabular-nums' }}>
                          {userGroup.periods.length}
                        </strong>
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                          {userGroup.periods.length === 1 ? 'period' : 'periods'}
                        </span>
                      </span>
                      <span aria-hidden style={{ color: 'var(--text-tertiary)', opacity: 0.5 }}>·</span>
                      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '5px' }}>
                        <strong style={{ color: 'var(--text-primary)', fontFamily: 'SF Mono, monospace', fontSize: '13px', fontVariantNumeric: 'tabular-nums' }}>
                          {userGroup.totals.count}
                        </strong>
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                          {userGroup.totals.count === 1 ? 'item' : 'items'}
                        </span>
                      </span>
                      <span aria-hidden style={{ color: 'var(--text-tertiary)', opacity: 0.5 }}>·</span>
                      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '6px' }}>
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                          Total
                        </span>
                        <strong style={{ color: 'var(--primary-color)', fontFamily: 'SF Mono, monospace', fontSize: '15px', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                          ${userGroup.totals.total.toFixed(2)}
                        </strong>
                      </span>
                    </span>
                  </button>
                  {!userCollapsed && userGroup.periods.map((period) => {
              const compositePeriodKey = `${userGroup.userId}|${period.periodKey}`;
              const periodCollapsed = collapsedAdminExpensePeriodKeys.has(compositePeriodKey);
              const flatItems: any[] = period.dateGroups.flatMap((g) => g.items);
              const sharedReceiptMeta = sharedReceiptLabelMetaForGroup(flatItems);
              const receiptGroupTotals = sharedReceiptGroupTotalsInOrder(flatItems, sharedReceiptMeta);
              const periodKeys = flatItems.map((e: any) => `${e._source}-${e.id}`);
              const periodAllSelected = periodKeys.length > 0 && periodKeys.every((k) => selectedExpenseKeys.has(k));
              const periodAnySelected = periodKeys.some((k) => selectedExpenseKeys.has(k));
              const toggleAllInPeriod = (checked: boolean) => {
                setSelectedExpenseKeys((prev) => {
                  const next = new Set(prev);
                  if (checked) for (const k of periodKeys) next.add(k);
                  else for (const k of periodKeys) next.delete(k);
                  return next;
                });
              };
              const periodModifier = period.isCurrent ? '' : period.isFuture ? ' is-future' : '';
              return (
                <div
                  key={`admin-period-${userGroup.userId}-${period.periodKey}`}
                  className={`ionex-period-card${periodCollapsed ? ' is-collapsed' : ''}${periodModifier}`}
                >
                  <button
                    type="button"
                    className="ionex-period-card-header"
                    onClick={() => toggleAdminExpensePeriodGroup(compositePeriodKey)}
                    aria-expanded={!periodCollapsed}
                  >
                    <span className="ionex-period-card-chevron" style={{ transform: periodCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }} aria-hidden>▶</span>
                    <span className="ionex-period-card-eyebrow">Pay period</span>
                    <span className="ionex-period-card-title">{period.periodLabel}</span>
                    {period.isCurrent && <span className="ionex-status-pill is-period-current">Current</span>}
                    {period.isFuture && <span className="ionex-status-pill is-period-future">Upcoming</span>}
                    <span className="ionex-period-card-meta">
                      <span><strong>{period.totals.count}</strong> {period.totals.count === 1 ? 'item' : 'items'}</span>
                      <span>Subtotal <strong>${period.totals.amount.toFixed(2)}</strong></span>
                      {period.totals.gst > 0 && (
                        <span>GST <strong>${period.totals.gst.toFixed(2)}</strong></span>
                      )}
                      <span>Total <strong className="is-grand">${period.totals.total.toFixed(2)}</strong></span>
                    </span>
                  </button>
                  <div className="ionex-period-card-body">
                    <div style={{ overflowX: 'auto' }}>
                      <table className="ionex-expense-table" style={{ minWidth: '900px' }}>
                        <thead>
                          <tr>
                            <th className="is-checkbox">
                              <input
                                type="checkbox"
                                checked={periodAllSelected}
                                ref={(el) => { if (el) el.indeterminate = !periodAllSelected && periodAnySelected; }}
                                onChange={(e) => toggleAllInPeriod(e.target.checked)}
                                title="Select all in this pay period"
                                style={{ cursor: 'pointer' }}
                              />
                            </th>
                            <th>Employee</th>
                            <th>Date</th>
                            <th>Description</th>
                            <th className="is-numeric">Amount</th>
                            <th className="is-center">Ticket</th>
                            <th className="is-numeric">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {flatItems.flatMap((exp: any, rowIdx: number) => {
                            const isUpdating = updatingExpenseId === exp.id;
                            const status = exp._status;
                            const source = exp._source;
                            const u = (exp.receipt_url && String(exp.receipt_url).trim()) || '';
                            const isFirstOfSharedReceipt =
                              u &&
                              sharedReceiptMeta.has(String(exp.id)) &&
                              !flatItems.slice(0, rowIdx).some(
                                (x: any) =>
                                  (x.receipt_url && String(x.receipt_url).trim()) === u &&
                                  sharedReceiptMeta.has(String(x.id))
                              );
                            const groupRow =
                              isFirstOfSharedReceipt &&
                              receiptGroupTotals.find((g) => g.url === u);
                            const summaryTr = groupRow ? (
                              <tr
                                key={`admin-receipt-total-${period.periodKey}-${exp.id}`}
                                className="ionex-expense-table-row is-summary"
                                aria-label="Receipt total for split lines"
                              >
                                <td colSpan={4}>
                                  Receipt total — {groupRow.lineCount} lines · Subtotal ${groupRow.amountSum.toFixed(2)} · GST ${groupRow.gstSum.toFixed(2)} · Total ${groupRow.combinedTotal.toFixed(2)}
                                </td>
                                <td className="is-numeric">
                                  ${groupRow.amountSum.toFixed(2)}
                                </td>
                                <td colSpan={2} />
                              </tr>
                            ) : null;
                            const selectionKey = `${source}-${exp.id}`;
                            const isSelected = selectedExpenseKeys.has(selectionKey);
                            const dateKeyRow = normalizeExpenseTableDateKey(String(exp._date || ''));
                            const sharedPart = source === 'receipt' ? sharedReceiptMeta.get(String(exp.id)) : null;
                            const expenseTr = (
                              <tr
                                key={`${source}-${exp.id}`}
                                className={`ionex-expense-table-row${source === 'receipt' ? ' is-selectable' : ''}${isSelected ? ' is-selected' : ''}`}
                                onClick={source === 'receipt' ? () => handleStartEdit(exp) : undefined}
                                role={source === 'receipt' ? 'button' : undefined}
                                tabIndex={source === 'receipt' ? 0 : undefined}
                                onKeyDown={source === 'receipt' ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleStartEdit(exp); } } : undefined}
                              >
                                <td onClick={(e) => e.stopPropagation()} style={{ paddingLeft: '18px', width: '32px' }}>
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={(e) => {
                                      setSelectedExpenseKeys((prev) => {
                                        const next = new Set(prev);
                                        if (e.target.checked) next.add(selectionKey);
                                        else next.delete(selectionKey);
                                        return next;
                                      });
                                    }}
                                    style={{ cursor: 'pointer' }}
                                    aria-label="Select expense"
                                  />
                                </td>
                                <td>
                                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{exp._employeeName || '—'}</span>
                                  {source === 'ticket' && (
                                    <span className="ionex-expense-table-subline">Ticket expense</span>
                                  )}
                                </td>
                                <td style={{ whiteSpace: 'nowrap' }}>
                                  {dateKeyRow ? formatExpenseGroupDateLabel(dateKeyRow) : '—'}
                                </td>
                                <td>
                                  <div className="ionex-expense-table-desc-meta">
                                    <span className="desc">{exp.description}</span>
                                    <span className={`ionex-status-pill ${status === 'paid' ? 'is-paid' : 'is-unpaid'}`}>
                                      {status === 'paid' ? 'Accounted' : 'Unaccounted'}
                                    </span>
                                    {source === 'receipt' && exp.not_reimbursable === true && (
                                      <span
                                        className="ionex-status-pill is-not-reimb"
                                        title="Admin removed this receipt from the employee's reimbursement. Available for Apply-to-Ticket."
                                      >
                                        Not reimbursable
                                      </span>
                                    )}
                                    {source === 'receipt' && exp.is_billable === false && exp.not_reimbursable !== true && (
                                      <span className="ionex-status-pill" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' }}>
                                        Not billable
                                      </span>
                                    )}
                                    {sharedPart && (
                                      <span
                                        className="ionex-status-pill is-shared"
                                        title="This receipt was split into multiple lines for this employee."
                                      >
                                        Same receipt · ${sharedPart.combinedTotal.toFixed(2)} · {sharedPart.index}/{sharedPart.total}
                                      </span>
                                    )}
                                  </div>
                                  {source === 'receipt' && exp.receipt_url && (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleViewReceipt(exp); }}
                                      className="ionex-expense-table-link-button"
                                      style={{ marginTop: '4px' }}
                                    >
                                      {loadingReceiptId === exp.id ? 'Loading…' : 'View receipt'}
                                    </button>
                                  )}
                                  {source === 'ticket' && exp.expense_type && (
                                    <span className="ionex-expense-table-subline">
                                      {exp.expense_type}{exp.unit ? ` (${exp.quantity} ${exp.unit})` : ''}
                                    </span>
                                  )}
                                  {exp.notes && (
                                    <span className="ionex-expense-table-subline is-note">Note: {exp.notes}</span>
                                  )}
                                </td>
                                <td className="is-numeric">
                                  <span className="ionex-expense-table-amount">${exp._amount.toFixed(2)}</span>
                                  {source === 'receipt' && parseFloat(exp.gst || 0) > 0 && (
                                    <span className="ionex-expense-table-amount-gst">+ GST ${parseFloat(exp.gst || 0).toFixed(2)}</span>
                                  )}
                                </td>
                                <td className="is-center" style={{ whiteSpace: 'nowrap' }}>
                                  {exp._ticketNumber && exp.service_ticket_id ? (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); setViewingTicketRecordId(String(exp.service_ticket_id)); }}
                                      className="ionex-expense-table-link-button is-strong"
                                      title="Open service ticket"
                                    >
                                      {exp._ticketNumber}
                                    </button>
                                  ) : (
                                    <span style={{ color: 'var(--text-tertiary)' }}>{exp._ticketNumber || '—'}</span>
                                  )}
                                </td>
                                <td className="is-actions" onClick={(e) => e.stopPropagation()}>
                                  <div className="ionex-row-actions">
                                    {status === 'unpaid' && (
                                      <button
                                        type="button"
                                        className="ionex-row-action-icon is-success"
                                        disabled={isUpdating}
                                        onClick={(e) => { e.stopPropagation(); handleAdminStatusChange(exp.id, 'paid', source, exp); }}
                                        title="Mark this expense as Accounted For — it's been recorded in the books."
                                      >
                                        Mark Accounted For
                                      </button>
                                    )}
                                    {status === 'paid' && (
                                      <button
                                        type="button"
                                        className="ionex-row-action-icon is-warning"
                                        disabled={isUpdating}
                                        onClick={(e) => { e.stopPropagation(); handleAdminStatusChange(exp.id, 'pending', source); }}
                                        title="Reopen — flip back to Unaccounted so this expense appears in the workflow again."
                                      >
                                        Mark Unaccounted
                                      </button>
                                    )}
                                    {source === 'receipt' && (() => {
                                      const isNot = exp.not_reimbursable === true;
                                      const isBusy = setNotReimbursableMutation.isPending && setNotReimbursableMutation.variables?.id === String(exp.id);
                                      return (
                                        <button
                                          type="button"
                                          className="ionex-row-action-icon is-primary"
                                          disabled={isBusy}
                                          onClick={(e) => handleToggleNotReimbursable(exp, e)}
                                          title={isNot
                                            ? 'Restore this receipt so it counts toward employee reimbursement again.'
                                            : "Remove this receipt from the employee's reimbursement (e.g. company paid). Stays available for Apply-to-Ticket."}
                                        >
                                          {isBusy ? '…' : isNot ? '↺ Restore' : 'Not reimbursable'}
                                        </button>
                                      );
                                    })()}
                                    {source === 'receipt' && (() => {
                                      const isBusy = deleteExpenseMutation.isPending && deleteExpenseMutation.variables === exp.id;
                                      return (
                                        <button
                                          type="button"
                                          className="ionex-row-action-icon is-danger"
                                          disabled={isBusy}
                                          onClick={(e) => requestAdminDeleteReceipt(exp, e)}
                                          title="Delete this receipt from the employee's expenses (cannot be undone)."
                                        >
                                          {isBusy ? 'Deleting…' : 'Delete'}
                                        </button>
                                      );
                                    })()}
                                    {source === 'ticket' && (() => {
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
                                            className="ionex-status-pill is-contractor"
                                            title="Contractor — invoices us for expenses, no receipt required"
                                          >
                                            Contractor
                                          </span>
                                        );
                                      }
                                      const hasReceipt = (Number(exp.actual_cost) || 0) > 0 || !!exp.user_expense_id;
                                      if (hasReceipt) return null;
                                      return (
                                        <button
                                          type="button"
                                          className="ionex-row-action-icon is-warning"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            if (exp.service_ticket_id) {
                                              setViewingTicketRecordId(String(exp.service_ticket_id));
                                            }
                                          }}
                                          title="Receipt not attached yet — click to open ticket and attach"
                                        >
                                          📎 Receipt pending
                                        </button>
                                      );
                                    })()}
                                    {source === 'receipt' && (() => {
                                      if (!exp.is_billable && !exp.not_reimbursable) return null;
                                      const linkedRows = linkedByReceiptId.get(String(exp.id)) || [];
                                      const hasLinks = linkedRows.length > 0;
                                      const directTicketNumber = exp.service_tickets?.ticket_number || null;
                                      const isDirectApplied = !!exp.service_ticket_id;
                                      const isExpanded = expandedLinkedReceiptId === String(exp.id);
                                      if (isDirectApplied && !hasLinks) {
                                        return (
                                          <span
                                            className="ionex-status-pill is-applied"
                                            title={`Applied to ticket ${directTicketNumber ?? ''}`}
                                          >
                                            ✓ Applied{directTicketNumber ? ` · ${directTicketNumber}` : ''}
                                          </span>
                                        );
                                      }
                                      return (
                                        <>
                                          {hasLinks && (
                                            <button
                                              type="button"
                                              className="ionex-row-action-icon is-success"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setExpandedLinkedReceiptId(isExpanded ? null : String(exp.id));
                                              }}
                                              title="View / unlink the ticket expenses this receipt covers"
                                            >
                                              ✓ Linked ({linkedRows.length}) {isExpanded ? '▴' : '▾'}
                                            </button>
                                          )}
                                          <button
                                            type="button"
                                            className="ionex-row-action-icon is-primary"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setLinkReceiptModal({ receipt: exp });
                                              setLinkReceiptSelectedIds(new Set());
                                              setLinkReceiptError(null);
                                            }}
                                            title={hasLinks ? 'Link to additional ticket expenses' : 'Link this receipt to ticket expenses awaiting it'}
                                          >
                                            {hasLinks ? '+ Link more' : 'Link'}
                                          </button>
                                        </>
                                      );
                                    })()}
                                  </div>
                                </td>
                              </tr>
                            );
                            let linkedTr: JSX.Element | null = null;
                            if (source === 'receipt' && expandedLinkedReceiptId === String(exp.id)) {
                              const linkedRows = linkedByReceiptId.get(String(exp.id)) || [];
                              if (linkedRows.length > 0) {
                                linkedTr = (
                                  <tr
                                    key={`${source}-${exp.id}-linked`}
                                    className="ionex-expense-table-row is-linked-detail"
                                  >
                                    <td colSpan={7} style={{ padding: 0 }}>
                                      <div className="ionex-linked-detail">
                                        <div className="ionex-linked-detail-eyebrow">
                                          Receipt is linked to {linkedRows.length} ticket expense{linkedRows.length === 1 ? '' : 's'}
                                        </div>
                                        <table className="ionex-linked-detail-table">
                                          <thead>
                                            <tr>
                                              <th>Type</th>
                                              <th>Description</th>
                                              <th>Ticket</th>
                                              <th>Date</th>
                                              <th className="is-numeric">Billed</th>
                                              <th className="is-numeric">Action</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {linkedRows.map((lr: any) => {
                                              const billed = (Number(lr.quantity) || 0) * (Number(lr.rate) || 0);
                                              const tn = lr.service_tickets?.ticket_number || '—';
                                              const dt = lr.service_tickets?.date || '—';
                                              return (
                                                <tr key={String(lr.id)}>
                                                  <td style={{ fontWeight: 600 }}>{lr.expense_type || '—'}</td>
                                                  <td style={{ color: 'var(--text-secondary)' }}>{lr.description || '—'}</td>
                                                  <td className="is-mono">
                                                    {lr.service_ticket_id ? (
                                                      <button
                                                        type="button"
                                                        onClick={() => setViewingTicketRecordId(String(lr.service_ticket_id))}
                                                        className="ionex-expense-table-link-button is-strong"
                                                        style={{ fontFamily: 'inherit' }}
                                                      >
                                                        {tn}
                                                      </button>
                                                    ) : tn}
                                                  </td>
                                                  <td style={{ color: 'var(--text-secondary)' }}>{dt}</td>
                                                  <td className="is-numeric" style={{ fontWeight: 600 }}>${billed.toFixed(2)}</td>
                                                  <td className="is-numeric">
                                                    <button
                                                      type="button"
                                                      className="ionex-row-action-icon is-danger"
                                                      disabled={unlinkingTicketExpenseId === String(lr.id)}
                                                      onClick={() => handleUnlinkTicketExpense(String(lr.id))}
                                                    >
                                                      {unlinkingTicketExpenseId === String(lr.id) ? 'Unlinking…' : 'Unlink'}
                                                    </button>
                                                  </td>
                                                </tr>
                                              );
                                            })}
                                          </tbody>
                                        </table>
                                      </div>
                                    </td>
                                  </tr>
                                );
                              }
                            }
                            return [summaryTr, expenseTr, linkedTr].filter(Boolean) as JSX.Element[];
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              );
            })}
                </div>
              );
            })
          )}
          {/* Filtered totals strip — at the foot of the panel so the admin sees
              the total amount of whatever the filter rail above has chosen. */}
          {adminFilteredExpenses.length > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '14px',
                marginTop: '10px',
                padding: '14px 18px',
                borderRadius: '10px',
                backgroundColor: 'color-mix(in srgb, var(--primary-color) 5%, var(--bg-secondary))',
                border: '1px solid color-mix(in srgb, var(--primary-color) 22%, var(--border-color))',
              }}
            >
              <span
                style={{
                  fontSize: '10px',
                  fontWeight: 800,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: 'var(--text-secondary)',
                }}
              >
                Filtered totals · {adminFilteredTotals.count} {adminFilteredTotals.count === 1 ? 'item' : 'items'}
              </span>
              {Object.keys(adminFilteredTotals.byType).length > 1 && (
                <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '14px', fontSize: '11px', color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                  {Object.entries(adminFilteredTotals.byType)
                    .sort((a, b) => b[1].amount - a[1].amount)
                    .map(([t, v]) => (
                      <span key={t} style={{ whiteSpace: 'nowrap' }}>
                        <strong style={{ color: 'var(--text-secondary)' }}>{t}</strong> ${v.amount.toFixed(2)} ({v.count})
                      </span>
                    ))}
                </span>
              )}
              <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '14px', fontSize: '13px', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                {adminFilteredTotals.gst > 0 && (
                  <span>GST <strong style={{ fontFamily: 'SF Mono, monospace', color: 'var(--text-primary)' }}>${adminFilteredTotals.gst.toFixed(2)}</strong></span>
                )}
                <span style={{ fontSize: '16px' }}>
                  Total <strong style={{ fontFamily: 'SF Mono, monospace', color: 'var(--primary-color)', fontWeight: 800 }}>${adminFilteredTotals.amount.toFixed(2)}</strong>
                </span>
              </span>
            </div>
          )}
        </div>
      )}

      {/* Auto-reimbursed tab content (view-only — no buttons, no edits). */}
      {activeExpensesTab === 'auto' && (
        <div>
          <div style={{ marginBottom: '8px' }}>
            <h2 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
              Auto-reimbursed
            </h2>
            <p style={{ margin: '6px 0 0', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5, maxWidth: '720px' }}>
              {isAdmin
                ? 'These items don\'t require a receipt, but each one still needs to be explicitly marked accounted for so the books stay in sync with what\'s actually been paid out.'
                : 'These items don\'t require a receipt. They appear on your payroll once the admin marks them accounted for.'}
            </p>
          </div>

          {isAdmin && autoEmployeeOptions.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '12px 0' }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Employee</label>
              <select
                value={autoEmployeeFilter}
                onChange={(e) => setAutoEmployeeFilter(e.target.value)}
                style={{ padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '13px' }}
              >
                <option value="all">All employees</option>
                {autoEmployeeOptions.map((emp) => (
                  <option key={emp.id} value={emp.id}>{emp.name}</option>
                ))}
              </select>
            </div>
          )}

          {autoReimbursedRows.length === 0 ? (
            <div style={{
              padding: '24px',
              borderRadius: '10px',
              border: '1px dashed var(--border-color)',
              backgroundColor: 'var(--bg-tertiary)',
              color: 'var(--text-tertiary)',
              fontSize: '14px',
              textAlign: 'center',
              marginTop: '12px',
            }}>
              No auto-reimbursed items in this period.
            </div>
          ) : (
            <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {autoReimbursedGroupedByUser.map((userGroup) => {
                const userCollapsed = collapsedAutoUserKeys.has(userGroup.userId);
                return (
                <div
                  key={`auto-user-${userGroup.userId}`}
                  className="ionex-customer-section"
                >
                  <button
                    type="button"
                    className="ionex-customer-section-toggle"
                    onClick={() => toggleAutoUserGroup(userGroup.userId)}
                    aria-expanded={!userCollapsed}
                  >
                    <span aria-hidden className={`ionex-customer-section-chevron${userCollapsed ? ' is-collapsed' : ''}`}>▾</span>
                    <span className="ionex-customer-section-name">
                      {userGroup.userName}
                      {userGroup.unaccountedCount > 0 && (
                        <span
                          title={`${userGroup.unaccountedCount} unaccounted line${userGroup.unaccountedCount === 1 ? '' : 's'} across all periods`}
                          style={{
                            marginLeft: '10px',
                            padding: '2px 9px',
                            fontSize: '11px',
                            fontWeight: 700,
                            borderRadius: '999px',
                            backgroundColor: 'rgba(245, 158, 11, 0.16)',
                            color: '#92400e',
                            letterSpacing: '0.04em',
                            textTransform: 'uppercase',
                            verticalAlign: 'middle',
                          }}
                        >
                          {userGroup.unaccountedCount} unaccounted
                        </span>
                      )}
                    </span>
                    <span
                      className="ionex-customer-section-meta"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '5px' }}>
                        <strong style={{ color: 'var(--text-primary)', fontFamily: 'SF Mono, monospace', fontSize: '13px', fontVariantNumeric: 'tabular-nums' }}>
                          {userGroup.periods.length}
                        </strong>
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                          {userGroup.periods.length === 1 ? 'period' : 'periods'}
                        </span>
                      </span>
                      <span aria-hidden style={{ color: 'var(--text-tertiary)', opacity: 0.5 }}>·</span>
                      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '5px' }}>
                        <strong style={{ color: 'var(--text-primary)', fontFamily: 'SF Mono, monospace', fontSize: '13px', fontVariantNumeric: 'tabular-nums' }}>
                          {userGroup.totals.count}
                        </strong>
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                          {userGroup.totals.count === 1 ? 'item' : 'items'}
                        </span>
                      </span>
                      <span aria-hidden style={{ color: 'var(--text-tertiary)', opacity: 0.5 }}>·</span>
                      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '6px' }}>
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                          Total
                        </span>
                        <strong style={{ color: 'var(--primary-color)', fontFamily: 'SF Mono, monospace', fontSize: '15px', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                          ${userGroup.totals.total.toFixed(2)}
                        </strong>
                      </span>
                    </span>
                  </button>
                  {!userCollapsed && (
                  <div style={{ backgroundColor: 'var(--bg-primary)', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border-color)', margin: '10px 0 0' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ backgroundColor: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', textAlign: 'left', color: 'var(--text-secondary)', fontSize: '11px', textTransform: 'uppercase' }}>
                    <th style={{ padding: '12px 16px' }}>Date</th>
                    <th style={{ padding: '12px 16px' }}>Ticket</th>
                    <th style={{ padding: '12px 16px' }}>Category</th>
                    <th style={{ padding: '12px 16px', textAlign: 'right' }}>Qty</th>
                    <th style={{ padding: '12px 16px', textAlign: 'right' }}>Rate</th>
                    <th style={{ padding: '12px 16px', textAlign: 'right' }}>Total</th>
                    <th style={{ padding: '12px 16px', textAlign: 'center' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {userGroup.periods.map((period) => {
                    const compositeAutoKey = `${userGroup.userId}|${period.periodKey}`;
                    const periodCollapsed = collapsedAutoExpensePeriodKeys.has(compositeAutoKey);
                    // Employee column removed inside user cards — the card header carries the
                    // employee name, so each row is one column narrower than the original layout.
                    const colCount = 7;
                    return (
                      <Fragment key={`auto-period-${userGroup.userId}-${period.periodKey}`}>
                        <tr style={{ backgroundColor: 'rgba(20, 184, 166, 0.10)', borderBottom: '2px solid rgba(20, 184, 166, 0.45)' }}>
                          <td colSpan={colCount} style={{ padding: 0 }}>
                            <button
                              type="button"
                              onClick={() => toggleAutoExpensePeriodGroup(compositeAutoKey)}
                              aria-expanded={!periodCollapsed}
                              style={{
                                width: '100%', display: 'flex', alignItems: 'center', gap: '12px',
                                padding: '12px 16px', border: 'none', background: 'transparent',
                                cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                              }}
                            >
                              <span style={{ fontSize: '12px', color: 'var(--text-secondary)', width: '14px', flexShrink: 0 }} aria-hidden>
                                {periodCollapsed ? '▶' : '▼'}
                              </span>
                              <span style={{ fontSize: '10px', fontWeight: 700, color: '#0f766e', textTransform: 'uppercase', letterSpacing: '0.06em', flexShrink: 0 }}>
                                Pay Period
                              </span>
                              <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>
                                {period.periodLabel}
                              </span>
                              {period.isCurrent && (
                                <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px', backgroundColor: 'rgba(34, 197, 94, 0.18)', color: '#15803d', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Current</span>
                              )}
                              {period.isFuture && (
                                <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Upcoming</span>
                              )}
                              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'baseline', gap: '16px', fontSize: '12px', color: 'var(--text-secondary)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                <span><strong style={{ color: 'var(--text-primary)' }}>{period.totals.count}</strong> {period.totals.count === 1 ? 'item' : 'items'}</span>
                                <span>Total <strong style={{ fontFamily: 'monospace', color: '#0f766e' }}>${period.totals.total.toFixed(2)}</strong></span>
                              </span>
                            </button>
                          </td>
                        </tr>
                        {!periodCollapsed && period.dateGroups.map(({ dateKey, items }) => (
                          <Fragment key={`auto-date-${period.periodKey}-${dateKey}`}>
                            <tr style={{ backgroundColor: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)' }}>
                              <td colSpan={colCount} style={{ padding: '8px 16px 8px 32px', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                                {formatExpenseGroupDateLabel(dateKey)}
                                <span style={{ marginLeft: '8px', fontSize: '12px', fontWeight: 500, color: 'var(--text-tertiary)' }}>
                                  ({items.length} {items.length === 1 ? 'item' : 'items'})
                                </span>
                              </td>
                            </tr>
                            {items.map((row: any) => {
                              const tn = row.service_tickets?.ticket_number || '—';
                              const hasTicketNumber = !!row.service_tickets?.ticket_number;
                              const qty = Number(row.quantity) || 0;
                              const rate = Number(row.rate) || 0;
                              const total = qty * rate;
                              const status = String(row.reimbursement_status || 'pending');
                              const isPaid = status === 'paid';
                              const category = expenseTypeOf(row);
                              const u = row.service_tickets?.user;
                              const empName = u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email || 'Unknown' : 'Unknown';
                              return (
                                <tr key={`auto-row-${row.id}`} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                  <td style={{ padding: '10px 16px', color: 'var(--text-secondary)' }}>{row._date || '—'}</td>
                                  <td style={{ padding: '10px 16px', fontFamily: hasTicketNumber ? 'monospace' : 'inherit' }}>
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
                                  <td style={{ padding: '10px 16px', color: 'var(--text-primary)', fontWeight: 600 }}>
                                    {category}
                                    {row.description ? (
                                      <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-tertiary)', fontWeight: 400, marginTop: '2px' }}>
                                        {row.description}
                                      </span>
                                    ) : null}
                                  </td>
                                  <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'monospace' }}>
                                    {qty}{row.unit ? ` ${row.unit}` : ''}
                                  </td>
                                  <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'monospace' }}>
                                    ${rate.toFixed(2)}
                                  </td>
                                  <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>
                                    ${total.toFixed(2)}
                                  </td>
                                  <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                                    {isPaid ? (
                                      <span style={{
                                        display: 'inline-block',
                                        padding: '2px 10px',
                                        borderRadius: '999px',
                                        fontSize: '11px',
                                        fontWeight: 700,
                                        letterSpacing: '0.04em',
                                        textTransform: 'uppercase',
                                        backgroundColor: 'rgba(34, 197, 94, 0.15)',
                                        color: '#15803d',
                                      }}>
                                        ✓ Accounted
                                      </span>
                                    ) : isAdmin ? (
                                      // Admin-only inline action — auto-reimbursed lines no longer
                                      // auto-drop out of payroll. Admin must explicitly account for
                                      // each so the books stay in sync with what's actually been paid.
                                      <button
                                        type="button"
                                        disabled={batchActionBusy}
                                        onClick={async () => {
                                          const proceed = window.confirm(
                                            `Mark this ${category.toLowerCase()} line as accounted ($${total.toFixed(2)} for ${empName})?\n\n` +
                                            'It will drop out of future Payroll views and be stamped accounted in the system.'
                                          );
                                          if (!proceed) return;
                                          try {
                                            await serviceTicketExpensesService.updateReimbursementStatus(String(row.id), 'paid');
                                            queryClient.invalidateQueries({ queryKey: ['ticketReimbExpenses'] });
                                            queryClient.invalidateQueries({ queryKey: ['payrollTicketExpenses'] });
                                            queryClient.invalidateQueries({ queryKey: ['payrollCatchUpTicketExpenses'] });
                                          } catch (err: any) {
                                            alert('Failed to mark as accounted: ' + (err?.message || 'Unknown error'));
                                          }
                                        }}
                                        title={`Mark this line as accounted ($${total.toFixed(2)}).`}
                                        style={{
                                          padding: '3px 10px',
                                          borderRadius: '999px',
                                          border: '1px solid rgba(21, 128, 61, 0.4)',
                                          backgroundColor: 'rgba(34, 197, 94, 0.10)',
                                          color: '#15803d',
                                          fontSize: '11px',
                                          fontWeight: 700,
                                          letterSpacing: '0.04em',
                                          textTransform: 'uppercase',
                                          cursor: batchActionBusy ? 'not-allowed' : 'pointer',
                                          fontFamily: 'inherit',
                                          opacity: batchActionBusy ? 0.5 : 1,
                                        }}
                                      >
                                        Account for
                                      </button>
                                    ) : (
                                      <span style={{
                                        display: 'inline-block',
                                        padding: '2px 10px',
                                        borderRadius: '999px',
                                        fontSize: '11px',
                                        fontWeight: 700,
                                        letterSpacing: '0.04em',
                                        textTransform: 'uppercase',
                                        backgroundColor: 'rgba(245, 158, 11, 0.15)',
                                        color: '#92400e',
                                      }}>
                                        Needs accounting
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </Fragment>
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              </div>
              )}
            </div>
              );
              })}
            </div>
          )}
        </div>
      )}

      {/* Contractors tab content (admin only — view-only). Same table shape as
          auto-reimbursed, but spans every expense type since contractors invoice
          the company and don't run through payroll. */}
      {activeExpensesTab === 'contractors' && isAdmin && (
        <div>
          <div style={{ marginBottom: '8px' }}>
            <h2 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
              Contractor expenses
            </h2>
            <p style={{ margin: '6px 0 0', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5, maxWidth: '720px' }}>
              All ticket-expense lines submitted by contractors. Contractors invoice the company directly, so these items
              are not reimbursed through payroll — this tab is for tracking and reconciliation against their invoices.
            </p>
          </div>

          {contractorEmployeeOptions.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '12px 0' }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Contractor</label>
              <select
                value={contractorEmployeeFilter}
                onChange={(e) => setContractorEmployeeFilter(e.target.value)}
                style={{ padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '13px' }}
              >
                <option value="all">All contractors</option>
                {contractorEmployeeOptions.map((emp) => (
                  <option key={emp.id} value={emp.id}>{emp.name}</option>
                ))}
              </select>
            </div>
          )}

          {contractorTicketExpenseRows.length === 0 ? (
            <div style={{
              padding: '24px',
              borderRadius: '10px',
              border: '1px dashed var(--border-color)',
              backgroundColor: 'var(--bg-tertiary)',
              color: 'var(--text-tertiary)',
              fontSize: '14px',
              textAlign: 'center',
              marginTop: '12px',
            }}>
              No contractor expense lines in this period.
            </div>
          ) : (
            <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {contractorRowsGroupedByUser.map((userGroup) => {
                const userCollapsed = collapsedContractorUserKeys.has(userGroup.userId);
                return (
                <div
                  key={`contractor-user-${userGroup.userId}`}
                  className="ionex-customer-section"
                >
                  <button
                    type="button"
                    className="ionex-customer-section-toggle"
                    onClick={() => toggleContractorUserGroup(userGroup.userId)}
                    aria-expanded={!userCollapsed}
                  >
                    <span aria-hidden className={`ionex-customer-section-chevron${userCollapsed ? ' is-collapsed' : ''}`}>▾</span>
                    <span className="ionex-customer-section-name">
                      {userGroup.userName}
                      {userGroup.unaccountedCount > 0 && (
                        <span
                          title={`${userGroup.unaccountedCount} unaccounted line${userGroup.unaccountedCount === 1 ? '' : 's'} across all periods`}
                          style={{
                            marginLeft: '10px',
                            padding: '2px 9px',
                            fontSize: '11px',
                            fontWeight: 700,
                            borderRadius: '999px',
                            backgroundColor: 'rgba(245, 158, 11, 0.16)',
                            color: '#92400e',
                            letterSpacing: '0.04em',
                            textTransform: 'uppercase',
                            verticalAlign: 'middle',
                          }}
                        >
                          {userGroup.unaccountedCount} unaccounted
                        </span>
                      )}
                    </span>
                    <span
                      className="ionex-customer-section-meta"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '5px' }}>
                        <strong style={{ color: 'var(--text-primary)', fontFamily: 'SF Mono, monospace', fontSize: '13px', fontVariantNumeric: 'tabular-nums' }}>
                          {userGroup.periods.length}
                        </strong>
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                          {userGroup.periods.length === 1 ? 'period' : 'periods'}
                        </span>
                      </span>
                      <span aria-hidden style={{ color: 'var(--text-tertiary)', opacity: 0.5 }}>·</span>
                      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '5px' }}>
                        <strong style={{ color: 'var(--text-primary)', fontFamily: 'SF Mono, monospace', fontSize: '13px', fontVariantNumeric: 'tabular-nums' }}>
                          {userGroup.totals.count}
                        </strong>
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                          {userGroup.totals.count === 1 ? 'item' : 'items'}
                        </span>
                      </span>
                      <span aria-hidden style={{ color: 'var(--text-tertiary)', opacity: 0.5 }}>·</span>
                      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '6px' }}>
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                          Total
                        </span>
                        <strong style={{ color: 'var(--primary-color)', fontFamily: 'SF Mono, monospace', fontSize: '15px', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                          ${userGroup.totals.total.toFixed(2)}
                        </strong>
                      </span>
                    </span>
                  </button>
                  {!userCollapsed && (
                  <div style={{ backgroundColor: 'var(--bg-primary)', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border-color)', margin: '10px 0 0' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ backgroundColor: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', textAlign: 'left', color: 'var(--text-secondary)', fontSize: '11px', textTransform: 'uppercase' }}>
                    <th style={{ padding: '12px 16px' }}>Date</th>
                    <th style={{ padding: '12px 16px' }}>Ticket</th>
                    <th style={{ padding: '12px 16px' }}>Category</th>
                    <th style={{ padding: '12px 16px', textAlign: 'right' }}>Qty</th>
                    <th style={{ padding: '12px 16px', textAlign: 'right' }}>Rate</th>
                    <th style={{ padding: '12px 16px', textAlign: 'right' }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {userGroup.periods.map((period) => {
                    const compositeContractorKey = `${userGroup.userId}|${period.periodKey}`;
                    const periodCollapsed = collapsedContractorPeriodKeys.has(compositeContractorKey);
                    // Contractor column removed inside user cards — header already names the contractor.
                    const colCount = 6;
                    return (
                      <Fragment key={`contractor-period-${userGroup.userId}-${period.periodKey}`}>
                        <tr style={{ backgroundColor: 'rgba(99, 102, 241, 0.10)', borderBottom: '2px solid rgba(99, 102, 241, 0.45)' }}>
                          <td colSpan={colCount} style={{ padding: 0 }}>
                            <button
                              type="button"
                              onClick={() => toggleContractorPeriodGroup(compositeContractorKey)}
                              aria-expanded={!periodCollapsed}
                              style={{
                                width: '100%', display: 'flex', alignItems: 'center', gap: '12px',
                                padding: '12px 16px', border: 'none', background: 'transparent',
                                cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                              }}
                            >
                              <span style={{ fontSize: '12px', color: 'var(--text-secondary)', width: '14px', flexShrink: 0 }} aria-hidden>
                                {periodCollapsed ? '▶' : '▼'}
                              </span>
                              <span style={{ fontSize: '10px', fontWeight: 700, color: '#4338ca', textTransform: 'uppercase', letterSpacing: '0.06em', flexShrink: 0 }}>
                                Pay Period
                              </span>
                              <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>
                                {period.periodLabel}
                              </span>
                              {period.isCurrent && (
                                <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px', backgroundColor: 'rgba(34, 197, 94, 0.18)', color: '#15803d', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Current</span>
                              )}
                              {period.isFuture && (
                                <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Upcoming</span>
                              )}
                              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'baseline', gap: '16px', fontSize: '12px', color: 'var(--text-secondary)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                <span><strong style={{ color: 'var(--text-primary)' }}>{period.totals.count}</strong> {period.totals.count === 1 ? 'item' : 'items'}</span>
                                <span>Total <strong style={{ fontFamily: 'monospace', color: '#4338ca' }}>${period.totals.total.toFixed(2)}</strong></span>
                              </span>
                            </button>
                          </td>
                        </tr>
                        {!periodCollapsed && period.dateGroups.map(({ dateKey, items }) => (
                          <Fragment key={`contractor-date-${period.periodKey}-${dateKey}`}>
                            <tr style={{ backgroundColor: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)' }}>
                              <td colSpan={colCount} style={{ padding: '8px 16px 8px 32px', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                                {formatExpenseGroupDateLabel(dateKey)}
                                <span style={{ marginLeft: '8px', fontSize: '12px', fontWeight: 500, color: 'var(--text-tertiary)' }}>
                                  ({items.length} {items.length === 1 ? 'item' : 'items'})
                                </span>
                              </td>
                            </tr>
                            {items.map((row: any) => {
                              const tn = row.service_tickets?.ticket_number || '—';
                              const hasTicketNumber = !!row.service_tickets?.ticket_number;
                              const qty = Number(row.quantity) || 0;
                              const rate = Number(row.rate) || 0;
                              const actual = Number(row.actual_cost) || 0;
                              const total = actual > 0 ? actual : qty * rate;
                              const category = expenseTypeOf(row);
                              const u = row.service_tickets?.user;
                              const empName = u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email || 'Unknown' : 'Unknown';
                              return (
                                <tr key={`contractor-row-${row.id}`} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                  <td style={{ padding: '10px 16px', color: 'var(--text-secondary)' }}>{row._date || '—'}</td>
                                  <td style={{ padding: '10px 16px', fontFamily: hasTicketNumber ? 'monospace' : 'inherit' }}>
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
                                  <td style={{ padding: '10px 16px', color: 'var(--text-primary)', fontWeight: 600 }}>
                                    {category}
                                    {row.description ? (
                                      <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-tertiary)', fontWeight: 400, marginTop: '2px' }}>
                                        {row.description}
                                      </span>
                                    ) : null}
                                  </td>
                                  <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'monospace' }}>
                                    {qty}{row.unit ? ` ${row.unit}` : ''}
                                  </td>
                                  <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'monospace' }}>
                                    ${rate.toFixed(2)}
                                  </td>
                                  <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>
                                    ${total.toFixed(2)}
                                  </td>
                                </tr>
                              );
                            })}
                          </Fragment>
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              </div>
              )}
            </div>
              );
              })}
            </div>
          )}
        </div>
      )}

      {/* Reconcile tab (admin only). Streamlined data-entry view: pay-period accordions
          stacking every unaccounted expense system-wide so the admin can work through
          one period at a time when entering into the books. Each row has Account For;
          checkboxes drive a bulk Mark-N-accounted action so several lines flip at once
          after a batch entry. */}
      {activeExpensesTab === 'reconcile' && isAdmin && (() => {
        // Export every pay period's unaccounted lines into one workbook, one sheet per
        // period. Headers shaded + bold, column widths auto-fit, Amount/GST formatted as
        // currency so the file is a drop-in checklist for whoever's entering into QB.
        const onExportReconcile = async () => {
          if (reconcileGroupedByPayPeriod.length === 0) return;
          const workbook = new ExcelJS.Workbook();
          workbook.creator = 'IONEX Time Tracking';
          workbook.created = new Date();
          const currencyFmt = '"$"#,##0.00';
          const sanitizeSheetName = (s: string) => s.replace(/[\\/?*:[\]]/g, ' ').slice(0, 31) || 'Period';
          for (const period of reconcileGroupedByPayPeriod) {
            const sheet = workbook.addWorksheet(sanitizeSheetName(period.periodLabel || period.periodKey));
            sheet.columns = [
              { header: 'Date', key: 'date' },
              { header: 'Employee', key: 'employee' },
              { header: 'Project', key: 'project' },
              { header: 'Customer', key: 'customer' },
              { header: 'Category', key: 'category' },
              { header: 'Description', key: 'description' },
              { header: 'Ticket', key: 'ticket' },
              { header: 'Source', key: 'source' },
              { header: 'Amount', key: 'amount' },
              { header: 'GST', key: 'gst' },
              { header: 'Total', key: 'total' },
            ];
            const headerRow = sheet.getRow(1);
            headerRow.font = { bold: true };
            headerRow.eachCell((cell) => {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
            });
            const widthSamples: number[] = sheet.columns!.map((c) => String(c.header || '').length);
            const flat = period.dateGroups.flatMap((g) => g.items);
            for (const exp of flat as any[]) {
              const projRaw = exp.service_ticket?.project || exp.service_tickets?.project;
              const project = projRaw ? [projRaw.project_number, projRaw.name].filter(Boolean).join(' – ') : '';
              const customer = projRaw?.customer?.name || '';
              const amount = Number(exp._amount) || 0;
              const gst = exp._source === 'receipt' ? (parseFloat(String(exp.gst || 0)) || 0) : 0;
              const row = sheet.addRow({
                date: exp._date || '',
                employee: exp._employeeName || '',
                project,
                customer,
                category: expenseTypeOf(exp),
                description: exp.description || '',
                ticket: exp.service_tickets?.ticket_number || exp._ticketNumber || '',
                source: exp._source === 'receipt' ? 'Receipt' : 'Ticket line',
                amount,
                gst,
                total: amount + gst,
              });
              row.getCell('amount').numFmt = currencyFmt;
              row.getCell('gst').numFmt = currencyFmt;
              row.getCell('total').numFmt = currencyFmt;
              // Update width-tracking using formatted strings — numbers render wider when
              // shown as currency, so use the formatted form for sizing.
              const cellLens = [
                String(exp._date || ''),
                String(exp._employeeName || ''),
                project,
                customer,
                expenseTypeOf(exp),
                String(exp.description || ''),
                String(exp.service_tickets?.ticket_number || exp._ticketNumber || ''),
                exp._source === 'receipt' ? 'Receipt' : 'Ticket line',
                `$${amount.toFixed(2)}`,
                `$${gst.toFixed(2)}`,
                `$${(amount + gst).toFixed(2)}`,
              ];
              for (let i = 0; i < cellLens.length; i++) {
                if (cellLens[i].length > widthSamples[i]) widthSamples[i] = cellLens[i].length;
              }
            }
            // Total row at the bottom: count + sum of Amount + sum of GST + sum of Total.
            const totals = (flat as any[]).reduce(
              (acc, e) => {
                const amt = Number(e._amount) || 0;
                const gst = e._source === 'receipt' ? (parseFloat(String(e.gst || 0)) || 0) : 0;
                acc.amount += amt;
                acc.gst += gst;
                acc.total += amt + gst;
                return acc;
              },
              { amount: 0, gst: 0, total: 0 }
            );
            const totalRow = sheet.addRow({
              date: '',
              employee: '',
              project: '',
              customer: '',
              category: '',
              description: `Total — ${flat.length} ${flat.length === 1 ? 'line' : 'lines'}`,
              ticket: '',
              source: '',
              amount: totals.amount,
              gst: totals.gst,
              total: totals.total,
            });
            totalRow.font = { bold: true };
            totalRow.getCell('amount').numFmt = currencyFmt;
            totalRow.getCell('gst').numFmt = currencyFmt;
            totalRow.getCell('total').numFmt = currencyFmt;
            totalRow.eachCell({ includeEmpty: false }, (cell) => {
              cell.border = { top: { style: 'thin', color: { argb: 'FFCCCCCC' } } };
            });
            // Auto-fit with min/max guardrails so a single long description doesn't blow
            // the column out and short columns still read cleanly.
            const MIN_WIDTH = 10;
            const MAX_WIDTH = 60;
            const PADDING = 2;
            for (let i = 0; i < widthSamples.length; i++) {
              const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, widthSamples[i] + PADDING));
              sheet.getColumn(i + 1).width = w;
            }
          }
          const buf = await workbook.xlsx.writeBuffer();
          const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
          const stamp = new Date().toISOString().slice(0, 10);
          saveAs(blob, `expense-reconcile_${stamp}.xlsx`);
        };
        return (
        <div>
          <div style={{ marginBottom: '14px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' }}>
            <div>
              <h2 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                Reconcile
              </h2>
              <p style={{ margin: '6px 0 0', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5, maxWidth: '760px' }}>
                Every unaccounted expense across the company, grouped by pay period. Work through one
                period at a time, enter the lines into the books, then mark them accounted so nothing slips
                through. Select multiple rows for a bulk mark.
              </p>
            </div>
            <button
              type="button"
              onClick={onExportReconcile}
              disabled={reconcileGroupedByPayPeriod.length === 0}
              title="Download an Excel workbook with one sheet per pay period — drop-in checklist for entering into the books."
              className="payroll-action-btn"
              style={{
                padding: '8px 14px',
                borderRadius: '6px',
                border: '1px solid var(--border-color)',
                backgroundColor: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                fontFamily: 'inherit',
                fontWeight: 600,
                fontSize: '13px',
                cursor: reconcileGroupedByPayPeriod.length === 0 ? 'not-allowed' : 'pointer',
                opacity: reconcileGroupedByPayPeriod.length === 0 ? 0.55 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              <span aria-hidden>⬇</span> Export to Excel
            </button>
          </div>

          {reconcileGroupedByPayPeriod.length === 0 ? (
            <div className="ionex-empty">
              <div className="title">All caught up</div>
              <div className="body">Every expense has been marked accounted for. Nothing left to reconcile.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {reconcileGroupedByPayPeriod.map((period) => {
                const periodCollapsed = collapsedReconcilePeriodKeys.has(period.periodKey);
                const flatItems: any[] = period.dateGroups.flatMap((g) => g.items);
                const itemKeys = flatItems.map((e: any) => `${e._source}-${e.id}`);
                const allSelected = itemKeys.length > 0 && itemKeys.every((k) => selectedReconcileKeys.has(k));
                const anySelected = itemKeys.some((k) => selectedReconcileKeys.has(k));
                const selectedRows = flatItems.filter((e: any) => selectedReconcileKeys.has(`${e._source}-${e.id}`));
                const selectedTotal = selectedRows.reduce((s, r: any) => s + (Number(r._amount) || 0), 0);
                const toggleAllInPeriod = (checked: boolean) => {
                  setSelectedReconcileKeys((prev) => {
                    const next = new Set(prev);
                    if (checked) for (const k of itemKeys) next.add(k);
                    else for (const k of itemKeys) next.delete(k);
                    return next;
                  });
                };
                const onBulkAccount = async () => {
                  if (selectedRows.length === 0) return;
                  const proceed = window.confirm(
                    `Mark ${selectedRows.length} expense${selectedRows.length === 1 ? '' : 's'} as accounted for ($${selectedTotal.toFixed(2)})?\n\n` +
                    'They drop out of the workflow once they\'re stamped accounted in the system.'
                  );
                  if (!proceed) return;
                  await handleAdminBatchStatusChange(
                    selectedRows.map((r: any) => ({ id: String(r.id), source: r._source as 'receipt' | 'ticket' })),
                    'paid'
                  );
                  setSelectedReconcileKeys((prev) => {
                    const next = new Set(prev);
                    for (const r of selectedRows) next.delete(`${r._source}-${r.id}`);
                    return next;
                  });
                };
                // Account-for-all for a project or category title row: confirm, mark the
                // whole group accounted in one batch, then clear any of its selections.
                const accountForGroup = async (items: any[], label: string) => {
                  if (items.length === 0) return;
                  const total = items.reduce((s, r: any) => s + (Number(r._amount) || 0), 0);
                  const proceed = window.confirm(
                    `Mark ${items.length} expense${items.length === 1 ? '' : 's'} in ${label} as accounted for ($${total.toFixed(2)})?\n\n` +
                    'They drop out of the workflow once they\'re stamped accounted in the system.'
                  );
                  if (!proceed) return;
                  await handleAdminBatchStatusChange(
                    items.map((r: any) => ({ id: String(r.id), source: r._source as 'receipt' | 'ticket' })),
                    'paid'
                  );
                  setSelectedReconcileKeys((prev) => {
                    const next = new Set(prev);
                    for (const r of items) next.delete(`${r._source}-${r.id}`);
                    return next;
                  });
                };
                const periodModifier = period.isCurrent ? '' : period.isFuture ? ' is-future' : '';
                return (
                  <div
                    key={`reconcile-period-${period.periodKey}`}
                    className={`ionex-period-card${periodCollapsed ? ' is-collapsed' : ''}${periodModifier}`}
                  >
                    <button
                      type="button"
                      className="ionex-period-card-header"
                      onClick={() => toggleReconcilePeriodGroup(period.periodKey)}
                      aria-expanded={!periodCollapsed}
                    >
                      <span className="ionex-period-card-chevron" style={{ transform: periodCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }} aria-hidden>▶</span>
                      <span className="ionex-period-card-eyebrow">Pay period</span>
                      <span className="ionex-period-card-title">{period.periodLabel}</span>
                      {period.isCurrent && <span className="ionex-status-pill is-period-current">Current</span>}
                      {period.isFuture && <span className="ionex-status-pill is-period-future">Upcoming</span>}
                      <span className="ionex-period-card-meta">
                        <span><strong>{period.totals.count}</strong> {period.totals.count === 1 ? 'line' : 'lines'} to enter</span>
                        <span>Total <strong className="is-grand">${period.totals.total.toFixed(2)}</strong></span>
                      </span>
                    </button>
                    {!periodCollapsed && (
                      <div className="ionex-period-card-body">
                        {selectedRows.length > 0 && (
                          <div
                            role="region"
                            aria-label="Bulk Account For"
                            style={{
                              display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
                              padding: '10px 14px', marginBottom: '10px',
                              backgroundColor: 'rgba(34, 197, 94, 0.08)',
                              border: '1px solid rgba(21, 128, 61, 0.3)',
                              borderRadius: '8px',
                            }}
                          >
                            <span style={{ fontSize: '12px', fontWeight: 700, color: '#15803d' }}>
                              {selectedRows.length} selected · ${selectedTotal.toFixed(2)}
                            </span>
                            <button
                              type="button"
                              onClick={onBulkAccount}
                              disabled={batchActionBusy}
                              className="ionex-row-action-icon is-success"
                              style={{ marginLeft: 'auto' }}
                            >
                              Mark {selectedRows.length} accounted
                            </button>
                          </div>
                        )}
                        {(() => {
                          // Reconcile entry is project-driven: bookkeepers post one project's
                          // expenses at a time, and within a project they batch by category
                          // (all mileage, then all per diem, …). So nest the period's lines as
                          // project → category, each carrying its own subtotal, instead of one
                          // flat date-sorted list. Projectless lines sink to a trailing "—" group.
                          const projectLabelOf = (exp: any): string => {
                            const projRaw = exp.service_ticket?.project || exp.service_tickets?.project;
                            return projRaw ? [projRaw.project_number, projRaw.name].filter(Boolean).join(' – ') : '—';
                          };
                          const projMap = new Map<string, any[]>();
                          for (const exp of flatItems) {
                            const k = projectLabelOf(exp);
                            if (!projMap.has(k)) projMap.set(k, []);
                            projMap.get(k)!.push(exp);
                          }
                          const projectGroups = [...projMap.entries()]
                            .map(([projectLabel, items]) => {
                              const catMap = new Map<string, any[]>();
                              for (const exp of items) {
                                const c = expenseTypeOf(exp);
                                if (!catMap.has(c)) catMap.set(c, []);
                                catMap.get(c)!.push(exp);
                              }
                              const categories = [...catMap.entries()]
                                .map(([category, catItems]) => ({
                                  category,
                                  items: catItems,
                                  total: catItems.reduce((s, e: any) => s + (Number(e._amount) || 0), 0),
                                }))
                                .sort((a, b) => a.category.localeCompare(b.category));
                              return {
                                projectLabel,
                                items,
                                count: items.length,
                                total: items.reduce((s, e: any) => s + (Number(e._amount) || 0), 0),
                                categories,
                              };
                            })
                            .sort((a, b) => {
                              if (a.projectLabel === '—') return 1;
                              if (b.projectLabel === '—') return -1;
                              return a.projectLabel.localeCompare(b.projectLabel);
                            });
                          return (
                            <div style={{ overflowX: 'auto' }}>
                              <table className="ionex-expense-table" style={{ minWidth: '760px' }}>
                                <thead>
                                  <tr>
                                    <th className="is-checkbox">
                                      <input
                                        type="checkbox"
                                        checked={allSelected}
                                        ref={(el) => { if (el) el.indeterminate = !allSelected && anySelected; }}
                                        onChange={(e) => toggleAllInPeriod(e.target.checked)}
                                        title="Select all in this pay period"
                                        style={{ cursor: 'pointer' }}
                                      />
                                    </th>
                                    <th>Date</th>
                                    <th>Employee</th>
                                    <th>Description</th>
                                    <th className="is-numeric">Amount</th>
                                    <th className="is-numeric">Action</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {projectGroups.map((pg) => {
                                    const projKeys = pg.items.map((e: any) => `${e._source}-${e.id}`);
                                    const projAllSelected = projKeys.length > 0 && projKeys.every((k) => selectedReconcileKeys.has(k));
                                    const projAnySelected = projKeys.some((k) => selectedReconcileKeys.has(k));
                                    const toggleProject = (checked: boolean) => {
                                      setSelectedReconcileKeys((prev) => {
                                        const next = new Set(prev);
                                        if (checked) for (const k of projKeys) next.add(k);
                                        else for (const k of projKeys) next.delete(k);
                                        return next;
                                      });
                                    };
                                    const projGroupKey = `${period.periodKey}::${pg.projectLabel}`;
                                    const projCollapsed = collapsedReconcileProjectKeys.has(projGroupKey);
                                    return (
                                      <React.Fragment key={`recproj-${pg.projectLabel}`}>
                                        <tr className="ionex-expense-table-group is-project">
                                          <td style={{ paddingLeft: '18px', width: '32px', backgroundColor: 'var(--bg-tertiary)' }}>
                                            <input
                                              type="checkbox"
                                              checked={projAllSelected}
                                              ref={(el) => { if (el) el.indeterminate = !projAllSelected && projAnySelected; }}
                                              onChange={(e) => toggleProject(e.target.checked)}
                                              title="Select all lines for this project"
                                              style={{ cursor: 'pointer' }}
                                            />
                                          </td>
                                          <td
                                            colSpan={5}
                                            onClick={() => toggleReconcileGroupKey(setCollapsedReconcileProjectKeys, projGroupKey)}
                                            style={{ backgroundColor: 'var(--bg-tertiary)', fontWeight: 700, color: pg.projectLabel === '—' ? 'var(--text-tertiary)' : 'var(--text-primary)', cursor: 'pointer', userSelect: 'none' }}
                                            title={projCollapsed ? 'Expand project' : 'Collapse project'}
                                          >
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0' }}>
                                              <span aria-hidden style={{ display: 'inline-block', width: '12px', marginRight: '6px', fontSize: '10px', color: 'var(--text-tertiary)', transform: projCollapsed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 0.12s' }}>▶</span>
                                              <span style={{ fontStyle: pg.projectLabel === '—' ? 'italic' : 'normal' }}>
                                                {pg.projectLabel === '—' ? 'No project assigned' : pg.projectLabel}
                                              </span>
                                              <span style={{ marginLeft: '10px', fontWeight: 600, fontSize: '12px', color: 'var(--text-secondary)' }}>
                                                {pg.count} {pg.count === 1 ? 'line' : 'lines'} · ${pg.total.toFixed(2)}
                                                {projCollapsed && pg.categories.length > 1 && <> · {pg.categories.length} categories</>}
                                              </span>
                                              <button
                                                type="button"
                                                className="ionex-row-action-icon is-success"
                                                disabled={batchActionBusy}
                                                onClick={(e) => { e.stopPropagation(); accountForGroup(pg.items, pg.projectLabel === '—' ? 'this no-project group' : pg.projectLabel); }}
                                                title={`Mark all ${pg.count} line${pg.count === 1 ? '' : 's'} in this project as accounted for ($${pg.total.toFixed(2)})`}
                                                style={{ marginLeft: 'auto' }}
                                              >
                                                Account for whole project
                                              </button>
                                            </div>
                                          </td>
                                        </tr>
                                        {!projCollapsed && pg.categories.map((cg) => {
                                          const catGroupKey = `${projGroupKey}::${cg.category}`;
                                          const catCollapsed = !expandedReconcileCategoryKeys.has(catGroupKey);
                                          return (
                                          <React.Fragment key={`reccat-${pg.projectLabel}-${cg.category}`}>
                                            <tr className="ionex-expense-table-group is-category">
                                              <td />
                                              <td
                                                colSpan={5}
                                                onClick={() => toggleReconcileGroupKey(setExpandedReconcileCategoryKeys, catGroupKey)}
                                                style={{ paddingLeft: '6px', fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}
                                                title={catCollapsed ? 'Expand category' : 'Collapse category'}
                                              >
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0' }}>
                                                  <span aria-hidden style={{ display: 'inline-block', width: '10px', marginRight: '6px', fontSize: '9px', color: 'var(--text-tertiary)', transform: catCollapsed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 0.12s' }}>▶</span>
                                                  {cg.category}
                                                  <span style={{ marginLeft: '8px', fontWeight: 600, textTransform: 'none', letterSpacing: 0, color: 'var(--text-tertiary)' }}>
                                                    {cg.items.length} · ${cg.total.toFixed(2)}
                                                  </span>
                                                  <button
                                                    type="button"
                                                    className="ionex-row-action-icon is-success"
                                                    disabled={batchActionBusy}
                                                    onClick={(e) => { e.stopPropagation(); accountForGroup(cg.items, `${pg.projectLabel === '—' ? 'No project' : pg.projectLabel} · ${cg.category}`); }}
                                                    title={`Mark all ${cg.items.length} ${cg.category} line${cg.items.length === 1 ? '' : 's'} as accounted for ($${cg.total.toFixed(2)})`}
                                                    style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0 }}
                                                  >
                                                    Account for category
                                                  </button>
                                                </div>
                                              </td>
                                            </tr>
                                            {!catCollapsed && cg.items.map((exp: any) => {
                                              const selKey = `${exp._source}-${exp.id}`;
                                              const isSelected = selectedReconcileKeys.has(selKey);
                                              const isUpdating = updatingExpenseId === exp.id;
                                              const dt = normalizeExpenseTableDateKey(String(exp._date || ''));
                                              return (
                                                <tr key={selKey} className={`ionex-expense-table-row${isSelected ? ' is-selected' : ''}`}>
                                                  <td style={{ paddingLeft: '28px', width: '32px' }}>
                                                    <input
                                                      type="checkbox"
                                                      checked={isSelected}
                                                      onChange={(e) => {
                                                        setSelectedReconcileKeys((prev) => {
                                                          const next = new Set(prev);
                                                          if (e.target.checked) next.add(selKey);
                                                          else next.delete(selKey);
                                                          return next;
                                                        });
                                                      }}
                                                    />
                                                  </td>
                                                  <td style={{ whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                                                    {dt ? formatExpenseGroupDateLabel(dt) : '—'}
                                                  </td>
                                                  <td style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                                                    {exp._employeeName || '—'}
                                                  </td>
                                                  <td style={{ color: 'var(--text-secondary)' }}>
                                                    {exp.description || <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>(no description)</span>}
                                                    {exp._source === 'receipt' && exp.receipt_url && (
                                                      <button
                                                        type="button"
                                                        onClick={(e) => { e.stopPropagation(); handleViewReceipt(exp); }}
                                                        className="ionex-expense-table-link-button"
                                                        style={{ marginLeft: '8px', fontSize: '11px' }}
                                                        title="Preview receipt"
                                                      >
                                                        {loadingReceiptId === exp.id ? '…' : '🧾 View receipt'}
                                                      </button>
                                                    )}
                                                  </td>
                                                  <td className="is-numeric">
                                                    <span className="ionex-expense-table-amount">${(Number(exp._amount) || 0).toFixed(2)}</span>
                                                    {exp._source === 'receipt' && parseFloat(exp.gst || 0) > 0 && (
                                                      <span className="ionex-expense-table-amount-gst">+ GST ${parseFloat(exp.gst || 0).toFixed(2)}</span>
                                                    )}
                                                  </td>
                                                  <td className="is-numeric">
                                                    <button
                                                      type="button"
                                                      className="ionex-row-action-icon is-success"
                                                      disabled={isUpdating || batchActionBusy}
                                                      onClick={() => handleAdminStatusChange(exp.id, 'paid', exp._source as 'receipt' | 'ticket', exp)}
                                                      title="Mark this line as accounted for — entered into the books."
                                                    >
                                                      Account for
                                                    </button>
                                                  </td>
                                                </tr>
                                              );
                                            })}
                                          </React.Fragment>
                                          );
                                        })}
                                      </React.Fragment>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        );
      })()}

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
        }} {...viewingReceiptBackdropClose}>
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
                  Attach this receipt to ticket expenses
                </h2>
                <div style={{ marginTop: '6px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                  <strong style={{ color: 'var(--text-primary)' }}>{receipt.description || 'Receipt'}</strong>
                  {' '}· {receipt._employeeName || ''}
                  {' '}· Receipt total: <strong style={{ color: 'var(--text-primary)' }}>${receiptAmount.toFixed(2)}</strong>
                </div>
                {/* One-to-many call-out so it's unmistakable that every line ticked
                    below receives the SAME receipt — not a separate copy each. */}
                <div
                  style={{
                    marginTop: '12px',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    backgroundColor: 'color-mix(in srgb, var(--primary-color) 8%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--primary-color) 30%, transparent)',
                    fontSize: '12px',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.5,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                  }}
                  aria-live="polite"
                >
                  <span
                    style={{
                      flexShrink: 0,
                      width: '22px',
                      height: '22px',
                      borderRadius: '50%',
                      backgroundColor: 'color-mix(in srgb, var(--primary-color) 14%, var(--bg-primary))',
                      color: 'var(--primary-color)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '13px',
                      fontWeight: 800,
                    }}
                    aria-hidden
                  >
                    1
                  </span>
                  <span style={{ flex: 1 }}>
                    <strong style={{ color: 'var(--text-primary)' }}>One receipt → many tickets.</strong>{' '}
                    {linkReceiptSelectedIds.size === 0 ? (
                      <>Tick any number of lines below. The <em>same</em> receipt will be attached to every line you select — useful for a hotel that covers multiple nights / tickets.</>
                    ) : linkReceiptSelectedIds.size === 1 ? (
                      <>This receipt will be attached to <strong style={{ color: 'var(--primary-color)' }}>1 ticket line</strong>. Select more lines below to attach the same receipt to all of them.</>
                    ) : (
                      <>This receipt will be attached to <strong style={{ color: 'var(--primary-color)' }}>all {linkReceiptSelectedIds.size} selected ticket lines</strong> in one go.</>
                    )}
                  </span>
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
                const diffColor =
                  Math.abs(diff) < 0.005
                    ? 'var(--text-tertiary)'
                    : diff > 0
                      ? 'var(--success-color)'
                      : 'var(--warning-color)';
                return (
                  <div
                    style={{
                      padding: '14px 20px',
                      borderTop: '1px solid var(--border-color)',
                      backgroundColor: 'color-mix(in srgb, var(--primary-color) 4%, var(--bg-secondary))',
                      display: 'grid',
                      gridTemplateColumns: '1fr auto 1fr auto 1fr',
                      alignItems: 'center',
                      gap: '12px',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: '9px', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-tertiary)', letterSpacing: '0.16em' }}>Receipt</div>
                      <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>${receiptAmount.toFixed(2)}</div>
                    </div>
                    <div aria-hidden style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
                      <span style={{ fontSize: '18px', color: 'var(--primary-color)', fontWeight: 700, lineHeight: 1 }}>→</span>
                      <span style={{ fontSize: '9px', color: 'var(--text-tertiary)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>attached to</span>
                    </div>
                    <div>
                      <div style={{ fontSize: '9px', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-tertiary)', letterSpacing: '0.16em' }}>
                        {linkReceiptSelectedIds.size} ticket line{linkReceiptSelectedIds.size === 1 ? '' : 's'} (billed)
                      </div>
                      <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>${selectedBilledTotal.toFixed(2)}</div>
                    </div>
                    <div aria-hidden style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
                      <span style={{ fontSize: '18px', color: 'var(--text-tertiary)', fontWeight: 700, lineHeight: 1 }}>Δ</span>
                    </div>
                    <div>
                      <div style={{ fontSize: '9px', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-tertiary)', letterSpacing: '0.16em' }}>Difference</div>
                      <div style={{ fontSize: '16px', fontWeight: 800, color: diffColor }}>
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
                    ? 'Attaching…'
                    : linkReceiptSelectedIds.size === 0
                      ? 'Select tickets to attach'
                      : linkReceiptSelectedIds.size === 1
                        ? 'Attach this receipt to 1 ticket'
                        : `Attach this receipt to all ${linkReceiptSelectedIds.size} tickets`}
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
