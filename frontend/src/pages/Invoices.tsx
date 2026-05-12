import { useState, useMemo, useEffect, useCallback, Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useAuth, canAccessInvoices } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import {
  serviceTicketsService,
  serviceTicketExpensesService,
  customersService,
  employeesService,
  projectsService,
  invoicedBatchInvoicesService,
  invoicedBatchApprovalsService,
  invoicedBatchMarksService,
  type InvoicedBatchMarkRow,
  invoiceFilenameForDownload,
  invoiceWorkflowsService,
  type InvoiceWorkflowRow,
  type InvoiceWorkflowStatus,
  invoiceStatusHistoryService,
} from '../services/supabaseServices';
import {
  groupEntriesIntoTickets,
  ServiceTicket,
  getInvoiceGroupKey,
  getApproverPoAfeCcFromTicket,
  applyHeaderOverridesToTicket,
  getProjectApproverPoAfe,
  getProjectHeaderFields,
  InvoiceGroupKey,
  calculateTicketTotalAmount,
  buildBillingKey,
  buildGroupingKey,
  getTicketBillingKey,
} from '../utils/serviceTickets';
import { generateAndStorePdf, mergePdfBlobs, generateBatchSummaryPdf } from '../utils/pdfFromHtml';
import { saveAs } from 'file-saver';
import JSZip from 'jszip';
import { quickbooksClientService, isQuickBooksApiLocal } from '../services/quickbooksService';
import PayPeriodCalendar from '../components/PayPeriodCalendar';
import SearchableSelect from '../components/SearchableSelect';
import ServiceTickets from './ServiceTickets';

const STATUS_COLOR_MAP: Record<string, string> = {
  gray: '#6b7280',
  blue: '#3b82f6',
  orange: '#f59e0b',
  green: '#22c55e',
  red: '#ef4444',
  purple: '#8b5cf6',
  teal: '#14b8a6',
};
function statusColorHex(name: string) {
  return STATUS_COLOR_MAP[name] ?? '#6b7280';
}

type PdfExportEntryOverride = {
  description: string;
  st: number;
  tt: number;
  ft: number;
  so: number;
  fo: number;
};

type ApprovedRecord = {
  id: string;
  ticket_number: string;
  date: string;
  user_id: string;
  customer_id: string | null;
  project_id: string | null;
  location: string | null;
  is_edited?: boolean;
  edited_hours?: unknown;
  edited_descriptions?: Record<string, string[]> | null;
  edited_entry_overrides?: Record<string, PdfExportEntryOverride> | null;
  total_hours?: number | string | null;
  header_overrides?: { approver_po_afe?: string; service_location?: string } | null;
};

const PDF_EXPORT_RATE_ORDER = [
  'Shop Time',
  'Travel Time',
  'Field Time',
  'Shop Overtime',
  'Field Overtime',
] as const;

function serviceTicketEditHref(recordId: string) {
  const p = new URLSearchParams();
  p.set('openRecord', recordId);
  p.set('tab', 'approved');
  return `/service-tickets?${p.toString()}`;
}

/** Merge saved per-entry overrides into time-entry rows (same idea as Service Tickets panel). */
function mergePdfEntryOverridesIntoRows(
  entries: ServiceTicket['entries'],
  overrides: Record<string, PdfExportEntryOverride>
): Array<{ id: string; description: string; st: number; tt: number; ft: number; so: number; fo: number }> {
  const baseRows = entries.map((entry, index) => {
    const rateType = entry.rate_type || 'Shop Time';
    const hours = entry.hours || 0;
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
  const merged = baseRows.map((row) => {
    const ov = overrides[row.id];
    if (ov) {
      return { ...row, description: ov.description, st: ov.st, tt: ov.tt, ft: ov.ft, so: ov.so, fo: ov.fo };
    }
    return row;
  });
  const existingIds = new Set(baseRows.map((r) => r.id));
  Object.entries(overrides).forEach(([id, ov]) => {
    if (!existingIds.has(id) && id.startsWith('new-')) {
      merged.push({ id, description: ov.description, st: ov.st, tt: ov.tt, ft: ov.ft, so: ov.so, fo: ov.fo });
    }
  });
  return merged;
}

/** Expand service rows to one PDF line per non-zero hour bucket (matches PDF column layout). */
function serviceRowsToTicketPdfEntries(
  rows: Array<{ id: string; description: string; st: number; tt: number; ft: number; so: number; fo: number }>,
  match: ServiceTicket
): ServiceTicket['entries'] {
  const first = match.entries[0];
  const user = first?.user;
  const project = first?.project;
  const out: ServiceTicket['entries'] = [];
  let seq = 0;
  const cols: [keyof (typeof rows)[0], string][] = [
    ['st', 'Shop Time'],
    ['tt', 'Travel Time'],
    ['ft', 'Field Time'],
    ['so', 'Shop Overtime'],
    ['fo', 'Field Overtime'],
  ];
  for (const row of rows) {
    for (const [key, rateType] of cols) {
      const h = row[key] as number;
      if (h > 0) {
        out.push({
          id: `${row.id}-${rateType}-${seq++}`,
          date: match.date,
          hours: h,
          description: row.description?.trim() ? row.description : 'Work performed',
          rate_type: rateType,
          user_id: match.userId,
          user,
          project_id: match.projectId,
          project,
        } as ServiceTicket['entries'][number]);
      }
    }
  }
  return out;
}

function emptyHoursByRateType(): ServiceTicket['hoursByRateType'] {
  return {
    'Shop Time': 0,
    'Travel Time': 0,
    'Field Time': 0,
    'Shop Overtime': 0,
    'Field Overtime': 0,
  };
}

/** Build PDF entries from saved rec data alone (no time-entry match). Mirrors augment branch order:
 *  edited_entry_overrides first, then edited_hours+edited_descriptions. Used for standalone tickets
 *  where billable time entries don't exist (deleted post-approval, manual entry tickets). */
function buildEntriesFromRecOnly(
  rec: ApprovedRecord,
  date: string,
  userId: string,
  projectId: string | undefined
): { entries: ServiceTicket['entries']; hoursByRateType: ServiceTicket['hoursByRateType']; totalHours: number } | null {
  const overrides = rec.edited_entry_overrides;
  if (overrides && Object.keys(overrides).length > 0) {
    const rows = Object.entries(overrides).map(([id, ov]) => ({
      id,
      description: ov.description,
      st: ov.st || 0,
      tt: ov.tt || 0,
      ft: ov.ft || 0,
      so: ov.so || 0,
      fo: ov.fo || 0,
    }));
    const out: ServiceTicket['entries'] = [];
    let seq = 0;
    const cols: [keyof (typeof rows)[0], string][] = [
      ['st', 'Shop Time'],
      ['tt', 'Travel Time'],
      ['ft', 'Field Time'],
      ['so', 'Shop Overtime'],
      ['fo', 'Field Overtime'],
    ];
    for (const row of rows) {
      for (const [key, rateType] of cols) {
        const h = row[key] as number;
        if (h > 0) {
          out.push({
            id: `syn-${row.id}-${rateType}-${seq++}`,
            date,
            hours: h,
            description: row.description?.trim() ? row.description : 'Work performed',
            rate_type: rateType,
            user_id: userId,
            project_id: projectId,
          } as ServiceTicket['entries'][number]);
        }
      }
    }
    if (out.length > 0) {
      const hoursByRateType = emptyHoursByRateType();
      for (const e of out) {
        const rt = e.rate_type as keyof ServiceTicket['hoursByRateType'];
        if (rt in hoursByRateType) hoursByRateType[rt] += Number(e.hours) || 0;
      }
      return { entries: out, hoursByRateType, totalHours: Object.values(hoursByRateType).reduce((s, h) => s + h, 0) };
    }
  }

  const editedHours = rec.edited_hours as Record<string, number | number[]> | null | undefined;
  if (editedHours && Object.keys(editedHours).length > 0) {
    const editedDesc = (rec.edited_descriptions || {}) as Record<string, string[]>;
    const out: ServiceTicket['entries'] = [];
    const hoursByRateType = emptyHoursByRateType();
    let synIdx = 0;
    for (const rateType of PDF_EXPORT_RATE_ORDER) {
      const hRaw = editedHours[rateType];
      if (hRaw === undefined || hRaw === null) continue;
      const hList = (Array.isArray(hRaw) ? hRaw : [hRaw]).map((x) => Number(x) || 0);
      const dList = editedDesc[rateType] || [];
      let sumForType = 0;
      for (let i = 0; i < hList.length; i++) {
        const h = hList[i];
        if (h <= 0) continue;
        sumForType += h;
        const descFromEdited = dList[i];
        const desc = descFromEdited != null && String(descFromEdited).trim() !== '' ? descFromEdited : 'Work performed';
        out.push({
          id: `syn-${rateType}-${synIdx++}`,
          date,
          hours: h,
          description: desc,
          rate_type: rateType,
          user_id: userId,
          project_id: projectId,
        } as ServiceTicket['entries'][number]);
      }
      if (sumForType > 0) {
        (hoursByRateType as Record<string, number>)[rateType] = sumForType;
      }
    }
    if (out.length > 0) {
      return { entries: out, hoursByRateType, totalHours: Object.values(hoursByRateType).reduce((s, h) => s + h, 0) };
    }
  }

  return null;
}

/**
 * Align invoice-batch PDFs with the Approved tab on Service Tickets.
 * Prefer edited_entry_overrides (per-entry source-of-truth, same as ServiceTickets modal load);
 * then edited_hours + edited_descriptions snapshot; then total_hours fallback. Approval flow rewrites
 * edited_descriptions from raw time entries, so it can be stale even when overrides hold the user's edits.
 */
function augmentMatchTicketForInvoicePdf(rec: ApprovedRecord, match: ServiceTicket): Partial<ServiceTicket> | null {
  const overrides = rec.edited_entry_overrides;
  if (overrides && Object.keys(overrides).length > 0 && match.entries.length > 0) {
    const rows = mergePdfEntryOverridesIntoRows(match.entries, overrides);
    const entries = serviceRowsToTicketPdfEntries(rows, match);
    if (entries.length > 0) {
      const hoursByRateType = emptyHoursByRateType();
      for (const e of entries) {
        const rt = e.rate_type as keyof ServiceTicket['hoursByRateType'];
        if (rt in hoursByRateType) {
          hoursByRateType[rt] += Number(e.hours) || 0;
        }
      }
      const totalHours = Object.values(hoursByRateType).reduce((s, h) => s + h, 0);
      return { entries, hoursByRateType, totalHours };
    }
  }

  const editedHours = rec.edited_hours as Record<string, number | number[]> | null | undefined;
  const hasEditedHoursSnapshot = editedHours && Object.keys(editedHours).length > 0;

  if (hasEditedHoursSnapshot) {
    const editedDesc = (rec.edited_descriptions || {}) as Record<string, string[]>;
    const entries: ServiceTicket['entries'] = [];
    const hoursByRateType = emptyHoursByRateType();
    let synIdx = 0;
    const firstEntry = match.entries[0];

    for (const rateType of PDF_EXPORT_RATE_ORDER) {
      const hRaw = editedHours![rateType];
      if (hRaw === undefined || hRaw === null) continue;
      const hList = (Array.isArray(hRaw) ? hRaw : [hRaw]).map((x) => Number(x) || 0);
      const dList = editedDesc[rateType] || [];
      let sumForType = 0;
      for (let i = 0; i < hList.length; i++) {
        const h = hList[i];
        if (h <= 0) continue;
        sumForType += h;
        const descFromEdited = dList[i];
        const fallback = match.entries.find((e) => e.rate_type === rateType)?.description;
        const desc =
          descFromEdited != null && String(descFromEdited).trim() !== ''
            ? descFromEdited
            : fallback || match.entries[0]?.description || 'Work performed';
        entries.push({
          id: `syn-${rateType}-${synIdx++}`,
          date: match.date,
          hours: h,
          description: desc,
          rate_type: rateType,
          user_id: match.userId,
          user: firstEntry?.user,
          project_id: match.projectId,
          project: firstEntry?.project,
        } as ServiceTicket['entries'][number]);
      }
      if (sumForType > 0) {
        (hoursByRateType as Record<string, number>)[rateType] = sumForType;
      }
    }

    let totalHours = Object.values(hoursByRateType).reduce((s, h) => s + h, 0);
    if (entries.length === 0 && rec.total_hours != null) {
      const th = typeof rec.total_hours === 'string' ? parseFloat(rec.total_hours) : Number(rec.total_hours);
      if (!isNaN(th) && th > 0) {
        const fe = match.entries[0];
        entries.push({
          id: 'syn-total_hours-0',
          date: match.date,
          hours: th,
          description: fe?.description || 'Work performed',
          rate_type: 'Shop Time',
          user_id: match.userId,
          user: fe?.user,
          project_id: match.projectId,
          project: fe?.project,
        } as ServiceTicket['entries'][number]);
        hoursByRateType['Shop Time'] = th;
        totalHours = th;
      }
    }

    if (entries.length > 0) {
      return { entries, hoursByRateType, totalHours };
    }
  }

  if (rec.total_hours != null && match.entries.length > 0) {
    const th = typeof rec.total_hours === 'string' ? parseFloat(rec.total_hours) : Number(rec.total_hours);
    if (!isNaN(th) && th > 0) {
      const fe = match.entries[0];
      const hoursByRateType = emptyHoursByRateType();
      hoursByRateType['Shop Time'] = th;
      return {
        entries: [
          {
            id: 'syn-total_hours-fallback',
            date: match.date,
            hours: th,
            description: fe?.description || 'Work performed',
            rate_type: 'Shop Time',
            user_id: match.userId,
            user: fe?.user,
            project_id: match.projectId,
            project: fe?.project,
          } as ServiceTicket['entries'][number],
        ],
        hoursByRateType,
        totalHours: th,
      };
    }
  }

  return null;
}

/** Parse ticket number to extract numeric part for sorting (e.g. DB_25001 -> 25001) */
function ticketNumberSortValue(ticketNumber: string | undefined): number {
  if (!ticketNumber) return 0;
  const m = ticketNumber.match(/\d{3,}$/);
  return m ? parseInt(m[0], 10) : 0;
}

/** Format ticket numbers with ranges (e.g. DB_25001, DB_25002, DB_25005 -> "DB_25001 - DB_25002, DB_25005") */
function formatTicketNumbersWithRanges(ticketNumbers: string[]): string {
  if (ticketNumbers.length === 0) return '';
  const parsed = ticketNumbers
    .filter(Boolean)
    .map((tn) => {
      const m = tn.match(/^(.+?)(\d{3,})$/);
      return m ? { prefix: m[1], num: parseInt(m[2], 10), full: tn } : { prefix: tn, num: 0, full: tn };
    })
    .sort((a, b) => (a.prefix !== b.prefix ? a.prefix.localeCompare(b.prefix) : a.num - b.num));
  const parts: string[] = [];
  let i = 0;
  while (i < parsed.length) {
    const start = i;
    while (i + 1 < parsed.length && parsed[i + 1].prefix === parsed[i].prefix && parsed[i + 1].num === parsed[i].num + 1) {
      i++;
    }
    if (i > start) {
      parts.push(`${parsed[start].full} - ${parsed[i].full}`);
    } else {
      parts.push(parsed[i].full);
    }
    i++;
  }
  return parts.join(', ');
}

/** Subtle click-to-copy for header values: pointer + dotted underline on hover, brief “Copied” tooltip. */
/** Labeled box that copies its value on click. Used on the Portal Submission tab so each field is one click to clipboard. */
function PortalCopyField({ label, value, placeholder }: { label: string; value: string; placeholder?: string }) {
  const trimmed = value.trim();
  const empty = !trimmed;
  const [copied, setCopied] = useState(false);
  const [hover, setHover] = useState(false);

  const copyNow = useCallback(async () => {
    if (empty) return;
    try {
      await navigator.clipboard.writeText(trimmed);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }, [empty, trimmed]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); void copyNow(); }}
        disabled={empty}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={empty ? 'Nothing to copy' : copied ? 'Copied' : 'Click to copy'}
        style={{
          textAlign: 'left',
          padding: '8px 12px',
          border: `1px solid ${copied ? '#22c55e' : 'var(--border-color)'}`,
          borderRadius: '6px',
          backgroundColor: copied ? '#22c55e14' : hover && !empty ? 'var(--bg-primary)' : 'var(--bg-tertiary)',
          color: empty ? 'var(--text-tertiary)' : 'var(--text-primary)',
          fontSize: '13px',
          fontFamily: 'inherit',
          cursor: empty ? 'not-allowed' : 'pointer',
          transition: 'background-color 0.15s, border-color 0.15s',
          minHeight: '34px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          width: '100%',
        }}
      >
        <span style={{ wordBreak: 'break-word' }}>{empty ? placeholder ?? '(none)' : trimmed}</span>
        <span aria-hidden style={{ fontSize: '11px', color: copied ? '#22c55e' : 'var(--text-tertiary)', flexShrink: 0 }}>
          {copied ? '✓' : '⧉'}
        </span>
      </button>
    </div>
  );
}

function CopyableHeaderValue({ copyText, children }: { copyText: string; children: ReactNode }) {
  const trimmed = copyText.trim();
  const inactive = !trimmed;
  const [copied, setCopied] = useState(false);
  const [hover, setHover] = useState(false);

  const copyNow = useCallback(async () => {
    if (inactive) return;
    try {
      await navigator.clipboard.writeText(trimmed);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }, [inactive, trimmed]);

  if (inactive) {
    return <>{children}</>;
  }

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        void copyNow();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          void copyNow();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={copied ? 'Copied' : 'Copy'}
      style={{
        cursor: 'pointer',
        borderRadius: '3px',
        outline: 'none',
        textDecoration: hover && !copied ? 'underline dotted' : undefined,
        textDecorationColor: 'var(--text-tertiary)',
        textUnderlineOffset: '2px',
      }}
    >
      {children}
    </span>
  );
}

type BreakdownMode = 'itemized' | 'split' | 'combined';

function BreakdownModeToggle({ mode, onMode }: { mode: BreakdownMode; onMode: (m: BreakdownMode) => void }) {
  const btn = (label: string, m: BreakdownMode, leftBorder?: boolean) => (
    <button type="button" onClick={mode !== m ? () => onMode(m) : undefined} style={{
      padding: '3px 10px', border: 'none',
      borderLeft: leftBorder ? '1px solid var(--border-color)' : 'none',
      cursor: mode !== m ? 'pointer' : 'default',
      backgroundColor: mode === m ? 'var(--primary-color)' : 'var(--bg-primary)',
      color: mode === m ? 'white' : 'var(--text-secondary)',
      transition: 'background-color 0.15s, color 0.15s',
    }}>{label}</button>
  );
  return (
    <div style={{ display: 'inline-flex', borderRadius: '14px', border: '1px solid var(--border-color)', overflow: 'hidden', fontSize: '11px', fontWeight: 600 }}>
      {btn('Itemized', 'itemized')}
      {btn('Split by rate', 'split', true)}
      {btn('Combined', 'combined', true)}
    </div>
  );
}

/** PO/AFE line + amount as two separate shadowed boxes; each copies its own text */
function PoAfeBreakdownLine({
  ticketList,
  poAfe,
  totalAmount,
  category = 'labour',
  splitRate,
  splitHours,
}: {
  ticketList: string;
  poAfe: string;
  totalAmount: number;
  category?: string;
  splitRate?: number;
  splitHours?: number;
}) {
  const [hoverLine, setHoverLine] = useState(false);
  const [hoverAmount, setHoverAmount] = useState(false);
  const [hoverSplitHours, setHoverSplitHours] = useState(false);
  const [hoverSplitRate, setHoverSplitRate] = useState(false);
  const [copiedLine, setCopiedLine] = useState(false);
  const [copiedAmount, setCopiedAmount] = useState(false);
  const [copiedSplitHours, setCopiedSplitHours] = useState(false);
  const [copiedSplitRate, setCopiedSplitRate] = useState(false);
  const isNone = !poAfe || poAfe === '(none)' || poAfe === NO_PO_AFE_LABEL;
  const isExpenseOnly = category === 'expense';
  const isCombined = category !== 'labour' && category !== 'expense';
  const categoryLabel = isExpenseOnly ? 'Expense' : isCombined ? category : 'Labour';
  const copyText = isNone ? ticketList : `PO/AFE/CC: ${poAfe}; ${ticketList}`;
  const displayText = isNone ? ticketList : `PO/AFE/CC: ${poAfe}; ${ticketList}`;
  const formattedTotal = `$${totalAmount.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const categoryColor = isExpenseOnly ? '#e67e22' : isCombined ? '#8e44ad' : '#2980b9';

  const shadowRest = '0 1px 3px rgba(0, 0, 0, 0.08)';
  const shadowHover = '0 4px 16px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.08)';

  const copyLine = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopiedLine(true);
      setTimeout(() => setCopiedLine(false), 1500);
    } catch {
      // ignore
    }
  };

  const copyAmount = async () => {
    try {
      await navigator.clipboard.writeText(formattedTotal);
      setCopiedAmount(true);
      setTimeout(() => setCopiedAmount(false), 1500);
    } catch {
      // ignore
    }
  };

  const formattedSplitHours =
    splitRate !== undefined && splitHours !== undefined
      ? `${splitHours.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}h`
      : '';
  const formattedSplitRate =
    splitRate !== undefined && splitHours !== undefined
      ? `$${splitRate.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/h`
      : '';
  /** Clipboard only: numeric hours/rate (no h, $, /h). Display strings stay formattedSplit*. */
  const clipboardSplitHours =
    splitRate !== undefined && splitHours !== undefined
      ? splitHours.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '';
  const clipboardSplitRate =
    splitRate !== undefined && splitHours !== undefined
      ? splitRate.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '';

  const copySplitHours = async () => {
    if (!clipboardSplitHours) return;
    try {
      await navigator.clipboard.writeText(clipboardSplitHours);
      setCopiedSplitHours(true);
      setTimeout(() => setCopiedSplitHours(false), 1500);
    } catch {
      // ignore
    }
  };

  const copySplitRate = async () => {
    if (!clipboardSplitRate) return;
    try {
      await navigator.clipboard.writeText(clipboardSplitRate);
      setCopiedSplitRate(true);
      setTimeout(() => setCopiedSplitRate(false), 1500);
    } catch {
      // ignore
    }
  };

  const amountBoxStyle = {
    flexShrink: 0 as const,
    alignSelf: 'flex-start' as const,
    padding: '8px 14px',
    borderRadius: '8px',
    cursor: 'pointer' as const,
    fontWeight: 700 as const,
    color: 'var(--primary-color)',
    fontSize: '14px',
    textAlign: 'right' as const,
    whiteSpace: 'nowrap' as const,
    border: '1px solid var(--border-color)',
    userSelect: 'none' as const,
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: '10px',
        marginBottom: '8px',
        fontSize: '13px',
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          void copyLine();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void copyLine();
          }
        }}
        onMouseEnter={() => setHoverLine(true)}
        onMouseLeave={() => setHoverLine(false)}
        title={copiedLine ? 'Copied!' : 'Click to copy line (not the dollar amount)'}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '8px 12px',
          borderRadius: '8px',
          cursor: 'pointer',
          color: 'var(--text-primary)',
          textAlign: 'left',
          border: '1px solid var(--border-color)',
          backgroundColor: copiedLine ? 'var(--bg-secondary)' : 'var(--bg-primary)',
          boxShadow: hoverLine || copiedLine ? shadowHover : shadowRest,
          transition: 'box-shadow 0.2s ease, background-color 0.2s ease',
          userSelect: 'none',
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>{displayText}</span>
        <span
          style={{
            flexShrink: 0,
            marginLeft: '12px',
            fontSize: '10px',
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: categoryColor,
          }}
        >
          {categoryLabel}
        </span>
      </div>
      {splitRate !== undefined && splitHours !== undefined ? (
        <div style={{ display: 'flex', gap: '10px' }}>
          <div
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              void copySplitHours();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void copySplitHours();
              }
            }}
            onMouseEnter={() => setHoverSplitHours(true)}
            onMouseLeave={() => setHoverSplitHours(false)}
            title={copiedSplitHours ? 'Copied!' : 'Click to copy hours'}
            style={{
              ...amountBoxStyle,
              backgroundColor: copiedSplitHours ? 'var(--bg-secondary)' : 'var(--bg-primary)',
              boxShadow: hoverSplitHours || copiedSplitHours ? shadowHover : shadowRest,
              transition: 'box-shadow 0.2s ease, background-color 0.2s ease',
            }}
          >
            {formattedSplitHours}
          </div>
          <div
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              void copySplitRate();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void copySplitRate();
              }
            }}
            onMouseEnter={() => setHoverSplitRate(true)}
            onMouseLeave={() => setHoverSplitRate(false)}
            title={copiedSplitRate ? 'Copied!' : 'Click to copy rate'}
            style={{
              ...amountBoxStyle,
              backgroundColor: copiedSplitRate ? 'var(--bg-secondary)' : 'var(--bg-primary)',
              boxShadow: hoverSplitRate || copiedSplitRate ? shadowHover : shadowRest,
              transition: 'box-shadow 0.2s ease, background-color 0.2s ease',
            }}
          >
            {formattedSplitRate}
          </div>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            void copyAmount();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              void copyAmount();
            }
          }}
          onMouseEnter={() => setHoverAmount(true)}
          onMouseLeave={() => setHoverAmount(false)}
          title={copiedAmount ? 'Copied!' : 'Click to copy this amount only'}
          style={{
            ...amountBoxStyle,
            backgroundColor: copiedAmount ? 'var(--bg-secondary)' : 'var(--bg-primary)',
            boxShadow: hoverAmount || copiedAmount ? shadowHover : shadowRest,
            transition: 'box-shadow 0.2s ease, background-color 0.2s ease',
          }}
        >
          {formattedTotal}
        </div>
      )}
    </div>
  );
}

type InvoiceTicketModalTicket = ServiceTicket & {
  recordId?: string;
  headerOverrides?: unknown;
  recordProjectId?: string;
};

function InvoiceTicketDetailModal({
  ticket,
  expenses,
  onClose,
}: {
  ticket: InvoiceTicketModalTicket;
  expenses: InvoiceExpenseLine[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ho = ticket.headerOverrides as
    | { approver_po_afe?: string; approver?: string; po_afe?: string; cc?: string; other?: string; service_location?: string }
    | undefined;
  const gk = getInvoiceGroupKey(
    {
      projectId: ticket.recordProjectId ?? ticket.projectId,
      projectName: ticket.projectName,
      projectNumber: ticket.projectNumber,
      location: ticket.location,
      projectApproverPoAfe: ticket.projectApproverPoAfe,
      projectLocation: ticket.projectLocation,
      projectOther: ticket.projectOther,
      customerInfo: ticket.customerInfo,
      entries: ticket.entries,
    },
    ho
  );
  const rid = ticket.recordId?.trim() || ticket.id;
  const totalAmount = calculateTicketTotalAmount(ticket, expenses);
  const formattedTotal = `$${totalAmount.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const entryRows =
    ticket.entries.length > 0
      ? ticket.entries.map((e, i) => (
          <tr key={e.id || i} style={{ borderBottom: '1px solid var(--border-color)' }}>
            <td style={{ padding: '8px 10px', fontSize: '13px', verticalAlign: 'top' }}>{e.description || '—'}</td>
            <td style={{ padding: '8px 10px', fontSize: '13px', whiteSpace: 'nowrap' }}>{e.rate_type || '—'}</td>
            <td style={{ padding: '8px 10px', fontSize: '13px', textAlign: 'right', whiteSpace: 'nowrap' }}>{e.hours ?? 0}h</td>
          </tr>
        ))
      : PDF_EXPORT_RATE_ORDER.filter((rt) => (ticket.hoursByRateType[rt] || 0) > 0).map((rt) => (
          <tr key={rt} style={{ borderBottom: '1px solid var(--border-color)' }}>
            <td style={{ padding: '8px 10px', fontSize: '13px' }}>—</td>
            <td style={{ padding: '8px 10px', fontSize: '13px', whiteSpace: 'nowrap' }}>{rt}</td>
            <td style={{ padding: '8px 10px', fontSize: '13px', textAlign: 'right', whiteSpace: 'nowrap' }}>
              {ticket.hoursByRateType[rt]}h
            </td>
          </tr>
        ));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="invoice-ticket-modal-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10050,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--bg-primary)',
          borderRadius: '12px',
          maxWidth: 720,
          width: '100%',
          maxHeight: '85vh',
          overflow: 'auto',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)',
          border: '1px solid var(--border-color)',
        }}
      >
        <div style={{ padding: '20px 20px 12px', borderBottom: '1px solid var(--border-color)' }}>
          <h2 id="invoice-ticket-modal-title" style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>
            {ticket.ticketNumber || 'Ticket'} — {ticket.userName}
          </h2>
          <div style={{ marginTop: '8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
            {ticket.date}
            {ticket.customerName ? ` · ${ticket.customerName}` : ''}
          </div>
        </div>
        <div style={{ padding: '16px 20px', fontSize: '13px', display: 'grid', gap: '8px' }}>
          <div>
            <span style={{ color: 'var(--text-tertiary)' }}>Project: </span>
            {[ticket.projectNumber, ticket.projectName].filter(Boolean).join(' – ') || gk.projectId || '—'}
          </div>
          <div>
            <span style={{ color: 'var(--text-tertiary)' }}>Location: </span>
            {gk.location || ticket.location || '—'}
          </div>
          <div>
            <span style={{ color: 'var(--text-tertiary)' }}>Approver: </span>
            {gk.approver || '—'}
          </div>
          <div>
            <span style={{ color: 'var(--text-tertiary)' }}>PO/AFE/CC: </span>
            {gk.poAfe || '—'}
          </div>
          <div>
            <span style={{ color: 'var(--text-tertiary)' }}>Coding: </span>
            {gk.cc || '—'}
          </div>
        </div>
        <div style={{ padding: '0 20px 16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
            Time entries
          </div>
          {entryRows.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-tertiary)', fontSize: '12px' }}>
                  <th style={{ padding: '6px 10px', fontWeight: 600 }}>Description</th>
                  <th style={{ padding: '6px 10px', fontWeight: 600 }}>Rate</th>
                  <th style={{ padding: '6px 10px', fontWeight: 600, textAlign: 'right' }}>Hours</th>
                </tr>
              </thead>
              <tbody>{entryRows}</tbody>
            </table>
          ) : (
            <div style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>No time rows for this ticket.</div>
          )}
        </div>
        {expenses.length > 0 && (
          <div style={{ padding: '0 20px 16px' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
              Expenses
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-tertiary)', fontSize: '12px' }}>
                  <th style={{ padding: '6px 10px', fontWeight: 600 }}>Description</th>
                  <th style={{ padding: '6px 10px', fontWeight: 600, whiteSpace: 'nowrap' }}>Qty × rate</th>
                  <th style={{ padding: '6px 10px', fontWeight: 600, textAlign: 'right' }}>Line</th>
                </tr>
              </thead>
              <tbody>
                {expenses.map((e, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '8px 10px', verticalAlign: 'top' }}>{formatInvoiceExpenseLineLabel(e)}</td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                      {e.quantity} × ${e.rate.toFixed(2)}
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      ${(e.quantity * e.rate).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ padding: '12px 20px 20px', borderTop: '1px solid var(--border-color)', display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--primary-color)' }}>Batch subtotal (labour + expenses): {formattedTotal}</div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '8px 16px',
                backgroundColor: 'var(--bg-tertiary)',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer',
                color: 'var(--text-primary)',
              }}
            >
              Close
            </button>
            <Link
              to={serviceTicketEditHref(rid)}
              onClick={onClose}
              style={{
                padding: '8px 16px',
                backgroundColor: 'var(--primary-color)',
                color: 'white',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: 600,
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              Open in Service Tickets
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

const MARKED_INVOICED_STORAGE_KEY = 'ionex-invoices-marked';
const FROZEN_INVOICED_GROUPS_KEY = 'ionex-invoices-frozen-groups';

const SUMMARY_LABOUR_TYPES = [
  { key: 'ST', label: 'Shop Time (ST)' },
  { key: 'TT', label: 'Travel Time (TT)' },
  { key: 'FT', label: 'Field Time (FT)' },
  { key: 'SO', label: 'Shop OT (SO)' },
  { key: 'FO', label: 'Field OT (FO)' },
] as const;

function readMarkedInvoiceIdsFromLocalStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(MARKED_INVOICED_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function persistMarkedInvoiceIdsToLocalStorage(ids: Set<string>) {
  try {
    localStorage.setItem(MARKED_INVOICED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore
  }
}

export type DateRangeGrouping =
  | 'daily'
  | 'weekly'
  | 'bi-weekly'
  | 'monthly'
  | 'project-completion'
  | 'progress';

/** CNRL invoice batches always use calendar periods; project-completion and progress are not used on the CNRL path. */
function cnrlPeriodGrouping(g: DateRangeGrouping): Exclude<DateRangeGrouping, 'project-completion' | 'progress'> {
  return (g === 'project-completion' || g === 'progress') ? 'bi-weekly' : g;
}

/** Get period key for a ticket date for non-CNRL grouping (daily / weekly / bi-weekly / monthly / project-completion) */
function getPeriodKey(dateStr: string, grouping: DateRangeGrouping, projectId?: string): string {
  if (grouping === 'project-completion') {
    return projectId ? `pc:${projectId}` : 'pc:unknown';
  }
  if (grouping === 'progress') {
    return projectId ? `prog:${projectId}` : 'prog:unknown';
  }
  const d = new Date(dateStr + 'T12:00:00');
  const y = d.getFullYear();
  const m = d.getMonth();
  const date = d.getDate();
  if (grouping === 'daily') return dateStr;
  if (grouping === 'monthly') return `${y}-${String(m + 1).padStart(2, '0')}`;
  const dayOfWeek = d.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(d);
  monday.setDate(date + mondayOffset);
  const monY = monday.getFullYear();
  const monM = monday.getMonth();
  const monD = monday.getDate();
  const weekStart = `${monY}-${String(monM + 1).padStart(2, '0')}-${String(monD).padStart(2, '0')}`;
  if (grouping === 'weekly') return weekStart;
  const jan1 = new Date(monY, 0, 1);
  const firstMonday = jan1.getDay() === 0 ? 2 : jan1.getDay() === 1 ? 1 : 9 - jan1.getDay();
  const firstMon = new Date(monY, 0, firstMonday);
  const diffMs = monday.getTime() - firstMon.getTime();
  const weekNum = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;
  const biweekNum = Math.ceil(weekNum / 2);
  return `${monY}-B${String(biweekNum).padStart(2, '0')}`;
}

/** Format date as dd-mm-yyyy */
function toDdMmYyyy(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

/** Human-readable label for a period key */
function getPeriodLabel(periodKey: string, grouping: DateRangeGrouping): string {
  if (grouping === 'progress') return 'Progress batch';
  if (grouping === 'project-completion') return 'Project completion';
  if (grouping === 'daily') return periodKey;
  if (grouping === 'monthly') {
    const [y, m] = periodKey.split('-');
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return `${monthNames[parseInt(m || '1', 10) - 1]} ${y}`;
  }
  if (grouping === 'weekly') return `Week of ${periodKey}`;
  // Bi-weekly: show date range dd-mm-yyyy to dd-mm-yyyy
  const [yStr, bStr] = periodKey.split('-');
  const y = parseInt(yStr || '0', 10);
  const bi = parseInt((bStr || '0').replace('B', ''), 10) || 1;
  const jan1 = new Date(y, 0, 1);
  const firstMonday = jan1.getDay() === 0 ? 2 : jan1.getDay() === 1 ? 1 : 9 - jan1.getDay();
  const firstMon = new Date(y, 0, firstMonday);
  const start = new Date(firstMon);
  start.setDate(firstMon.getDate() + (bi - 1) * 14);
  const end = new Date(start);
  end.setDate(start.getDate() + 13);
  return `${toDdMmYyyy(start)} to ${toDdMmYyyy(end)}`;
}

/** Local today as yyyy-mm-dd for comparisons. */
function ymdTodayLocal(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

/**
 * Last calendar day of the invoice period (yyyy-mm-dd), or null if not a fixed calendar period.
 * Must stay in sync with getPeriodLabel's range logic.
 */
function getPeriodEndYmd(periodKey: string, grouping: DateRangeGrouping): string | null {
  if (!periodKey?.trim() || grouping === 'project-completion' || grouping === 'progress') return null;
  if (periodKey.startsWith('pc:') || periodKey.startsWith('prog:')) return null;

  if (grouping === 'daily') {
    return /^\d{4}-\d{2}-\d{2}$/.test(periodKey) ? periodKey : null;
  }
  if (grouping === 'monthly') {
    const parts = periodKey.split('-');
    const y = parseInt(parts[0] || '', 10);
    const m = parseInt(parts[1] || '', 10);
    if (Number.isNaN(y) || Number.isNaN(m)) return null;
    const last = new Date(y, m, 0);
    return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
  }
  if (grouping === 'weekly') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodKey)) return null;
    const d = new Date(`${periodKey}T12:00:00`);
    const end = new Date(d);
    end.setDate(d.getDate() + 6);
    return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
  }
  // bi-weekly: same as getPeriodLabel
  const [yStr, bStr] = periodKey.split('-');
  const y = parseInt(yStr || '0', 10);
  const bi = parseInt((bStr || '0').replace('B', ''), 10) || 1;
  const jan1 = new Date(y, 0, 1);
  const firstMonday = jan1.getDay() === 0 ? 2 : jan1.getDay() === 1 ? 1 : 9 - jan1.getDay();
  const firstMon = new Date(y, 0, firstMonday);
  const start = new Date(firstMon);
  start.setDate(firstMon.getDate() + (bi - 1) * 14);
  const end = new Date(start);
  end.setDate(start.getDate() + 13);
  return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
}

/** True while today is still on or before the period end date (more tickets may land in this batch). */
function isInvoicePeriodStillAccumulating(periodKey: string | undefined, grouping: DateRangeGrouping): boolean {
  if (!periodKey) return false;
  const end = getPeriodEndYmd(periodKey, grouping);
  if (!end) return false;
  return ymdTodayLocal() <= end;
}

function periodAccumulationHintLabel(periodLabel: string | undefined): string {
  if (!periodLabel?.trim()) return 'the end of this period';
  const parts = periodLabel.split(/\s+to\s+/i);
  if (parts.length >= 2) return parts[parts.length - 1]!.trim();
  return periodLabel.trim();
}

type InvoiceGroupKeyWithPeriod = InvoiceGroupKey & { periodKey?: string; periodLabel?: string };

/** Same rule as pending banner on uninvoiced cards: calendar period not ended yet. */
function uninvoicedGroupPeriodStillAccumulating(
  group: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] },
  getGroupingForTicket: (customerId: string, projectId: string) => DateRangeGrouping
): boolean {
  const pk = group.key.periodKey;
  if (!pk || String(pk).startsWith('pc:') || String(pk).startsWith('prog:')) return false;
  const first = group.tickets[0];
  if (!first) return false;
  const custId = first.customerId ?? '';
  const projId =
    (first as ServiceTicket & { recordProjectId?: string }).recordProjectId ?? first.projectId ?? '';
  const periodGrouping = cnrlPeriodGrouping(getGroupingForTicket(custId, projId));
  return isInvoicePeriodStillAccumulating(pk, periodGrouping);
}

type FrozenGroupSnapshot = { key: InvoiceGroupKeyWithPeriod; ticketIds: string[]; expensesCombined?: boolean; statusId?: string; statusChangedAt?: string; labourNotes?: Record<string, string> };

/** Persist service_tickets.id (UUID) in marks so DB locks and Service Tickets match. Falls back to composite t.id if no DB row yet. */
function snapshotTicketIdsForInvoicedMark(
  tickets: (ServiceTicket & { recordId?: string })[]
): string[] {
  return tickets.map((t) => {
    const rid = (t as { recordId?: string }).recordId;
    if (rid && String(rid).trim()) return String(rid).trim();
    return t.id;
  });
}

/** Union of existing mark ticket IDs and current grid row IDs so re-saving never drops locks. */
function mergeMarkSnapshotForGroup(
  group: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] },
  existing: FrozenGroupSnapshot | null | undefined,
  expensesCombined?: boolean,
  statusId?: string,
  pendingLabourNotes?: Record<string, string>
): FrozenGroupSnapshot {
  const fresh = snapshotTicketIdsForInvoicedMark(group.tickets as (ServiceTicket & { recordId?: string })[]);
  const merged = new Set<string>();
  if (existing?.ticketIds && Array.isArray(existing.ticketIds)) {
    for (const id of existing.ticketIds) {
      if (typeof id === 'string' && id.trim()) merged.add(id.trim());
    }
  }
  for (const id of fresh) merged.add(id);
  return {
    key: group.key,
    ticketIds: [...merged].sort(),
    expensesCombined: expensesCombined ?? existing?.expensesCombined,
    statusId: statusId ?? existing?.statusId,
    labourNotes: pendingLabourNotes ?? existing?.labourNotes,
  };
}

function ticketIdsSetFromMarkRow(row: InvoicedBatchMarkRow): Set<string> {
  const raw = row.key_snapshot?.ticketIds;
  if (!Array.isArray(raw)) return new Set();
  return new Set(
    raw.map((x) => (typeof x === 'string' ? x.trim() : String(x ?? '').trim())).filter(Boolean)
  );
}

function markRowCoversAllTicketsInGroup(
  row: InvoicedBatchMarkRow,
  group: { tickets: ServiceTicket[] }
): boolean {
  if (group.tickets.length === 0) return false;
  const have = ticketIdsSetFromMarkRow(row);
  return group.tickets.every((t) => {
    const rid = String((t as ServiceTicket & { recordId?: string }).recordId ?? '').trim();
    const cid = String(t.id ?? '').trim();
    return (rid && have.has(rid)) || (cid && have.has(cid));
  });
}

/**
 * DB row for this batch: exact group_id match first, else any mark whose snapshot lists every ticket in the batch.
 * Fixes UI drift when getGroupId() changes (e.g. project id source) but invoiced_batch_marks still use the old key.
 */
function findMarkRowForGroup(
  group: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] },
  rows: InvoicedBatchMarkRow[]
): InvoicedBatchMarkRow | undefined {
  const gid = getGroupId(group);
  const exact = rows.find((r) => r.group_id === gid);
  if (exact) return exact;
  return rows.find((r) => markRowCoversAllTicketsInGroup(r, group));
}

function resolvedPersistGroupId(
  group: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] },
  rows: InvoicedBatchMarkRow[]
): string {
  return findMarkRowForGroup(group, rows)?.group_id ?? getGroupId(group);
}

function getGroupId(group: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] }): string {
  const key = group.key;
  // CNRL with period: projectId|approverCode|periodKey
  if (key.periodKey && key.approverCode && key.approverCode !== key.periodKey) {
    return `${key.projectId ?? ''}|${key.approverCode}|${key.periodKey}`;
  }
  // Non-CNRL (period only): projectId|periodKey
  if (key.periodKey) return `${key.projectId}|${key.periodKey}`;
  const ids = group.tickets
    .map((t) => (t as ServiceTicket & { recordId?: string }).recordId || t.id)
    .filter(Boolean)
    .sort();
  return `${key.approverCode}|${ids.join(',')}`;
}

/** Match batches that share the same project, approver, PO/AFE, and CC (coding) for bulk labour notes. */
function summaryDescriptionMatchKey(key: InvoiceGroupKeyWithPeriod): string {
  return [
    (key.projectId ?? '').trim(),
    (key.approver ?? '').trim(),
    (key.poAfe ?? '').trim(),
    (key.cc ?? '').trim(),
  ].join('\u0001');
}

/** service_tickets.id values (UUID) in legacy non-period group_id: `approverCode|id1,id2,...` */
const SERVICE_TICKET_ROW_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Non-period invoice batches encode every ticket row id after the first `|`. Period batches use
 * `projectId|periodKey` or `projectId|approver|periodKey` instead — those cannot be parsed here; heal
 * needs the group to appear in the current Invoices date range.
 */
function parseTicketIdsFromLegacyNonPeriodGroupId(groupId: string): string[] | null {
  const pipe = groupId.indexOf('|');
  if (pipe < 0) return null;
  const rest = groupId.slice(pipe + 1).trim();
  if (!rest) return null;
  const parts = rest.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (!parts.every((p) => SERVICE_TICKET_ROW_UUID_RE.test(p))) return null;
  return parts;
}

/** Normalize ticket date to yyyy-mm-dd */
function toDateStr(d: string | undefined | null): string {
  if (!d) return '';
  return typeof d === 'string' ? d.split('T')[0] : new Date(d).toISOString().split('T')[0];
}

/** Date range for filename: "first_to_last" or single "yyyy-mm-dd" when same */
function getTicketDateRangeStr(tickets: ServiceTicket[]): string {
  const dates = tickets.map((t) => toDateStr(t.date)).filter(Boolean);
  if (dates.length === 0) return new Date().toISOString().split('T')[0];
  const sorted = [...new Set(dates)].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return first === last ? first : `${first}_to_${last}`;
}

/** Sanitize a filename component (strip illegal characters, collapse whitespace). */
function sanitizeFilenamePart(s: string): string {
  return s.trim().replace(/[/\\?*:|"<>]/g, '_').replace(/\s+/g, ' ');
}

/**
 * Batch-for-approval filename: <Approver|ProjectName|CustomerName>_<Period>.pdf.
 * Approver is resolved as: key.approverCode → matching project.approver → null.
 * Period is key.periodLabel when present, otherwise the date range.
 */
function getApprovalBatchFilename(
  key: InvoiceGroupKeyWithPeriod,
  tickets: ServiceTicket[],
  projects: Array<{ project_number?: string | null; approver?: string | null }> | undefined
): string {
  const codeFromKey = key.approverCode?.trim();
  let approver: string | null = codeFromKey && codeFromKey.length > 0 ? codeFromKey : null;
  if (!approver) {
    const pn = key.projectNumber?.trim().toLowerCase();
    if (pn) {
      const proj = projects?.find((p) => (p.project_number ?? '').trim().toLowerCase() === pn);
      const projApprover = proj?.approver?.trim();
      if (projApprover) approver = projApprover;
    }
  }
  const name = approver
    ?? key.projectName?.trim()
    ?? tickets[0]?.customerName?.trim()
    ?? 'batch';
  const period = key.periodLabel?.trim() || getTicketDateRangeStr(tickets);
  return `${sanitizeFilenamePart(name)} - ${sanitizeFilenamePart(period)}.pdf`;
}

/** Invoice PDF filename: Approver_ProjectNumber_DateRange.pdf (CNRL) or ProjectNumber_PeriodLabel.pdf (non-CNRL) */
function getInvoicePdfFilename(
  key: InvoiceGroupKeyWithPeriod,
  tickets: ServiceTicket[]
): string {
  const projectNum = (key.projectNumber || key.projectId || 'no-project').trim().replace(/[/\\?*:|"]/g, '_');
  if (key.periodKey && key.periodLabel) {
    const periodPart = key.periodLabel.replace(/[/\\?*:|"]/g, '_');
    return `${projectNum}_${periodPart}.pdf`;
  }
  const approver = (key.approverCode || 'no-approver').replace(/[/\\?*:|"]/g, '_');
  const dateRange = getTicketDateRangeStr(tickets);
  return `${approver}_${projectNum}_${dateRange}.pdf`;
}

/**
 * Filename for merged download (QuickBooks invoice + service ticket PDFs).
 * Differs from the standalone invoice name so saving to the same folder does not create " (1)" duplicates.
 */
function mergedInvoiceBatchDownloadFilename(sourceInvoiceName: string | null | undefined): string {
  let stem = invoiceFilenameForDownload(sourceInvoiceName);
  stem = stem.replace(/\.pdf$/i, '').trim();
  if (!stem) stem = 'invoice';
  return `${stem} - with service tickets.pdf`;
}

/** One row in the invoice copy/paste breakdown; splitRate/splitHours only used in "Split by rate" mode. */
type InvoiceBreakdownLine = {
  ticketList: string;
  poAfe: string;
  totalAmount: number;
  splitRate?: number;
  splitHours?: number;
};

/** Single line for non-CNRL period groups (no PO/AFE breakdown); poAfe empty so "PO/AFE/CC:" is not shown */
function buildSingleLineBreakdown(
  tickets: (ServiceTicket & { recordId?: string })[],
  expensesByRecordId: Map<string, InvoiceExpenseLine[]>,
  includeExpenses = false
): InvoiceBreakdownLine[] {
  const nums = tickets.map((t) => t.ticketNumber).filter(Boolean) as string[];
  let totalAmount = 0;
  for (const t of tickets) {
    const exps = includeExpenses && t.recordId ? (expensesByRecordId.get(t.recordId) ?? []) : [];
    totalAmount += calculateTicketTotalAmount(t, exps);
  }
  return [{
    ticketList: formatTicketNumbersWithRanges(nums),
    poAfe: '',
    totalAmount: Math.round(totalAmount * 100) / 100,
  }];
}

const NO_PO_AFE_LABEL = '(no PO/AFE/CC)';

/** Expense lines for invoice math: billed amount uses quantity×rate; GST may be stored separately per line. */
type InvoiceExpenseLine = {
  quantity: number;
  rate: number;
  gst?: number;
  description?: string;
  expense_type?: string;
};

function formatInvoiceExpenseLineLabel(e: InvoiceExpenseLine): string {
  const desc = (e.description || '').trim();
  const typ = (e.expense_type || '').trim();
  return desc || typ || '—';
}

const CA_GST_ON_LABOUR_RATE = 0.05;

/**
 * Subtotal (pre-GST labour + expense amounts), 5% GST on labour, GST on expenses (5% of expense amounts when
 * receipt line GST is not recorded; otherwise sum of receipt GST), and total — invoiced view only.
 */
function computeInvoicedGroupTotalsWithGst(
  groupTickets: (ServiceTicket & { recordId?: string })[],
  expensesByRecordId: Map<string, InvoiceExpenseLine[]>
): {
  subtotal: number;
  labourSubtotal: number;
  gstOnLabour: number;
  /** Effective GST on expenses (receipt sum if any line has gst; else 5% of expense subtotal). */
  expenseGstTotal: number;
  /** True when expenseGstTotal comes from stored receipt GST on lines (not the 5% default). */
  expenseGstFromReceipt: boolean;
  totalInclGst: number;
} {
  let subtotal = 0;
  let labourSubtotal = 0;
  let expenseBase = 0;
  let receiptGstSum = 0;
  for (const t of groupTickets) {
    const recordId = t.recordId;
    const expenses = recordId ? (expensesByRecordId.get(recordId) ?? []) : [];
    subtotal += calculateTicketTotalAmount(t, expenses);
    labourSubtotal += calculateTicketTotalAmount(t, []);
    for (const e of expenses) {
      expenseBase += e.quantity * e.rate;
      receiptGstSum += Number(e.gst) || 0;
    }
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  subtotal = r2(subtotal);
  labourSubtotal = r2(labourSubtotal);
  expenseBase = r2(expenseBase);
  receiptGstSum = r2(receiptGstSum);
  const gstOnLabour = r2(labourSubtotal * CA_GST_ON_LABOUR_RATE);
  const gstOnExpensesFromRate = r2(expenseBase * CA_GST_ON_LABOUR_RATE);
  const expenseGstFromReceipt = receiptGstSum > 0;
  const expenseGstTotal = expenseGstFromReceipt ? receiptGstSum : gstOnExpensesFromRate;
  const totalInclGst = r2(subtotal + gstOnLabour + expenseGstTotal);
  return {
    subtotal,
    labourSubtotal,
    gstOnLabour,
    expenseGstTotal,
    expenseGstFromReceipt,
    totalInclGst,
  };
}

function computeGroupExpenseTotal(
  tickets: (ServiceTicket & { recordId?: string })[],
  expensesByRecordId: Map<string, InvoiceExpenseLine[]>
): { total: number; lines: { label: string; amount: number; ticketNums: string[] }[] } {
  const grouped = new Map<string, { amount: number; ticketNums: Set<string> }>();
  for (const t of tickets) {
    const rid = t.recordId;
    const exps = rid ? (expensesByRecordId.get(rid) ?? []) : [];
    const tNum = t.ticketNumber || '';
    for (const e of exps) {
      const amt = Math.round(e.quantity * e.rate * 100) / 100;
      if (amt > 0) {
        const label = formatInvoiceExpenseLineLabel(e);
        const existing = grouped.get(label);
        if (existing) {
          existing.amount += amt;
          if (tNum) existing.ticketNums.add(tNum);
        } else {
          const s = new Set<string>();
          if (tNum) s.add(tNum);
          grouped.set(label, { amount: amt, ticketNums: s });
        }
      }
    }
  }
  const lines = [...grouped.entries()]
    .sort((a, b) => b[1].amount - a[1].amount)
    .map(([label, { amount, ticketNums }]) => ({
      label,
      amount: Math.round(amount * 100) / 100,
      ticketNums: [...ticketNums].sort(),
    }));
  const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  return { total, lines };
}

/** Build PO/AFE/CC breakdown with totals: "PO/AFE/CC: xxxxxxxx; AR_xx1, AR_xx2 – $X,XXX.XX". Sorted by PO/AFE value (ascending), with (no PO/AFE/CC) last. */
function buildPoAfeBreakdown(
  tickets: (ServiceTicket & { headerOverrides?: unknown; recordProjectId?: string; recordId?: string })[],
  getKey: (t: typeof tickets[0]) => InvoiceGroupKey,
  expensesByRecordId: Map<string, InvoiceExpenseLine[]>,
  includeExpenses = false
): InvoiceBreakdownLine[] {
  const byPoAfe = new Map<string, { nums: string[]; tickets: typeof tickets }>();
  for (const t of tickets) {
    const key = getKey(t);
    const poAfe = (key.poAfe || '').trim() || NO_PO_AFE_LABEL;
    const entry = byPoAfe.get(poAfe) ?? { nums: [], tickets: [] };
    if (t.ticketNumber) entry.nums.push(t.ticketNumber);
    entry.tickets.push(t);
    byPoAfe.set(poAfe, entry);
  }
  return [...byPoAfe.entries()]
    .sort(([keyA], [keyB]) => {
      if (keyA === NO_PO_AFE_LABEL) return 1;
      if (keyB === NO_PO_AFE_LABEL) return -1;
      const numA = /^\d+$/.test(keyA) ? Number(keyA) : NaN;
      const numB = /^\d+$/.test(keyB) ? Number(keyB) : NaN;
      if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA - numB;
      return keyA.localeCompare(keyB);
    })
    .map(([poAfe, { nums, tickets: poAfeTickets }]) => {
      const sortedNums = [...nums].sort((a, b) => {
        const prefixCmp = (a.split(/\d+$/)[0] || a).localeCompare(b.split(/\d+$/)[0] || b);
        if (prefixCmp !== 0) return prefixCmp;
        return ticketNumberSortValue(a) - ticketNumberSortValue(b);
      });
      let totalAmount = 0;
      for (const t of poAfeTickets) {
        const exps = includeExpenses && t.recordId ? (expensesByRecordId.get(t.recordId) ?? []) : [];
        totalAmount += calculateTicketTotalAmount(t, exps);
      }
      return {
        ticketList: formatTicketNumbersWithRanges(sortedNums),
        poAfe,
        totalAmount: Math.round(totalAmount * 100) / 100,
      };
    })
    .filter((line) => line.poAfe !== NO_PO_AFE_LABEL);
}

/** Splits labour into one line per rate type that has hours > 0; useful when different rate types are billed */
function buildRateTypeBreakdown(
  tickets: (ServiceTicket & { recordId?: string })[],
  expensesByRecordId: Map<string, InvoiceExpenseLine[]>,
  includeExpenses = false
): InvoiceBreakdownLine[] {
  const RATE_TYPES = [
    { key: 'ST', label: 'Shop Time (ST)', rateField: 'rt' as const },
    { key: 'TT', label: 'Travel Time (TT)', rateField: 'tt' as const },
    { key: 'FT', label: 'Field Time (FT)', rateField: 'ft' as const },
    { key: 'SO', label: 'Shop OT (SO)', rateField: 'shop_ot' as const },
    { key: 'FO', label: 'Field OT (FO)', rateField: 'field_ot' as const },
  ];
  
  // Key is `${rateType}_${rateAmount}`
  const hoursMap = new Map<string, number>();
  const numsMap = new Map<string, string[]>();
  
  for (const t of tickets) {
    const { rtHours, ttHours, ftHours, shopOtHours, fieldOtHours } =
      (() => {
        const e = t.entries;
        const rt = e.length > 0 ? e.reduce((s, en) => s + (getRateCodeLocal(en.rate_type) === 'RT' ? roundToNearest025(en.hours || 0) : 0), 0) : roundToNearest025(t.hoursByRateType['Shop Time'] || 0);
        const tt = e.length > 0 ? e.reduce((s, en) => s + (getRateCodeLocal(en.rate_type) === 'TT' ? roundToNearest025(en.hours || 0) : 0), 0) : roundToNearest025(t.hoursByRateType['Travel Time'] || 0);
        const ft = e.length > 0 ? e.reduce((s, en) => s + (getRateCodeLocal(en.rate_type) === 'FT' ? roundToNearest025(en.hours || 0) : 0), 0) : roundToNearest025(t.hoursByRateType['Field Time'] || 0);
        const so = e.length > 0 ? e.reduce((s, en) => s + (en.rate_type === 'Shop Overtime' ? roundToNearest025(en.hours || 0) : 0), 0) : roundToNearest025(t.hoursByRateType['Shop Overtime'] || 0);
        const fo = e.length > 0 ? e.reduce((s, en) => s + (en.rate_type === 'Field Overtime' ? roundToNearest025(en.hours || 0) : 0), 0) : roundToNearest025(t.hoursByRateType['Field Overtime'] || 0);
        return { rtHours: rt, ttHours: tt, ftHours: ft, shopOtHours: so, fieldOtHours: fo };
      })();
    const hByKey: Record<string, number> = { ST: rtHours, TT: ttHours, FT: ftHours, SO: shopOtHours, FO: fieldOtHours };
    
    for (const { key, rateField } of RATE_TYPES) {
      const h = hByKey[key];
      if (h > 0) {
        const rate = t.rates[rateField] || 0;
        const compositeKey = `${key}_${rate}`;
        
        hoursMap.set(compositeKey, (hoursMap.get(compositeKey) ?? 0) + h);
        if (t.ticketNumber) {
          const arr = numsMap.get(compositeKey) ?? [];
          arr.push(t.ticketNumber);
          numsMap.set(compositeKey, arr);
        }
      }
    }
  }
  
  const lines: InvoiceBreakdownLine[] = [];
  
  for (const { key, label } of RATE_TYPES) {
    // Find all composite keys that start with this rate type
    const matchingKeys = Array.from(hoursMap.keys()).filter(k => k.startsWith(`${key}_`));
    
    // Sort by rate descending (optional, but nice for consistency)
    matchingKeys.sort((a, b) => {
      const rateA = Number(a.split('_')[1]);
      const rateB = Number(b.split('_')[1]);
      return rateB - rateA;
    });
    
    for (const compositeKey of matchingKeys) {
      const hrs = hoursMap.get(compositeKey) ?? 0;
      if (hrs <= 0) continue;
      
      const rate = Number(compositeKey.split('_')[1]);
      const amount = Math.round(hrs * rate * 100) / 100;
      
      if (amount > 0) {
        const nums = numsMap.get(compositeKey) ?? [];
        const ticketList = formatTicketNumbersWithRanges([...nums].sort((a, b) => ticketNumberSortValue(a) - ticketNumberSortValue(b)));
        lines.push({ ticketList: ticketList ? `${label} (${ticketList})` : label, poAfe: '', totalAmount: amount, splitRate: rate, splitHours: hrs });
      }
    }
  }
  
  if (includeExpenses) {
    for (const t of tickets) {
      const rid = t.recordId;
      const exps = rid ? (expensesByRecordId.get(rid) ?? []) : [];
      for (const e of exps) {
        const amt = Math.round(e.quantity * e.rate * 100) / 100;
        if (amt > 0) lines.push({ ticketList: formatInvoiceExpenseLineLabel(e), poAfe: '', totalAmount: amt, splitRate: e.rate, splitHours: e.quantity });
      }
    }
  }
  return lines;
}

function getRateCodeLocal(rateType?: string): 'RT' | 'TT' | 'FT' | 'OT' {
  const map: Record<string, 'RT' | 'TT' | 'FT' | 'OT'> = {
    'Shop Time': 'RT', 'Travel Time': 'TT', 'Field Time': 'FT', 'Shop Overtime': 'OT', 'Field Overtime': 'OT',
  };
  return map[rateType || ''] || 'RT';
}

function roundToNearest025(h: number): number { return Math.ceil(h * 4) / 4; }

export default function Invoices() {
  const { user, isAdmin } = useAuth();
  const { isDemoMode } = useDemoMode();
  const queryClient = useQueryClient();

  const [exportProgress, setExportProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [qboProgress, setQboProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [qboError, setQboError] = useState<string | null>(null);
  const [qboCreatedIds, setQboCreatedIds] = useState<string[]>([]);
  const [downloadingCustomRange, setDownloadingCustomRange] = useState(false);

  // Date range filter - matches Service Tickets Approved tab (only show tickets in this range)
  const [startDate, setStartDate] = useState('2026-01-01');
  const [endDate, setEndDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [calendarOpen, setCalendarOpen] = useState(false);

  const [selectedCustomerId, setSelectedCustomerId] = useState<string>(() => {
    try { return localStorage.getItem('ionex-inv-customer') || ''; } catch { return ''; }
  });
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => {
    try { return localStorage.getItem('ionex-inv-project') || ''; } catch { return ''; }
  });
  const defaultGrouping: DateRangeGrouping = 'bi-weekly';

  useEffect(() => { try { localStorage.setItem('ionex-inv-customer', selectedCustomerId); } catch {} }, [selectedCustomerId]);
  useEffect(() => { try { localStorage.setItem('ionex-inv-project', selectedProjectId); } catch {} }, [selectedProjectId]);

  const qboApiLocal = isQuickBooksApiLocal();
  const { data: qboConnected } = useQuery({
    queryKey: ['qboStatus'],
    queryFn: () => quickbooksClientService.checkStatus(),
    enabled: isAdmin && !qboApiLocal,
  });
  const effectiveQboConnected = qboApiLocal ? false : (qboConnected ?? false);

  // Fetch approved tickets ready for export (filtered by date range to match Service Tickets Approved tab)
  const { data: approvedRecords, isLoading: loadingApproved } = useQuery({
    queryKey: ['ticketsReadyForExport', isDemoMode, startDate, endDate],
    queryFn: () =>
      serviceTicketsService.getTicketsReadyForExport(isDemoMode, {
        startDate,
        endDate,
      }),
    enabled: isAdmin && !!startDate && !!endDate,
  });

  // Fetch billable entries
  const { data: billableEntries } = useQuery({
    queryKey: ['billableEntriesForInvoices', startDate, endDate, isDemoMode],
    queryFn: () =>
      serviceTicketsService.getBillableEntries({
        startDate,
        endDate,
        isDemoMode,
      }),
    enabled: isAdmin && !!startDate && !!endDate,
  });

  const { data: customers } = useQuery({
    queryKey: ['customers'],
    queryFn: () => customersService.getAll(),
  });

  const { data: allWorkflows = [] } = useQuery<InvoiceWorkflowRow[]>({
    queryKey: ['invoiceWorkflows'],
    queryFn: invoiceWorkflowsService.getAll,
  });

  const defaultWorkflow = useMemo(() => allWorkflows.find((w) => w.is_default) ?? allWorkflows[0], [allWorkflows]);

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => projectsService.getAll(),
  });

  /**
   * Resolution order: project.invoice_workflow_id → customer.invoice_workflow_id → system default.
   * projectNumber matches projects.project_number (case-insensitive, trimmed).
   */
  const getWorkflowForCustomer = useCallback(
    (customerName: string | undefined, projectNumber?: string | undefined): InvoiceWorkflowRow | undefined => {
      if (allWorkflows.length === 0) return defaultWorkflow;
      const pn = projectNumber?.trim().toLowerCase();
      if (pn) {
        const proj = projects?.find(
          (p: { project_number?: string | null; invoice_workflow_id?: string | null }) =>
            (p.project_number ?? '').trim().toLowerCase() === pn
        );
        if (proj?.invoice_workflow_id) {
          return allWorkflows.find((w) => w.id === proj.invoice_workflow_id) ?? defaultWorkflow;
        }
      }
      if (!customerName) return defaultWorkflow;
      const cust = customers?.find((c: any) => c.name === customerName);
      if (cust?.invoice_workflow_id) {
        return allWorkflows.find((w) => w.id === cust.invoice_workflow_id) ?? defaultWorkflow;
      }
      return defaultWorkflow;
    },
    [customers, projects, allWorkflows, defaultWorkflow]
  );

  /** A workflow that includes a 'submitted_approval' status drives the multi-step Portal Approval flow. */
  const isPortalApprovalWorkflow = useCallback(
    (wf: InvoiceWorkflowRow | undefined) =>
      !!wf?.statuses?.some((s) => s.id === 'submitted_approval'),
    []
  );

  const getGroupingForCustomer = useCallback(
    (customerId: string) => {
      const customer = customers?.find((c: { id: string; name?: string; invoice_date_grouping?: string }) => c.id === customerId);
      if (customer?.invoice_date_grouping) return customer.invoice_date_grouping as DateRangeGrouping;
      return defaultGrouping;
    },
    [customers, defaultGrouping]
  );

  const getGroupingForTicket = useCallback(
    (customerId: string, projectId: string) => {
      if (projectId) {
        const project = projects?.find((p: { id: string; invoice_date_grouping?: string }) => p.id === projectId);
        if (project?.invoice_date_grouping) return project.invoice_date_grouping as DateRangeGrouping;
      }
      return getGroupingForCustomer(customerId);
    },
    [projects, getGroupingForCustomer]
  );

  const { data: employees } = useQuery({
    queryKey: ['employees'],
    queryFn: () => employeesService.getAll(),
  });

  const loadInvoicedBatchMarks = !!user && !isDemoMode && canAccessInvoices(user);

  const { data: invoicedMarkRows = [] } = useQuery({
    queryKey: ['invoicedBatchMarks'],
    queryFn: () => invoicedBatchMarksService.getAll(),
    enabled: loadInvoicedBatchMarks,
  });

  /** All ticket IDs (service_tickets.id / recordId) that belong to ANY invoiced batch mark in DB.
   *  Used to permanently exclude invoiced tickets from re-grouping so grouping changes never affect them. */
  const allInvoicedTicketIds = useMemo(() => {
    const set = new Set<string>();
    for (const row of invoicedMarkRows) {
      const ids = row.key_snapshot?.ticketIds;
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        const trimmed = typeof id === 'string' ? id.trim() : String(id ?? '').trim();
        if (trimmed) set.add(trimmed);
      }
    }
    return set;
  }, [invoicedMarkRows]);

  // Build full tickets from billable entries + approved records (same logic as ServiceTickets)
  // approvedRecords is already filtered by date range to match Service Tickets Approved tab
  const tickets = useMemo(() => {
    const baseTickets = billableEntries ? groupEntriesIntoTickets(billableEntries, employees) : [];
    const approved = (approvedRecords || []) as ApprovedRecord[];
    if (approved.length === 0) return [];

    const ticketList: (ServiceTicket & { recordId?: string; headerOverrides?: unknown; recordProjectId?: string })[] = [];

    const getRecordGroupingKey = (r: ApprovedRecord) => {
      const ov = (r.header_overrides as Record<string, string> | null) ?? {};
      return buildGroupingKey(ov.po_afe ?? '');
    };
    const getRecordBillingKey = (r: ApprovedRecord) => {
      const ov = (r.header_overrides as Record<string, string> | null) ?? {};
      return buildBillingKey(ov.approver ?? '', ov.po_afe ?? '', ov.cc ?? '');
    };
    const getTicketFullBillingKey = (bt: ServiceTicket) => {
      const approver = bt.entryApprover ?? bt.entries?.[0]?.approver ?? bt.projectApprover ?? '';
      const poAfe = bt.entryPoAfe ?? bt.entries?.[0]?.po_afe ?? bt.projectPoAfe ?? '';
      const cc = bt.entryCc ?? (bt.entries?.[0] as any)?.cc ?? bt.projectCc ?? '';
      return buildBillingKey(approver, poAfe, cc);
    };
    // Add tickets that match approved records (from base or standalone).
    // Each baseTicket can only match ONE approved record to avoid double-counting hours
    // when multiple approved records share the same date+user+customer+project.
    const usedBaseTicketIds = new Set<string>();
    for (const rec of approved) {
      const recGroupingKey = getRecordGroupingKey(rec);
      const recBillingKey = getRecordBillingKey(rec);
      const match = baseTickets.find(
        (bt) => {
          if (usedBaseTicketIds.has(bt.id)) return false; // Already matched to another approved record
          if (bt.date !== rec.date || bt.userId !== rec.user_id) return false;
          if (bt.customerId !== rec.customer_id && !(rec.customer_id == null && bt.customerId === 'unassigned')) return false;
          if ((bt.projectId || '') !== (rec.project_id || '')) return false;
          const btGroupingKey = bt.id ? getTicketBillingKey(bt.id) : '_::_::_';
          const btFullKey = getTicketFullBillingKey(bt);
          return recBillingKey === btFullKey || recGroupingKey === btGroupingKey || recGroupingKey === '_::_::_';
        }
      );

      if (match) {
        usedBaseTicketIds.add(match.id);
        const proj = projects?.find((p: { id: string }) => p.id === (rec.project_id ?? match.projectId));
        let ticketToUse = match;
        const pdfAugment = augmentMatchTicketForInvoicePdf(rec, match);
        if (pdfAugment && pdfAugment.entries && pdfAugment.entries.length > 0) {
          ticketToUse = {
            ...match,
            hoursByRateType: pdfAugment.hoursByRateType ?? match.hoursByRateType,
            totalHours: pdfAugment.totalHours ?? match.totalHours,
            entries: pdfAugment.entries,
          };
        } else {
          // Augment couldn't build from match (empty match.entries, etc). Fall back to rec data.
          const fromRec = buildEntriesFromRecOnly(rec, match.date, match.userId, rec.project_id ?? match.projectId);
          if (fromRec) {
            ticketToUse = {
              ...match,
              hoursByRateType: fromRec.hoursByRateType,
              totalHours: fromRec.totalHours,
              entries: fromRec.entries,
            };
          }
        }
        const pf = getProjectHeaderFields(proj);
        const rawTicket: ServiceTicket & { recordId?: string; headerOverrides?: unknown; recordProjectId?: string } = {
          ...ticketToUse,
          ticketNumber: rec.ticket_number,
          recordId: rec.id,
          headerOverrides: rec.header_overrides,
          recordProjectId: rec.project_id ?? match.projectId,
          projectApproverPoAfe: getProjectApproverPoAfe(proj) || match.projectApproverPoAfe,
          projectApprover: pf.approver || ticketToUse.projectApprover,
          projectPoAfe: pf.poAfe || ticketToUse.projectPoAfe,
          projectCc: pf.cc || ticketToUse.projectCc,
        };
        const isUninvoiced = !allInvoicedTicketIds.has(rec.id);
        const ticketWithOverrides = applyHeaderOverridesToTicket(rawTicket, rec.header_overrides ?? undefined, isUninvoiced);
        ticketList.push({ ...ticketWithOverrides, recordId: rec.id, headerOverrides: rec.header_overrides, recordProjectId: rawTicket.recordProjectId });
      } else {
        // Standalone ticket (no matching billable entries)
        const editedHours = (rec.edited_hours as Record<string, number | number[]>) || {};
        const hoursByRateType: ServiceTicket['hoursByRateType'] = {
          'Shop Time': 0,
          'Shop Overtime': 0,
          'Travel Time': 0,
          'Field Time': 0,
          'Field Overtime': 0,
        };
        Object.keys(editedHours).forEach((rateType) => {
          const hours = editedHours[rateType];
          if (rateType in hoursByRateType) {
            (hoursByRateType as Record<string, number>)[rateType] = Array.isArray(hours)
              ? hours.reduce((s: number, h: number) => s + (h || 0), 0)
              : (hours as number) || 0;
          }
        });
        let totalHours = Object.values(hoursByRateType).reduce((s, h) => s + h, 0);
        // When edited_hours is empty, use total_hours from the service_ticket record
        if (totalHours === 0 && rec.total_hours != null) {
          const th = typeof rec.total_hours === 'string' ? parseFloat(rec.total_hours) : rec.total_hours;
          if (!isNaN(th) && th > 0) {
            totalHours = th;
            hoursByRateType['Shop Time'] = th;
          }
        }
        // Build entries from saved rec data so per-ticket PDF preserves descriptions
        // (without entries the PDF falls back to "Work performed").
        const standaloneFromRec = buildEntriesFromRecOnly(
          rec,
          rec.date,
          rec.user_id,
          rec.project_id ?? undefined
        );
        const standaloneEntries: ServiceTicket['entries'] = standaloneFromRec?.entries ?? [];
        if (standaloneFromRec) {
          (Object.keys(standaloneFromRec.hoursByRateType) as Array<keyof ServiceTicket['hoursByRateType']>).forEach((rt) => {
            (hoursByRateType as Record<string, number>)[rt] = standaloneFromRec.hoursByRateType[rt];
          });
          totalHours = standaloneFromRec.totalHours;
        }
        const customer = customers?.find((c: { id: string }) => c.id === rec.customer_id);
        const customerName = customer?.name || 'Unknown Customer';
        const emp = employees?.find((e: { user_id: string }) => e.user_id === rec.user_id) as { rt_rate?: number; tt_rate?: number; ft_rate?: number; shop_ot_rate?: number; field_ot_rate?: number; user?: { first_name?: string; last_name?: string } } | undefined;
        const u = emp?.user;
        const firstName = u?.first_name || '';
        const lastName = u?.last_name || '';
        const userName = `${firstName} ${lastName}`.trim() || 'Unknown';
        const userInitials = firstName && lastName ? `${firstName[0]}${lastName[0]}`.toUpperCase() : 'XX';
        const proj = projects?.find((p: { id: string }) => p.id === rec.project_id);
        const projFields = proj ? getProjectHeaderFields(proj) : { approver: '', poAfe: '', cc: '', other: '' };
        const DEFAULT_RATES = { rt: 110, tt: 85, ft: 140, shop_ot: 165, field_ot: 165 };
        const rates = emp
          ? {
              rt: emp.rt_rate ?? DEFAULT_RATES.rt,
              tt: emp.tt_rate ?? DEFAULT_RATES.tt,
              ft: emp.ft_rate ?? DEFAULT_RATES.ft,
              shop_ot: emp.shop_ot_rate ?? DEFAULT_RATES.shop_ot,
              field_ot: emp.field_ot_rate ?? DEFAULT_RATES.field_ot,
            }
          : DEFAULT_RATES;
        const recLocation = rec.location || '';
        const rawStandalone: ServiceTicket & { recordId?: string; headerOverrides?: unknown; recordProjectId?: string } = {
          id: `${rec.date}-${rec.customer_id}-${rec.user_id}-${recLocation}`,
          date: rec.date,
          customerId: rec.customer_id || 'unassigned',
          customerName,
          location: recLocation || undefined,
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
            service_location: customer?.service_location,
          },
          userId: rec.user_id,
          userName,
          userInitials,
          ticketNumber: rec.ticket_number,
          totalHours,
          entries: standaloneEntries,
          hoursByRateType,
          rates,
          recordId: rec.id,
          headerOverrides: rec.header_overrides,
          recordProjectId: rec.project_id ?? undefined,
          projectId: rec.project_id ?? undefined,
          projectName: proj?.name,
          projectNumber: proj?.project_number,
          projectLocation: proj?.location,
          projectApproverPoAfe: getProjectApproverPoAfe(proj) || undefined,
          projectApprover: projFields.approver || undefined,
          projectPoAfe: projFields.poAfe || undefined,
          projectCc: projFields.cc || undefined,
          projectOther: proj?.other,
        };
        const isUninvoiced = !allInvoicedTicketIds.has(rec.id);
        const standaloneWithOverrides = applyHeaderOverridesToTicket(rawStandalone, rec.header_overrides ?? undefined, isUninvoiced);
        ticketList.push({ ...standaloneWithOverrides, recordId: rec.id, headerOverrides: rec.header_overrides, recordProjectId: rawStandalone.recordProjectId });
      }
    }

    return ticketList;
  }, [billableEntries, employees, approvedRecords, customers, projects]);

  const ticketsForCustomer = useMemo(() => {
    let list = tickets;
    if (selectedCustomerId) list = list.filter((t) => t.customerId === selectedCustomerId);
    if (selectedProjectId) list = list.filter((t) => (t.recordProjectId ?? t.projectId) === selectedProjectId);
    return list;
  }, [tickets, selectedCustomerId, selectedProjectId]);

  const selectedCustomer = customers?.find((c: { id: string }) => c.id === selectedCustomerId);
  const isCNRL = !!selectedCustomerId && (selectedCustomer?.name ?? '').toUpperCase().includes('CNRL');

  // When a customer is selected, only show projects for that customer in the Project dropdown
  const projectsForFilter = useMemo(() => {
    const list = projects ?? [];
    if (!selectedCustomerId) return list;
    return list.filter((p: { customer_id?: string | null }) => (p.customer_id ?? '') === selectedCustomerId);
  }, [projects, selectedCustomerId]);

  // Clear project selection if it no longer belongs to the selected customer
  useEffect(() => {
    if (selectedProjectId && selectedCustomerId && !projectsForFilter.some((p: { id: string }) => p.id === selectedProjectId)) {
      setSelectedProjectId('');
    }
  }, [selectedCustomerId, selectedProjectId, projectsForFilter]);

  const isTicketCnrl = useCallback(
    (ticket: ServiceTicket) =>
      (customers?.find((c: { id: string }) => c.id === ticket.customerId)?.name ?? '').toUpperCase().includes('CNRL'),
    [customers]
  );

  const projectFilterCustomerIsCnrl = useMemo(() => {
    if (!selectedProjectId) return false;
    const proj = projects?.find((p: { id: string; customer_id?: string | null }) => p.id === selectedProjectId);
    const cid = proj?.customer_id;
    if (!cid) return false;
    return (customers?.find((c: { id: string; name?: string }) => c.id === cid)?.name ?? '')
      .toUpperCase()
      .includes('CNRL');
  }, [selectedProjectId, projects, customers]);

  const invoiceFilterProject = useMemo(() => {
    if (!selectedProjectId) return undefined;
    return projects?.find((p: { id: string }) => p.id === selectedProjectId);
  }, [selectedProjectId, projects]);

  // Fetch expenses for all tickets (uninvoiced + invoiced)
  const [expensesByRecordId, setExpensesByRecordId] = useState<Map<string, InvoiceExpenseLine[]>>(new Map());
  useEffect(() => {
    const recordIds = new Set<string>();
    for (const t of ticketsForCustomer) {
      const rid = (t as ServiceTicket & { recordId?: string }).recordId;
      if (rid) recordIds.add(rid);
    }
    if (recordIds.size === 0) {
      setExpensesByRecordId(new Map());
      return;
    }
    let cancelled = false;
    const fetchAll = async () => {
      const map = new Map<string, InvoiceExpenseLine[]>();
      await Promise.all(
        [...recordIds].map(async (rid) => {
          try {
            const exp = await serviceTicketExpensesService.getByTicketId(rid);
            if (!cancelled) {
              map.set(
                rid,
                exp.map((e) => ({
                  quantity: e.quantity,
                  rate: e.rate,
                  gst: Number((e as { gst?: number }).gst) || 0,
                  description: e.description,
                  expense_type: e.expense_type,
                }))
              );
            }
          } catch {
            if (!cancelled) map.set(rid, []);
          }
        })
      );
      if (!cancelled) setExpensesByRecordId(map);
    };
    fetchAll();
    return () => { cancelled = true; };
  }, [ticketsForCustomer]);

  const [exportingGroupIdx, setExportingGroupIdx] = useState<string | null>(null);

  /** Pre–DB marks only; entries are removed once present in invoiced_batch_marks */
  const [legacyMarkedInvoicedIds, setLegacyMarkedInvoicedIds] = useState<Set<string>>(() =>
    readMarkedInvoiceIdsFromLocalStorage()
  );

  // Invoiced group IDs from DB (uploaded PDFs) — syncs across devices
  const { data: invoicedGroupIdsFromDb = [] } = useQuery({
    queryKey: ['invoicedBatchInvoices', 'allGroupIds'],
    queryFn: () => invoicedBatchInvoicesService.getAllInvoicedGroupIds(),
  });

  const dbMarkedIdSet = useMemo(
    () => new Set(invoicedMarkRows.map((r) => r.group_id)),
    [invoicedMarkRows]
  );

  useEffect(() => {
    setLegacyMarkedInvoicedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of prev) {
        if (dbMarkedIdSet.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      if (changed) persistMarkedInvoiceIdsToLocalStorage(next);
      return changed ? next : prev;
    });
  }, [dbMarkedIdSet]);

  // Effective = DB marks ∪ linked PDF rows ∪ legacy localStorage (until migrated off)
  const effectiveMarkedInvoicedIds = useMemo(() => {
    const set = new Set<string>();
    for (const id of legacyMarkedInvoicedIds) set.add(id);
    for (const id of dbMarkedIdSet) set.add(id);
    invoicedGroupIdsFromDb.forEach((id) => set.add(id));
    return set;
  }, [legacyMarkedInvoicedIds, dbMarkedIdSet, invoicedGroupIdsFromDb]);

  type InvoiceTab = 'pending' | 'ready' | 'submitted' | 'approved' | 'portal_submission' | 'invoiced' | 'settings';
  const [activeTab, setActiveTab] = useState<InvoiceTab>('pending');
  const [didAutoPickInitialTab, setDidAutoPickInitialTab] = useState(false);
  const showInvoiced = activeTab === 'invoiced';
  const setShowInvoiced = (v: boolean) => setActiveTab(v ? 'invoiced' : 'pending');
  const [invoiceSearchQuery, setInvoiceSearchQuery] = useState('');
  const [invoiceStatusFilter, setInvoiceStatusFilter] = useState<string>('all');
  const [invoiceTicketModalTicket, setInvoiceTicketModalTicket] = useState<InvoiceTicketModalTicket | null>(null);
  const [editTicketRecordId, setEditTicketRecordId] = useState<string | null>(null);
  const [invoicedBreakdownExpanded, setInvoicedBreakdownExpanded] = useState<Set<string>>(new Set());
  const [combinedExpenseGroupIds, setCombinedExpenseGroupIds] = useState<Set<string>>(new Set());
  const [splitRateGroupIds, setSplitRateGroupIds] = useState<Set<string>>(new Set());
  const [pendingLabourNotes, setPendingLabourNotes] = useState<Record<string, Record<string, string>>>({});
  const [applyLabourNotesToSimilarBatches, setApplyLabourNotesToSimilarBatches] = useState(false);
  const [invoiceFilesByGroupId, setInvoiceFilesByGroupId] = useState<Record<string, File>>({});
  const [downloadingWithInvoiceGroupId, setDownloadingWithInvoiceGroupId] = useState<string | null>(null);
  const [uploadingInvoiceGroupId, setUploadingInvoiceGroupId] = useState<string | null>(null);
  const [markInvoicedDropOverGroupId, setMarkInvoicedDropOverGroupId] = useState<string | null>(null);
  const [markInvoicedPromptGroup, setMarkInvoicedPromptGroup] = useState<{ key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] } | null>(null);
  const [bulkSendProgress, setBulkSendProgress] = useState<{ customer: string; current: number; total: number } | null>(null);
  const [redownloadingApprovalId, setRedownloadingApprovalId] = useState<string | null>(null);
  const [undoApprovalConfirm, setUndoApprovalConfirm] = useState<{
    persistId: string;
    customerName: string;
    projectLine: string;
    periodLine: string;
    ticketCount: number;
    /** 'submitted' = currently Submitted, undo → Ready (full unmark). 'approved' = currently Approved, undo → Submitted (delete approval PDF + revert status). */
    scope: 'submitted' | 'approved';
    workflowId?: string;
  } | null>(null);
  /** Bulk undo confirmation for an entire grouped section (multiple approver batches at once). */
  const [undoBulkApprovalConfirm, setUndoBulkApprovalConfirm] = useState<{
    sectionKey: string;
    customerName: string;
    projectLine: string;
    periodLine: string;
    scope: 'submitted' | 'approved';
    batches: Array<{ persistId: string; approver: string | null; workflowId?: string }>;
  } | null>(null);
  /** Section key currently building a bulk download (only one at a time across all tabs). */
  const [bulkDownloadingSectionKey, setBulkDownloadingSectionKey] = useState<string | null>(null);
  const [editingLabourNotesGroupId, setEditingLabourNotesGroupId] = useState<string | null>(null);
  const [editingLabourNotes, setEditingLabourNotes] = useState<Record<string, string>>({});
  const [editingPeriodModal, setEditingPeriodModal] = useState<{
    projectId: string | null;
    customerId: string | null;
    value: string;
  } | null>(null);

  const updatePeriodGroupingMutation = useMutation({
    mutationFn: async ({ projectId, customerId, value }: { projectId: string | null; customerId: string | null; value: string }) => {
      if (projectId) {
        return projectsService.update(projectId, { invoice_date_grouping: value || null });
      } else if (customerId) {
        return customersService.update(customerId, { invoice_date_grouping: value || null });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setEditingPeriodModal(null);
    },
  });

  const updateWorkflowAssignmentMutation = useMutation({
    mutationFn: async ({ projectId, customerId, workflowId }: { projectId: string | null; customerId: string | null; workflowId: string | null }) => {
      if (projectId) {
        return projectsService.update(projectId, { invoice_workflow_id: workflowId });
      } else if (customerId) {
        return customersService.update(customerId, { invoice_workflow_id: workflowId });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
  });

  const [settingsTab, setSettingsTab] = useState<'customers' | 'projects'>('customers');
  const [settingsSearch, setSettingsSearch] = useState('');

  const markProjectCompletedMutation = useMutation({
    mutationFn: (projectId: string) => projectsService.update(projectId, { status: 'completed' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const [frozenInvoicedGroups, setFrozenInvoicedGroups] = useState<Record<string, FrozenGroupSnapshot>>(() => {
    try {
      const raw = localStorage.getItem(FROZEN_INVOICED_GROUPS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, FrozenGroupSnapshot>;
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
      }
    } catch {
      // ignore
    }
    return {};
  });

  const uninvoicedTicketsForCustomer = useMemo(() => {
    if (allInvoicedTicketIds.size === 0) return ticketsForCustomer;
    return ticketsForCustomer.filter((t) => {
      const rid = (t as ServiceTicket & { recordId?: string }).recordId?.trim();
      if (rid && allInvoicedTicketIds.has(rid)) return false;
      if (allInvoicedTicketIds.has(t.id)) return false;
      return true;
    });
  }, [ticketsForCustomer, allInvoicedTicketIds]);

  // Group ONLY uninvoiced tickets. Invoiced tickets are reconstructed from DB snapshots separately
  // so grouping mode changes never affect already-invoiced batches.
  const groupedTickets = useMemo((): { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] }[] => {
    const ticketsToGroupCnrl: ServiceTicket[] = [];
    const ticketsToGroupByPeriod: ServiceTicket[] = [];
    if (selectedCustomerId) {
      if (isCNRL) {
        ticketsToGroupCnrl.push(...uninvoicedTicketsForCustomer);
      } else {
        ticketsToGroupByPeriod.push(...uninvoicedTicketsForCustomer);
      }
    } else {
      for (const t of uninvoicedTicketsForCustomer) {
        if (isTicketCnrl(t)) ticketsToGroupCnrl.push(t);
        else ticketsToGroupByPeriod.push(t);
      }
    }

    const result: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] }[] = [];

    if (ticketsToGroupCnrl.length > 0) {
      const groups = new Map<string, ServiceTicket[]>();
      const singleCustomer = !!selectedCustomerId;
      for (const ticket of ticketsToGroupCnrl) {
        const t = ticket as ServiceTicket & { headerOverrides?: unknown; recordProjectId?: string };
        const keyObj = getInvoiceGroupKey(
          {
            projectId: t.recordProjectId ?? t.projectId,
            projectName: t.projectName,
            projectNumber: t.projectNumber,
            location: t.location,
            projectApprover: t.projectApprover,
            projectPoAfe: t.projectPoAfe,
            projectCc: t.projectCc,
            projectApproverPoAfe: t.projectApproverPoAfe,
            projectLocation: t.projectLocation,
            projectOther: t.projectOther,
            customerInfo: t.customerInfo,
            entryApprover: t.entryApprover,
            entryPoAfe: t.entryPoAfe,
            entryCc: t.entryCc,
            entries: t.entries,
          },
          t.headerOverrides as { approver_po_afe?: string; approver?: string; po_afe?: string; cc?: string; other?: string; service_location?: string } | undefined
        );
        if (!keyObj.approverCode || keyObj.approverCode === '_') continue;
        const customerIdForGrouping = singleCustomer ? selectedCustomerId! : (t.customerId ?? '');
        const projectIdForGrouping = keyObj.projectId ?? (t as ServiceTicket & { recordProjectId?: string }).recordProjectId ?? t.projectId ?? '';
        const groupingRaw = getGroupingForTicket(customerIdForGrouping, projectIdForGrouping);
        const grouping = cnrlPeriodGrouping(groupingRaw);
        const periodKey = getPeriodKey(t.date ?? '', grouping, projectIdForGrouping);
        const groupKey = `${keyObj.projectId ?? ''}|${keyObj.approverCode}|${periodKey}`;
        const list = groups.get(groupKey) ?? [];
        list.push(ticket);
        groups.set(groupKey, list);
      }
      const sortedGroupKeys = [...groups.keys()].sort((a, b) => {
        const pa = a.split('|');
        const pb = b.split('|');
        const projA = pa[0] ?? '';
        const approverA = pa[1] ?? '';
        const periodA = pa[2] ?? '';
        const projB = pb[0] ?? '';
        const approverB = pb[1] ?? '';
        const periodB = pb[2] ?? '';
        if (approverA !== approverB) return approverA.localeCompare(approverB);
        if (periodA !== periodB) return periodA.localeCompare(periodB);
        return projA.localeCompare(projB);
      });
      for (const groupKey of sortedGroupKeys) {
        const list = groups.get(groupKey) ?? [];
        list.sort((a, b) => {
          const dateCmp = (a.date || '').localeCompare(b.date || '');
          if (dateCmp !== 0) return dateCmp;
          const ta = a as ServiceTicket & { headerOverrides?: { approver?: string; po_afe?: string; cc?: string } };
          const tb = b as ServiceTicket & { headerOverrides?: { approver?: string; po_afe?: string; cc?: string } };
          const { poAfe: poAfeA } = getApproverPoAfeCcFromTicket(ta, ta.headerOverrides);
          const { poAfe: poAfeB } = getApproverPoAfeCcFromTicket(tb, tb.headerOverrides);
          const poCmp = (poAfeA || '').localeCompare(poAfeB || '');
          if (poCmp !== 0) return poCmp;
          const nameCmp = (a.userName || '').localeCompare(b.userName || '');
          if (nameCmp !== 0) return nameCmp;
          return ticketNumberSortValue(a.ticketNumber) - ticketNumberSortValue(b.ticketNumber);
        });
        const first = list[0] as ServiceTicket & { headerOverrides?: unknown; recordProjectId?: string };
        const keyObj = getInvoiceGroupKey(
          {
            projectId: first.recordProjectId ?? first.projectId,
            projectName: first.projectName,
            projectNumber: first.projectNumber,
            location: first.location,
            projectApprover: first.projectApprover,
            projectPoAfe: first.projectPoAfe,
            projectCc: first.projectCc,
            projectApproverPoAfe: first.projectApproverPoAfe,
            projectLocation: first.projectLocation,
            projectOther: first.projectOther,
            customerInfo: first.customerInfo,
            entryApprover: first.entryApprover,
            entryPoAfe: first.entryPoAfe,
            entryCc: first.entryCc,
            entries: first.entries,
          },
          first.headerOverrides as { approver_po_afe?: string; approver?: string; po_afe?: string; cc?: string; other?: string; service_location?: string } | undefined
        );
        const parts = groupKey.split('|');
        const periodKeyFromKey = parts[2] ?? '';
        const customerIdForLabel = singleCustomer ? selectedCustomerId! : (first.customerId ?? '');
        const projectIdForLabel = first.recordProjectId ?? first.projectId ?? '';
        const groupingRaw = getGroupingForTicket(customerIdForLabel, projectIdForLabel);
        const grouping = cnrlPeriodGrouping(groupingRaw);
        const periodLabel = getPeriodLabel(periodKeyFromKey, grouping);
        const keyWithPeriod: InvoiceGroupKeyWithPeriod = {
          ...keyObj,
          periodKey: periodKeyFromKey,
          periodLabel,
        };
        result.push({ key: keyWithPeriod, tickets: list });
      }
    }

    if (ticketsToGroupByPeriod.length > 0) {
      const groupMap = new Map<string, ServiceTicket[]>();
      const singleCustomer = !!selectedCustomerId;
      for (const ticket of ticketsToGroupByPeriod) {
        const t = ticket as ServiceTicket & { recordProjectId?: string };
        const projectId = t.recordProjectId ?? t.projectId ?? '';
        const customerIdForGrouping = singleCustomer ? selectedCustomerId! : (t.customerId ?? '');
        const grouping = getGroupingForTicket(customerIdForGrouping, projectId);
        const periodKey = getPeriodKey(t.date ?? '', grouping, projectId);
        const groupKey = singleCustomer ? `${projectId}|${periodKey}` : `${t.customerId ?? ''}|${projectId}|${periodKey}`;
        const list = groupMap.get(groupKey) ?? [];
        list.push(ticket);
        groupMap.set(groupKey, list);
      }
      const sortedKeys = [...groupMap.keys()].sort((a, b) => a.localeCompare(b));
      for (const groupKey of sortedKeys) {
        const list = groupMap.get(groupKey) ?? [];
        list.sort((a, b) => {
          const dateCmp = (a.date || '').localeCompare(b.date || '');
          if (dateCmp !== 0) return dateCmp;
          const nameCmp = (a.userName || '').localeCompare(b.userName || '');
          if (nameCmp !== 0) return nameCmp;
          return ticketNumberSortValue(a.ticketNumber) - ticketNumberSortValue(b.ticketNumber);
        });
        const first = list[0] as ServiceTicket & { recordProjectId?: string };
        const parts = groupKey.split('|');
        const periodKey = singleCustomer ? parts[1]! : parts[2]!;
        const customerIdForLabel = singleCustomer ? selectedCustomerId : (parts[0] ?? '');
        const projectIdFromKey = singleCustomer ? parts[0]! : parts[1]!;
        const grouping = getGroupingForTicket(customerIdForLabel, projectIdFromKey);
        let periodLabel = getPeriodLabel(periodKey, grouping);
        if (grouping === 'project-completion') {
          const lbl = [first.projectNumber, first.projectName].filter(Boolean).join(' – ');
          periodLabel = lbl ? `Project batch: ${lbl}` : 'Project completion';
        }
        if (grouping === 'progress') {
          const lbl = [first.projectNumber, first.projectName].filter(Boolean).join(' – ');
          periodLabel = lbl ? `Progress batch: ${lbl}` : 'Progress batch';
        }
        const keyObj: InvoiceGroupKeyWithPeriod = {
          projectId: first.recordProjectId ?? first.projectId ?? projectIdFromKey,
          projectName: first.projectName,
          projectNumber: first.projectNumber,
          approverCode: periodKey,
          approver: periodLabel,
          poAfe: '',
          location: '',
          cc: '',
          other: '',
          periodKey,
          periodLabel,
        };
        result.push({ key: keyObj, tickets: list });
      }
    }

    result.sort((a, b) => {
      const minDate = (tickets: ServiceTicket[]) =>
        tickets.reduce((min, t) => (t.date && t.date < min ? t.date : min), '\uffff');
      const pendingA = uninvoicedGroupPeriodStillAccumulating(a, getGroupingForTicket);
      const pendingB = uninvoicedGroupPeriodStillAccumulating(b, getGroupingForTicket);
      if (pendingA !== pendingB) return pendingA ? 1 : -1;
      const custA = a.tickets[0]?.customerName ?? a.tickets[0]?.customerId ?? '';
      const custB = b.tickets[0]?.customerName ?? b.tickets[0]?.customerId ?? '';
      const custCmp = custA.localeCompare(custB);
      if (custCmp !== 0) return custCmp;
      return minDate(a.tickets).localeCompare(minDate(b.tickets));
    });

    return result;
  }, [uninvoicedTicketsForCustomer, selectedCustomerId, isCNRL, selectedProjectId, getGroupingForTicket, isTicketCnrl]);

  /**
   * PDF rows (invoiced_batch_invoices) used to be written before the mark; some environments may have
   * invoice PDFs without invoiced_batch_marks rows. Heal by upserting a mark so Service Tickets + DB
   * triggers get ticketIds. Uses frozen snapshots or legacy `approver|uuid,uuid` group_ids.
   */
  useEffect(() => {
    if (isDemoMode || !isAdmin || !user) return;
    const missing = invoicedGroupIdsFromDb.filter((id) => !dbMarkedIdSet.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      let healed = false;
      for (const gid of missing) {
        if (cancelled) break;
        let snapshot: FrozenGroupSnapshot | null = null;
        const frozenSnap = frozenInvoicedGroups[gid];
        if (frozenSnap) {
          snapshot = frozenSnap;
        } else {
          const parsed = parseTicketIdsFromLegacyNonPeriodGroupId(gid);
          if (parsed && parsed.length > 0) {
            const ac = gid.slice(0, gid.indexOf('|'));
            snapshot = {
              key: {
                projectId: '',
                approverCode: ac,
                approver: '',
                poAfe: '',
                location: '',
                cc: '',
                other: '',
              },
              ticketIds: parsed,
            };
          }
        }
        if (!snapshot) continue;
        try {
          await invoicedBatchMarksService.upsert(gid, snapshot);
          healed = true;
        } catch {
          // RLS or network; skip until next load
        }
      }
      if (!cancelled && healed) {
        await queryClient.invalidateQueries({ queryKey: ['invoicedBatchMarks'] });
        await queryClient.invalidateQueries({ queryKey: ['lockedServiceTicketIdsForMe'] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    isDemoMode,
    isAdmin,
    user,
    invoicedGroupIdsFromDb,
    dbMarkedIdSet,
    frozenInvoicedGroups,
    queryClient,
  ]);

  const setInvoiceFileForGroup = useCallback((groupId: string, file: File | null) => {
    setInvoiceFilesByGroupId((prev) => {
      const next = { ...prev };
      if (file) next[groupId] = file;
      else delete next[groupId];
      return next;
    });
  }, []);

  const markInvoicedMutation = useMutation({
    mutationFn: async ({ groupId, snapshot }: { groupId: string; snapshot: FrozenGroupSnapshot }) => {
      await invoicedBatchMarksService.upsert(groupId, snapshot);
    },
    onMutate: async ({ groupId, snapshot }) => {
      await queryClient.cancelQueries({ queryKey: ['invoicedBatchMarks'] });
      const previous = queryClient.getQueryData<InvoicedBatchMarkRow[]>(['invoicedBatchMarks']);
      queryClient.setQueryData<InvoicedBatchMarkRow[]>(['invoicedBatchMarks'], () => {
        const rest = (previous ?? []).filter((r) => r.group_id !== groupId);
        return [
          {
            group_id: groupId,
            key_snapshot: snapshot as unknown as InvoicedBatchMarkRow['key_snapshot'],
            marked_at: new Date().toISOString(),
            marked_by: null,
          },
          ...rest,
        ];
      });
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData(['invoicedBatchMarks'], ctx.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['invoicedBatchMarks'] });
      queryClient.invalidateQueries({ queryKey: ['lockedServiceTicketIdsForMe'] });
    },
  });

  const unmarkInvoicedMutation = useMutation({
    mutationFn: async (groupId: string) => {
      await invoicedBatchMarksService.deleteMark(groupId);
      try {
        await invoicedBatchInvoicesService.deleteInvoice(groupId);
      } catch {
        // No linked invoice PDF row
      }
    },
    onMutate: async (groupId) => {
      await queryClient.cancelQueries({ queryKey: ['invoicedBatchMarks'] });
      await queryClient.cancelQueries({ queryKey: ['invoicedBatchInvoices'] });
      const previousMarks = queryClient.getQueryData<InvoicedBatchMarkRow[]>(['invoicedBatchMarks']);
      queryClient.setQueryData<InvoicedBatchMarkRow[]>(['invoicedBatchMarks'], (prev) =>
        (prev ?? []).filter((r) => r.group_id !== groupId)
      );
      const previousInvoiceIds = queryClient.getQueryData<string[]>(['invoicedBatchInvoices', 'allGroupIds']);
      queryClient.setQueryData<string[]>(['invoicedBatchInvoices', 'allGroupIds'], (prev) =>
        (prev ?? []).filter((id) => id !== groupId)
      );
      return { previousMarks, previousInvoiceIds };
    },
    onError: (_err, _groupId, ctx) => {
      if (ctx?.previousMarks !== undefined) {
        queryClient.setQueryData(['invoicedBatchMarks'], ctx.previousMarks);
      }
      if (ctx?.previousInvoiceIds !== undefined) {
        queryClient.setQueryData(['invoicedBatchInvoices', 'allGroupIds'], ctx.previousInvoiceIds);
      }
    },
    onSuccess: (_data, groupId) => {
      setLegacyMarkedInvoicedIds((prev) => {
        const next = new Set(prev);
        next.delete(groupId);
        persistMarkedInvoiceIdsToLocalStorage(next);
        return next;
      });
      setFrozenInvoicedGroups((prev) => {
        if (!prev[groupId]) return prev;
        const next = { ...prev };
        delete next[groupId];
        try {
          localStorage.setItem(FROZEN_INVOICED_GROUPS_KEY, JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      });
      setInvoiceFileForGroup(groupId, null);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['invoicedBatchMarks'] });
      queryClient.invalidateQueries({ queryKey: ['invoicedBatchInvoices'] });
      queryClient.invalidateQueries({ queryKey: ['lockedServiceTicketIdsForMe'] });
    },
  });

  const updateBatchStatusMutation = useMutation({
    mutationFn: async ({ groupId, statusId, prevStatusId, statusLabel, customerName, projectNumber, workflowId }: {
      groupId: string; statusId: string; prevStatusId?: string;
      statusLabel: string; customerName?: string; projectNumber?: string; workflowId?: string;
    }) => {
      const row = invoicedMarkRows.find((r) => r.group_id === groupId);
      if (!row) return;
      const snap = (row.key_snapshot ?? {}) as FrozenGroupSnapshot;
      const now = new Date().toISOString();
      const updated = { ...snap, statusId, statusChangedAt: now };
      await invoicedBatchMarksService.upsert(groupId, updated as { key: unknown; ticketIds: string[] });
      if (prevStatusId) {
        await invoiceStatusHistoryService.closeEntry(groupId, prevStatusId).catch(() => {});
      }
      await invoiceStatusHistoryService.logEntry({
        group_id: groupId,
        customer_name: customerName,
        project_number: projectNumber,
        workflow_id: workflowId,
        status_id: statusId,
        status_label: statusLabel,
        entered_at: now,
      }).catch(() => {});
    },
    onMutate: async ({ groupId, statusId }) => {
      await queryClient.cancelQueries({ queryKey: ['invoicedBatchMarks'] });
      const previous = queryClient.getQueryData<InvoicedBatchMarkRow[]>(['invoicedBatchMarks']);
      const now = new Date().toISOString();
      queryClient.setQueryData<InvoicedBatchMarkRow[]>(['invoicedBatchMarks'], (prev) =>
        (prev ?? []).map((r) => {
          if (r.group_id !== groupId) return r;
          const snap = (r.key_snapshot ?? {}) as FrozenGroupSnapshot;
          const updated: FrozenGroupSnapshot = { ...snap, statusId, statusChangedAt: now };
          return { ...r, key_snapshot: updated as unknown as InvoicedBatchMarkRow['key_snapshot'] };
        })
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData(['invoicedBatchMarks'], ctx.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['invoicedBatchMarks'] });
    },
  });

  /**
   * Portal Approval: drop the signed batch PDF on a submitted-for-approval card.
   * Uploads to invoiced_batch_approvals and advances status to 'approved'.
   */
  const uploadApprovalMutation = useMutation({
    mutationFn: async ({ groupId, file, customerName, projectNumber, workflow }: {
      groupId: string;
      file: File;
      customerName?: string;
      projectNumber?: string;
      workflow: InvoiceWorkflowRow;
    }) => {
      await invoicedBatchApprovalsService.uploadApproval(groupId, file);
      const approvedStatus = workflow.statuses.find((s) => s.id === 'approved');
      if (!approvedStatus) return;
      await updateBatchStatusMutation.mutateAsync({
        groupId,
        statusId: approvedStatus.id,
        prevStatusId: 'submitted_approval',
        statusLabel: approvedStatus.label,
        customerName,
        projectNumber,
        workflowId: workflow.id,
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['invoicedBatchApprovals'] });
      queryClient.invalidateQueries({ queryKey: ['invoicedBatchMarks'] });
    },
  });

  /**
   * Ensure the active workflow has a `portal_submission` status between `approved` and `submitted_portal`.
   * Auto-inserts it once if missing — Portal Approval workflows pre-dating this feature get migrated on first use.
   */
  const ensurePortalSubmissionStatus = useCallback(
    async (wf: InvoiceWorkflowRow): Promise<InvoiceWorkflowRow> => {
      if (wf.statuses.some((s) => s.id === 'portal_submission')) return wf;
      const newStatus: InvoiceWorkflowStatus = {
        id: 'portal_submission',
        label: 'Portal Submission',
        color: 'teal',
      };
      const submittedPortalIdx = wf.statuses.findIndex((s) => s.id === 'submitted_portal');
      const newStatuses = [...wf.statuses];
      if (submittedPortalIdx >= 0) {
        newStatuses.splice(submittedPortalIdx, 0, newStatus);
      } else {
        newStatuses.push(newStatus);
      }
      const updated = await invoiceWorkflowsService.update(wf.id, { statuses: newStatuses });
      await queryClient.invalidateQueries({ queryKey: ['invoiceWorkflows'] });
      return updated;
    },
    [queryClient]
  );

  /**
   * Portal Approval intermediate step: from approved → portal_submission.
   * Used by the "Move to Portal Submission" button on Approved-section cards once the invoice PDF is attached.
   */
  const advanceToPortalSubmissionMutation = useMutation({
    mutationFn: async ({ groupId, customerName, projectNumber, workflow }: {
      groupId: string;
      customerName?: string;
      projectNumber?: string;
      workflow: InvoiceWorkflowRow;
    }) => {
      const wf = await ensurePortalSubmissionStatus(workflow);
      const targetStatus = wf.statuses.find((s) => s.id === 'portal_submission');
      if (!targetStatus) return;
      await updateBatchStatusMutation.mutateAsync({
        groupId,
        statusId: targetStatus.id,
        prevStatusId: 'approved',
        statusLabel: targetStatus.label,
        customerName,
        projectNumber,
        workflowId: wf.id,
      });
    },
  });

  /**
   * Portal Approval final step: from portal_submission → submitted_portal.
   * Used by the "Mark as invoiced" button on Portal Submission cards once the portal entries have been copied across.
   */
  const markFinalInvoicedMutation = useMutation({
    mutationFn: async ({ groupId, customerName, projectNumber, workflow }: {
      groupId: string;
      customerName?: string;
      projectNumber?: string;
      workflow: InvoiceWorkflowRow;
    }) => {
      const finalStatus = workflow.statuses.find((s) => s.id === 'submitted_portal');
      if (!finalStatus) return;
      await updateBatchStatusMutation.mutateAsync({
        groupId,
        statusId: finalStatus.id,
        prevStatusId: 'portal_submission',
        statusLabel: finalStatus.label,
        customerName,
        projectNumber,
        workflowId: workflow.id,
      });
    },
  });

  const saveLabourNotesMutation = useMutation({
    mutationFn: async ({ groupId, labourNotes }: { groupId: string; labourNotes: Record<string, string> }) => {
      const row = invoicedMarkRows.find((r) => r.group_id === groupId);
      if (!row) return;
      const snap = (row.key_snapshot ?? {}) as FrozenGroupSnapshot;
      const updated = { ...snap, labourNotes };
      await invoicedBatchMarksService.upsert(groupId, updated as { key: unknown; ticketIds: string[] });
    },
    onMutate: async ({ groupId, labourNotes }) => {
      await queryClient.cancelQueries({ queryKey: ['invoicedBatchMarks'] });
      const previous = queryClient.getQueryData<InvoicedBatchMarkRow[]>(['invoicedBatchMarks']);
      queryClient.setQueryData<InvoicedBatchMarkRow[]>(['invoicedBatchMarks'], (prev) =>
        (prev ?? []).map((r) => {
          if (r.group_id !== groupId) return r;
          const snap = (r.key_snapshot ?? {}) as FrozenGroupSnapshot;
          const updated: FrozenGroupSnapshot = { ...snap, labourNotes };
          return { ...r, key_snapshot: updated as unknown as InvoicedBatchMarkRow['key_snapshot'] };
        })
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData(['invoicedBatchMarks'], ctx.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['invoicedBatchMarks'] });
    },
  });

  const getMergedMarkSnapshot = (group: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] }, expensesCombined?: boolean, statusId?: string) => {
    const row = findMarkRowForGroup(group, invoicedMarkRows);
    const prevFromDb =
      row?.key_snapshot && typeof row.key_snapshot === 'object'
        ? (row.key_snapshot as FrozenGroupSnapshot)
        : undefined;
    const groupId = getGroupId(group);
    return mergeMarkSnapshotForGroup(group, prevFromDb, expensesCombined, statusId, pendingLabourNotes[groupId]);
  };

  const handleMarkAsInvoiced = (group: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] }) => {
    const persistId = resolvedPersistGroupId(group, invoicedMarkRows);
    const isCombined = combinedExpenseGroupIds.has(getGroupId(group));
    const customerName = group.tickets[0]?.customerName;
    const wf = getWorkflowForCustomer(customerName, group.key.projectNumber);
    const initialStatus = wf?.statuses?.[0];
    const initialStatusId = initialStatus?.id;
    const now = new Date().toISOString();
    const snapshot = getMergedMarkSnapshot(group, isCombined || undefined, initialStatusId);
    if (snapshot.statusId && !snapshot.statusChangedAt) {
      snapshot.statusChangedAt = now;
    }
    if (isDemoMode) {
      setLegacyMarkedInvoicedIds((prev) => {
        const next = new Set(prev);
        next.add(persistId);
        persistMarkedInvoiceIdsToLocalStorage(next);
        return next;
      });
      setFrozenInvoicedGroups((prev) => {
        const mergedSnap = mergeMarkSnapshotForGroup(group, prev[persistId], isCombined || undefined, initialStatusId, pendingLabourNotes[getGroupId(group)]);
        const next = { ...prev, [persistId]: mergedSnap };
        try {
          localStorage.setItem(FROZEN_INVOICED_GROUPS_KEY, JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      });
      return;
    }
    markInvoicedMutation.mutate(
      { groupId: persistId, snapshot },
      {
        onSuccess: () => {
          if (initialStatus && wf) {
            invoiceStatusHistoryService.logEntry({
              group_id: persistId,
              customer_name: customerName,
              project_number: group.key.projectNumber || undefined,
              workflow_id: wf.id,
              status_id: initialStatus.id,
              status_label: initialStatus.label,
              entered_at: now,
            }).catch(() => {});
          }
        },
        onError: (err) => {
          setExportError(err instanceof Error ? err.message : 'Could not save marked as invoiced');
        },
      }
    );
  };

  /** Build the merged batch PDF (per-ticket + summary) for one group. Shared by single and bulk approval flows. */
  const buildMergedBatchPdfBlob = useCallback(
    async (group: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] }): Promise<Blob> => {
      const persistId = resolvedPersistGroupId(group, invoicedMarkRows);
      const groupId = getGroupId(group);
      const exportSnap = invoicedMarkRows.find((r) => r.group_id === persistId)?.key_snapshot as FrozenGroupSnapshot | undefined;
      const exportLabourNotes = exportSnap?.labourNotes ?? pendingLabourNotes[groupId];
      const blobs: Blob[] = [];
      const allExpenses: Array<{ expense_type: string; description: string; quantity: number; rate: number; unit?: string }> = [];
      for (const ticket of group.tickets) {
        const t = ticket as ServiceTicket & { recordId?: string };
        let expenses: Array<{ expense_type: string; description: string; quantity: number; rate: number; unit?: string }> = [];
        if (t.recordId) {
          try { expenses = await serviceTicketExpensesService.getByTicketId(t.recordId); allExpenses.push(...expenses); }
          catch { expenses = []; }
        }
        const result = await generateAndStorePdf(ticket, expenses, { uploadToStorage: false, downloadLocally: false });
        blobs.push(result.blob);
      }
      try {
        const summaryPdf = await generateBatchSummaryPdf(group.tickets, allExpenses, exportLabourNotes);
        blobs.unshift(summaryPdf);
      } catch (err) {
        console.warn('Failed to generate summary PDF:', err);
      }
      if (blobs.length === 0) throw new Error('No PDFs generated.');
      return mergePdfBlobs(blobs);
    },
    [invoicedMarkRows, pendingLabourNotes]
  );

  /**
   * Portal Approval workflow: from pending, jump straight to the 'submitted_approval'
   * status (skipping 'draft'). Mirrors handleMarkAsInvoiced — same persistence, same
   * snapshot, same history-log call — just a different starting status.
   */
  const handleMarkAsSubmittedForApproval = async (group: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] }) => {
    const persistId = resolvedPersistGroupId(group, invoicedMarkRows);
    const isCombined = combinedExpenseGroupIds.has(getGroupId(group));
    const customerName = group.tickets[0]?.customerName;
    const wf = getWorkflowForCustomer(customerName, group.key.projectNumber);
    const submittedStatus = wf?.statuses?.find((s) => s.id === 'submitted_approval');
    if (!submittedStatus || !wf) {
      setExportError('Customer is not on a Portal Approval workflow.');
      return;
    }
    // Generate + download merged batch PDF first so user has the file to send to approver.
    // If generation fails, abort before marking as sent.
    try {
      const merged = await buildMergedBatchPdfBlob(group);
      const filename = getApprovalBatchFilename(group.key, group.tickets, projects);
      saveAs(merged, filename);
    } catch (err) {
      console.error('Approval batch download error:', err);
      setExportError(err instanceof Error ? err.message : 'Could not generate approval batch PDF — not marked as sent.');
      return;
    }
    const now = new Date().toISOString();
    const snapshot = getMergedMarkSnapshot(group, isCombined || undefined, submittedStatus.id);
    if (snapshot.statusId && !snapshot.statusChangedAt) {
      snapshot.statusChangedAt = now;
    }
    if (isDemoMode) {
      setLegacyMarkedInvoicedIds((prev) => {
        const next = new Set(prev);
        next.add(persistId);
        persistMarkedInvoiceIdsToLocalStorage(next);
        return next;
      });
      setFrozenInvoicedGroups((prev) => {
        const mergedSnap = mergeMarkSnapshotForGroup(group, prev[persistId], isCombined || undefined, submittedStatus.id, pendingLabourNotes[getGroupId(group)]);
        const next = { ...prev, [persistId]: mergedSnap };
        try {
          localStorage.setItem(FROZEN_INVOICED_GROUPS_KEY, JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      });
      return;
    }
    markInvoicedMutation.mutate(
      { groupId: persistId, snapshot },
      {
        onSuccess: () => {
          invoiceStatusHistoryService.logEntry({
            group_id: persistId,
            customer_name: customerName,
            project_number: group.key.projectNumber || undefined,
            workflow_id: wf.id,
            status_id: submittedStatus.id,
            status_label: submittedStatus.label,
            entered_at: now,
          }).catch(() => {});
        },
        onError: (err) => {
          setExportError(err instanceof Error ? err.message : 'Could not mark as submitted for approval');
        },
      }
    );
  };

  /**
   * Bulk Send-for-approval: build a zip with one merged PDF per group, download the zip,
   * then mark every group as submitted_approval. All groups must share the same customer
   * and that customer must be on a Portal Approval workflow.
   * If any PDF fails to generate or zip download fails, no group is marked as sent.
   */
  const handleBulkSendForApproval = async (
    customerName: string,
    groupsForCustomer: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] }[]
  ) => {
    if (groupsForCustomer.length === 0) return;
    setExportError(null);
    setBulkSendProgress({ customer: customerName, current: 0, total: groupsForCustomer.length });
    try {
      const zip = new JSZip();
      const usedNames = new Set<string>();
      for (let i = 0; i < groupsForCustomer.length; i++) {
        const group = groupsForCustomer[i];
        setBulkSendProgress({ customer: customerName, current: i + 1, total: groupsForCustomer.length });
        const merged = await buildMergedBatchPdfBlob(group);
        let filename = getApprovalBatchFilename(group.key, group.tickets, projects);
        // Dedupe filenames inside zip if two batches share the same approver+period
        if (usedNames.has(filename)) {
          const stem = filename.replace(/\.pdf$/i, '');
          let n = 2;
          while (usedNames.has(`${stem} (${n}).pdf`)) n++;
          filename = `${stem} (${n}).pdf`;
        }
        usedNames.add(filename);
        zip.file(filename, merged);
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      // Period suffix: prefer the common periodLabel across all groups; if multiple distinct,
      // use first→last range; if none, fall back to the date range of the underlying tickets.
      const periodLabels = [...new Set(
        groupsForCustomer.map((g) => g.key.periodLabel?.trim()).filter((s): s is string => !!s)
      )].sort();
      let periodSuffix: string;
      if (periodLabels.length === 1) {
        periodSuffix = periodLabels[0];
      } else if (periodLabels.length > 1) {
        periodSuffix = `${periodLabels[0]} to ${periodLabels[periodLabels.length - 1]}`;
      } else {
        const allTickets = groupsForCustomer.flatMap((g) => g.tickets);
        periodSuffix = getTicketDateRangeStr(allTickets);
      }
      const zipName = `${sanitizeFilenamePart(customerName)} - for approval - ${sanitizeFilenamePart(periodSuffix)}.zip`;
      saveAs(zipBlob, zipName);
    } catch (err) {
      console.error('Bulk approval zip error:', err);
      setExportError(err instanceof Error ? err.message : 'Could not build approval zip — no batches marked as sent.');
      setBulkSendProgress(null);
      return;
    }
    // All PDFs generated and zip downloaded — now mark each batch as submitted_approval.
    // Each failure is logged but does not stop the rest, since the user already has the file.
    const now = new Date().toISOString();
    for (const group of groupsForCustomer) {
      const persistId = resolvedPersistGroupId(group, invoicedMarkRows);
      const isCombined = combinedExpenseGroupIds.has(getGroupId(group));
      const wf = getWorkflowForCustomer(customerName, group.key.projectNumber);
      const submittedStatus = wf?.statuses?.find((s) => s.id === 'submitted_approval');
      if (!submittedStatus || !wf) continue;
      const snapshot = getMergedMarkSnapshot(group, isCombined || undefined, submittedStatus.id);
      if (snapshot.statusId && !snapshot.statusChangedAt) snapshot.statusChangedAt = now;
      if (isDemoMode) {
        setLegacyMarkedInvoicedIds((prev) => {
          const next = new Set(prev);
          next.add(persistId);
          persistMarkedInvoiceIdsToLocalStorage(next);
          return next;
        });
        setFrozenInvoicedGroups((prev) => {
          const mergedSnap = mergeMarkSnapshotForGroup(group, prev[persistId], isCombined || undefined, submittedStatus.id, pendingLabourNotes[getGroupId(group)]);
          const next = { ...prev, [persistId]: mergedSnap };
          try { localStorage.setItem(FROZEN_INVOICED_GROUPS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
          return next;
        });
        continue;
      }
      try {
        await markInvoicedMutation.mutateAsync({ groupId: persistId, snapshot });
        invoiceStatusHistoryService.logEntry({
          group_id: persistId,
          customer_name: customerName,
          project_number: group.key.projectNumber || undefined,
          workflow_id: wf.id,
          status_id: submittedStatus.id,
          status_label: submittedStatus.label,
          entered_at: now,
        }).catch(() => {});
      } catch (err) {
        console.error('Bulk mark-as-sent error for group', persistId, err);
      }
    }
    setBulkSendProgress(null);
  };

  /** Drop a PDF on "Mark as invoiced": upload (prod), mark, then same merged download as the invoiced drop zone. */
  const handleDropInvoiceOnMarkAsInvoiced = async (
    group: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] },
    file: File
  ) => {
    const persistId = resolvedPersistGroupId(group, invoicedMarkRows);
    const isCombined = combinedExpenseGroupIds.has(getGroupId(group));
    const customerName = group.tickets[0]?.customerName;
    const wf = getWorkflowForCustomer(customerName, group.key.projectNumber);
    const initialStatus = wf?.statuses?.[0];
    const initialStatusId = initialStatus?.id;
    const now = new Date().toISOString();
    const snapshot = getMergedMarkSnapshot(group, isCombined || undefined, initialStatusId);
    if (snapshot.statusId && !snapshot.statusChangedAt) {
      snapshot.statusChangedAt = now;
    }
    if (file.type !== 'application/pdf') return;
    setUploadingInvoiceGroupId(persistId);
    setExportError(null);
    try {
      let fileForUi: File;
      if (isDemoMode) {
        fileForUi = file;
        setInvoiceFileForGroup(persistId, file);
        handleMarkAsInvoiced(group);
      } else {
        await markInvoicedMutation.mutateAsync({ groupId: persistId, snapshot });
        if (initialStatus && wf) {
          invoiceStatusHistoryService.logEntry({
            group_id: persistId,
            customer_name: customerName,
            project_number: group.key.projectNumber || undefined,
            workflow_id: wf.id,
            status_id: initialStatus.id,
            status_label: initialStatus.label,
            entered_at: now,
          }).catch(() => {});
        }
        const { filename: storedName } = await invoicedBatchInvoicesService.uploadInvoice(persistId, file);
        fileForUi = new File([file], storedName, { type: file.type });
        setInvoiceFileForGroup(persistId, fileForUi);
        await queryClient.invalidateQueries({ queryKey: ['invoicedBatchInvoices'] });
      }
      await handleDownloadBatchWithInvoice(group, persistId, fileForUi);
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : 'Could not attach invoice and mark as invoiced'
      );
    } finally {
      setUploadingInvoiceGroupId(null);
    }
  };

  const handleUnmarkAsInvoiced = (groupId: string, opts?: { skipConfirm?: boolean }) => {
    if (!opts?.skipConfirm) {
      const hasInvoice = !!(invoiceFilesByGroupId[groupId] || savedInvoiceMetadata?.[groupId]);
      const msg = hasInvoice
        ? 'This will unmark the batch as invoiced and permanently delete the attached invoice PDF. Continue?'
        : 'This will unmark the batch as invoiced and move it back to pending. Continue?';
      if (!window.confirm(msg)) return;
    }

    if (isDemoMode) {
      setLegacyMarkedInvoicedIds((prev) => {
        const next = new Set(prev);
        next.delete(groupId);
        persistMarkedInvoiceIdsToLocalStorage(next);
        return next;
      });
      setFrozenInvoicedGroups((prev) => {
        if (!prev[groupId]) return prev;
        const next = { ...prev };
        delete next[groupId];
        try {
          localStorage.setItem(FROZEN_INVOICED_GROUPS_KEY, JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      });
      setInvoiceFileForGroup(groupId, null);
      return;
    }
    unmarkInvoicedMutation.mutate(groupId, {
      onError: (err) => {
        setExportError(err instanceof Error ? err.message : 'Could not unmark as invoiced');
      },
    });
  };

  useEffect(() => {
    if (invoicedMarkRows.length === 0) return;
    setFrozenInvoicedGroups((prev) => {
      const next = { ...prev };
      for (const row of invoicedMarkRows) {
        const raw = row.key_snapshot;
        if (raw && typeof raw === 'object' && Array.isArray((raw as FrozenGroupSnapshot).ticketIds)) {
          next[row.group_id] = raw as FrozenGroupSnapshot;
        }
      }
      try {
        localStorage.setItem(FROZEN_INVOICED_GROUPS_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, [invoicedMarkRows]);

  useEffect(() => {
    let updated = false;
    const next: Record<string, FrozenGroupSnapshot> = { ...frozenInvoicedGroups };
    for (const row of invoicedMarkRows) {
      const snap = row.key_snapshot;
      if (!snap || !snap.ticketIds || !(snap.key as InvoiceGroupKeyWithPeriod | undefined)) continue;
      const existing = next[row.group_id];
      if (
        !existing ||
        JSON.stringify(existing.ticketIds) !== JSON.stringify(snap.ticketIds) ||
        JSON.stringify(existing.key) !== JSON.stringify(snap.key)
      ) {
        next[row.group_id] = { key: snap.key as InvoiceGroupKeyWithPeriod, ticketIds: snap.ticketIds };
        updated = true;
      }
    }
    if (updated) {
      setFrozenInvoicedGroups(next);
      try {
        localStorage.setItem(FROZEN_INVOICED_GROUPS_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
    }
  }, [frozenInvoicedGroups, invoicedMarkRows]);

  useEffect(() => {
    const ids = new Set<string>();
    for (const row of invoicedMarkRows) {
      const snap = row.key_snapshot as FrozenGroupSnapshot | undefined;
      if (snap?.expensesCombined) ids.add(row.group_id);
    }
    for (const [id, snap] of Object.entries(frozenInvoicedGroups)) {
      if (snap.expensesCombined) ids.add(id);
    }
    if (ids.size > 0) {
      setCombinedExpenseGroupIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        if (next.size === prev.size) return prev;
        return next;
      });
    }
  }, [invoicedMarkRows, frozenInvoicedGroups]);

  /** Read the persisted statusId for a group, falling back to the first status of its workflow. */
  const getGroupStatusId = useCallback(
    (group: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] }): string | undefined => {
      const pid = resolvedPersistGroupId(group, invoicedMarkRows);
      const snap = invoicedMarkRows.find((r) => r.group_id === pid)?.key_snapshot as FrozenGroupSnapshot | undefined;
      const wf = getWorkflowForCustomer(group.tickets[0]?.customerName, group.key.projectNumber);
      return snap?.statusId ?? wf?.statuses?.[0]?.id;
    },
    [invoicedMarkRows, getWorkflowForCustomer]
  );

  /** Invoiced groups are reconstructed from DB mark rows' frozen snapshots.
   *  This guarantees grouping mode changes NEVER affect already-invoiced batches —
   *  the original key, ticket membership, and group_id are preserved exactly as when marked. */
  const invoicedGroups = useMemo(() => {
    const result: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] }[] = [];
    const coveredGroupIds = new Set<string>();

    for (const row of invoicedMarkRows) {
      const snap = row.key_snapshot;
      if (!snap || !Array.isArray(snap.ticketIds)) continue;
      const snappedKey = snap.key as InvoiceGroupKeyWithPeriod | undefined;
      if (!snappedKey) continue;
      const snappedIds = new Set(
        snap.ticketIds.map((x: unknown) => (typeof x === 'string' ? x.trim() : String(x ?? '').trim())).filter(Boolean)
      );
      const tickets = ticketsForCustomer.filter((t) => {
        const rid = (t as ServiceTicket & { recordId?: string }).recordId?.trim();
        return (rid && snappedIds.has(rid)) || snappedIds.has(t.id);
      });
      if (tickets.length === 0) continue;
      tickets.sort((a, b) => (a.date || '').localeCompare(b.date || '') || ticketNumberSortValue(a.ticketNumber) - ticketNumberSortValue(b.ticketNumber));
      result.push({ key: snappedKey, tickets });
      coveredGroupIds.add(row.group_id);
    }

    // Demo / legacy localStorage fallback
    for (const id of effectiveMarkedInvoicedIds) {
      if (coveredGroupIds.has(id)) continue;
      const snap = frozenInvoicedGroups[id];
      if (!snap) continue;
      const tickets = ticketsForCustomer.filter((t) => {
        const rid = (t as ServiceTicket & { recordId?: string }).recordId?.trim();
        return snap.ticketIds.some((tid) => tid === t.id || (!!rid && tid === rid));
      });
      if (tickets.length === 0) continue;
      tickets.sort((a, b) => (a.date || '').localeCompare(b.date || '') || ticketNumberSortValue(a.ticketNumber) - ticketNumberSortValue(b.ticketNumber));
      result.push({ key: snap.key, tickets });
    }

    result.sort((a, b) => {
      const minDate = (tickets: ServiceTicket[]) =>
        tickets.reduce((min, t) => (t.date && t.date < min ? t.date : min), '\uffff');
      const custA = a.tickets[0]?.customerName ?? a.tickets[0]?.customerId ?? '';
      const custB = b.tickets[0]?.customerName ?? b.tickets[0]?.customerId ?? '';
      const custCmp = custA.localeCompare(custB);
      if (custCmp !== 0) return custCmp;
      return minDate(a.tickets).localeCompare(minDate(b.tickets));
    });

    return result;
  }, [
    invoicedMarkRows,
    effectiveMarkedInvoicedIds,
    frozenInvoicedGroups,
    ticketsForCustomer,
  ]);

  /** Portal Approval batches in the submitted_approval status (waiting for customer approval). */
  const submittedApprovalGroups = useMemo(
    () => invoicedGroups.filter((g) => getGroupStatusId(g) === 'submitted_approval'),
    [invoicedGroups, getGroupStatusId]
  );

  /** Portal Approval batches in the approved status (signed batch attached, waiting for invoice). */
  const approvedGroups = useMemo(
    () => invoicedGroups.filter((g) => getGroupStatusId(g) === 'approved'),
    [invoicedGroups, getGroupStatusId]
  );

  /** Portal Approval batches in the portal_submission status (invoice attached, ready to copy/paste into portal). */
  const portalSubmissionGroups = useMemo(
    () => invoicedGroups.filter((g) => getGroupStatusId(g) === 'portal_submission'),
    [invoicedGroups, getGroupStatusId]
  );

  /** Group batches that share customer + project + period so each Portal-Approval tab reads cleanly
   *  when one project has multiple approvers each getting their own batch PDF. */
  type ApprovalSection<G> = {
    key: string;
    customerName: string;
    projectLine: string;
    periodLine: string;
    groups: G[];
  };
  const buildApprovalSections = useCallback(
    <G extends { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] }>(groups: G[]): ApprovalSection<G>[] => {
      const map = new Map<string, ApprovalSection<G>>();
      const order: string[] = [];
      for (const g of groups) {
        const customerName = g.tickets[0]?.customerName || '';
        const projectKey = g.key.projectId || g.key.projectNumber || g.key.projectName || '';
        const periodKey = g.key.periodKey || g.key.periodLabel || '';
        const sectionKey = `${customerName}|${projectKey}|${periodKey}`;
        let section = map.get(sectionKey);
        if (!section) {
          section = {
            key: sectionKey,
            customerName,
            projectLine: [g.key.projectNumber, g.key.projectName].filter(Boolean).join(' – '),
            periodLine: g.key.periodLabel || '',
            groups: [],
          };
          map.set(sectionKey, section);
          order.push(sectionKey);
        }
        section.groups.push(g);
      }
      return order.map((k) => map.get(k)!);
    },
    []
  );

  const getApproverForGroupKey = useCallback(
    (key: InvoiceGroupKeyWithPeriod): string | null => {
      const code = key.approverCode?.trim();
      if (code) return code;
      const projNumLc = key.projectNumber?.toLowerCase().trim();
      const proj = projects?.find((p) => (p.project_number || '').toLowerCase().trim() === projNumLc);
      return proj?.approver?.trim() || null;
    },
    [projects]
  );

  const submittedApprovalSections = useMemo(
    () => buildApprovalSections(submittedApprovalGroups),
    [submittedApprovalGroups, buildApprovalSections]
  );
  const approvedSections = useMemo(
    () => buildApprovalSections(approvedGroups),
    [approvedGroups, buildApprovalSections]
  );
  const portalSubmissionSections = useMemo(
    () => buildApprovalSections(portalSubmissionGroups),
    [portalSubmissionGroups, buildApprovalSections]
  );

  /** Sections collapsed by the user, keyed by `${tab}|${sectionKey}`. Default is expanded. */
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const toggleSectionCollapsed = useCallback(
    (tab: 'submitted' | 'approved' | 'portal' | 'ready', sectionKey: string) => {
      setCollapsedSections((prev) => {
        const k = `${tab}|${sectionKey}`;
        const next = new Set(prev);
        if (next.has(k)) next.delete(k); else next.add(k);
        return next;
      });
    },
    []
  );
  const isSectionCollapsed = useCallback(
    (tab: 'submitted' | 'approved' | 'portal' | 'ready', sectionKey: string) =>
      collapsedSections.has(`${tab}|${sectionKey}`),
    [collapsedSections]
  );

  /** Final invoiced batches — everything not in the submitted/approved/portal_submission intermediate states. Used by the See invoiced tab. */
  const finalInvoicedGroups = useMemo(
    () => invoicedGroups.filter((g) => {
      const sid = getGroupStatusId(g);
      return sid !== 'submitted_approval' && sid !== 'approved' && sid !== 'portal_submission';
    }),
    [invoicedGroups, getGroupStatusId]
  );

  /** groupedTickets already excludes invoiced tickets, so all groups here are uninvoiced. */
  const uninvoicedGroups = groupedTickets;

  /** A group is "accumulating" when its period is still open (more tickets expected) — these belong on Pending.
   *  Closed periods (or project-completion / progress batches) belong on Ready. */
  const isGroupAccumulating = useCallback(
    (group: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] }) => {
      const firstTicket = group.tickets[0];
      const custIdForPeriod = firstTicket?.customerId ?? '';
      const projIdForPeriod =
        (firstTicket as ServiceTicket & { recordProjectId?: string })?.recordProjectId ??
        firstTicket?.projectId ??
        '';
      const periodGrouping = cnrlPeriodGrouping(getGroupingForTicket(custIdForPeriod, projIdForPeriod));
      return (
        !!group.key.periodKey &&
        !String(group.key.periodKey).startsWith('pc:') &&
        !String(group.key.periodKey).startsWith('prog:') &&
        isInvoicePeriodStillAccumulating(group.key.periodKey, periodGrouping)
      );
    },
    [getGroupingForTicket]
  );

  const pendingAccumulatingGroups = useMemo(
    () => uninvoicedGroups.filter(isGroupAccumulating),
    [uninvoicedGroups, isGroupAccumulating]
  );
  const readyGroups = useMemo(
    () => uninvoicedGroups.filter((g) => !isGroupAccumulating(g)),
    [uninvoicedGroups, isGroupAccumulating]
  );

  /** Per-customer buckets of ready batches whose workflow is Portal Approval — eligible for the bulk Send-for-approval zip flow. */
  const bulkApprovalCandidates = useMemo(() => {
    const map = new Map<string, { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] }[]>();
    for (const g of readyGroups) {
      const cust = g.tickets[0]?.customerName;
      if (!cust) continue;
      const wf = getWorkflowForCustomer(cust, g.key.projectNumber);
      if (!isPortalApprovalWorkflow(wf)) continue;
      if (!map.has(cust)) map.set(cust, []);
      map.get(cust)!.push(g);
    }
    return [...map.entries()].map(([customer, groups]) => ({ customer, groups })).sort((a, b) => a.customer.localeCompare(b.customer));
  }, [readyGroups, getWorkflowForCustomer, isPortalApprovalWorkflow]);

  // On first data load, open Ready tab if any ready groups exist, else stay on Pending.
  // Skips after data loads once — user-driven tab changes are not overridden later.
  // Wait for groupedTickets to actually populate (initial useMemo returns []) so we don't
  // lock the choice before tickets finish loading.
  useEffect(() => {
    if (didAutoPickInitialTab) return;
    if (!groupedTickets || groupedTickets.length === 0) return;
    if (readyGroups.length > 0) setActiveTab('ready');
    setDidAutoPickInitialTab(true);
  }, [didAutoPickInitialTab, groupedTickets, readyGroups.length]);

  const filteredUninvoicedGroups = useMemo(() => {
    const base = activeTab === 'pending' ? pendingAccumulatingGroups : activeTab === 'ready' ? readyGroups : uninvoicedGroups;
    if (!invoiceSearchQuery.trim()) return base;
    const q = invoiceSearchQuery.trim().toLowerCase();
    return base.filter((g) => {
      const custName = g.tickets[0]?.customerName?.toLowerCase() ?? '';
      const projName = g.key.projectName?.toLowerCase() ?? '';
      const projNum = g.key.projectNumber?.toLowerCase() ?? '';
      const ticketNums = g.tickets.map(t => t.ticketNumber?.toLowerCase() ?? '').join(' ');
      return custName.includes(q) || projName.includes(q) || projNum.includes(q) || ticketNums.includes(q);
    });
  }, [uninvoicedGroups, pendingAccumulatingGroups, readyGroups, invoiceSearchQuery, activeTab]);

  /** Ready/Pending tab sections — same project+period grouping so it's obvious when a project produces
   *  multiple separate invoices/approvals (e.g. CNRL splits one project by approver). Each card inside
   *  stays full-sized so the user can see they remain distinct submissions. */
  const readyTabSections = useMemo(
    () => buildApprovalSections(filteredUninvoicedGroups),
    [filteredUninvoicedGroups, buildApprovalSections]
  );

  const { data: savedInvoiceMetadata } = useQuery({
    queryKey: ['invoicedBatchInvoices', [...invoicedGroupIdsFromDb].sort().join(',')],
    queryFn: () => invoicedBatchInvoicesService.getMetadataByGroupIds(invoicedGroupIdsFromDb),
    enabled: showInvoiced && invoicedGroupIdsFromDb.length > 0,
  });

  /** Approval (signed batch) PDF metadata for marked batches. Used by the Submitted-for-approval and Approved sections. */
  const { data: savedApprovalMetadata } = useQuery({
    queryKey: ['invoicedBatchApprovals', [...invoicedGroupIdsFromDb].sort().join(',')],
    queryFn: () => invoicedBatchApprovalsService.getMetadataByGroupIds(invoicedGroupIdsFromDb),
    enabled: invoicedGroupIdsFromDb.length > 0,
  });

  const getInvoiceLabel = useCallback((group: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] }) => {
    const pid = resolvedPersistGroupId(group, invoicedMarkRows);
    return invoiceFilesByGroupId[pid]?.name ?? savedInvoiceMetadata?.[pid]?.filename ?? null;
  }, [invoicedMarkRows, invoiceFilesByGroupId, savedInvoiceMetadata]);

  const extractInvoiceNumber = useCallback((label: string | null): number => {
    if (!label) return -1;
    const m = label.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : -1;
  }, []);

  const activeStatusLabels = useMemo(() => {
    const map = new Map<string, { id: string; label: string; color: string; count: number }>();
    for (const g of finalInvoicedGroups) {
      const pid = resolvedPersistGroupId(g, invoicedMarkRows);
      const snap = invoicedMarkRows.find((r) => r.group_id === pid)?.key_snapshot as FrozenGroupSnapshot | undefined;
      const wf = getWorkflowForCustomer(g.tickets[0]?.customerName, g.key.projectNumber);
      const sid = snap?.statusId ?? wf?.statuses?.[0]?.id;
      if (!sid) continue;
      const st = wf?.statuses?.find((s) => s.id === sid);
      if (!st) continue;
      const existing = map.get(sid);
      if (existing) existing.count++;
      else map.set(sid, { id: sid, label: st.label, color: st.color, count: 1 });
    }
    return [...map.values()];
  }, [finalInvoicedGroups, invoicedMarkRows, getWorkflowForCustomer]);

  const sortedFilteredInvoicedGroups = useMemo(() => {
    let groups = [...finalInvoicedGroups];
    groups.sort((a, b) => extractInvoiceNumber(getInvoiceLabel(b)) - extractInvoiceNumber(getInvoiceLabel(a)));

    if (invoiceStatusFilter !== 'all') {
      groups = groups.filter((g) => {
        const pid = resolvedPersistGroupId(g, invoicedMarkRows);
        const snap = invoicedMarkRows.find((r) => r.group_id === pid)?.key_snapshot as FrozenGroupSnapshot | undefined;
        const wf = getWorkflowForCustomer(g.tickets[0]?.customerName, g.key.projectNumber);
        const sid = snap?.statusId ?? wf?.statuses?.[0]?.id;
        return sid === invoiceStatusFilter;
      });
    }

    if (!invoiceSearchQuery.trim()) return groups;
    const q = invoiceSearchQuery.trim().toLowerCase();
    return groups.filter((g) => {
      const label = getInvoiceLabel(g)?.toLowerCase() ?? '';
      const custName = g.tickets[0]?.customerName?.toLowerCase() ?? '';
      const projName = g.key.projectName?.toLowerCase() ?? '';
      const projNum = g.key.projectNumber?.toLowerCase() ?? '';
      const ticketNums = g.tickets.map(t => t.ticketNumber?.toLowerCase() ?? '').join(' ');
      return label.includes(q) || custName.includes(q) || projName.includes(q) || projNum.includes(q) || ticketNums.includes(q);
    });
  }, [finalInvoicedGroups, invoiceSearchQuery, invoiceStatusFilter, getInvoiceLabel, extractInvoiceNumber, invoicedMarkRows]);

  const markTicketsAsPdfExported = async (groupTickets: ServiceTicket[]) => {
    const recordIds = groupTickets
      .map((t) => (t as ServiceTicket & { recordId?: string }).recordId)
      .filter(Boolean) as string[];
    for (const id of recordIds) {
      try {
        await serviceTicketsService.updateWorkflowStatus(id, 'pdf_exported', isDemoMode);
      } catch {
        // best-effort; don't block the download
      }
    }
  };

  const handleExportSingleGroup = async (group: { key: InvoiceGroupKey; tickets: ServiceTicket[] }) => {
    const { key, tickets: groupTickets } = group;
    const groupId = getGroupId(group);
    const exportPersistId = resolvedPersistGroupId(group, invoicedMarkRows);
    const exportSnap = invoicedMarkRows.find((r) => r.group_id === exportPersistId)?.key_snapshot as FrozenGroupSnapshot | undefined;
    const exportLabourNotes = exportSnap?.labourNotes ?? pendingLabourNotes[groupId];
    setExportingGroupIdx(groupId);
    setExportError(null);
    try {
      const blobs: Blob[] = [];
      const allExpenses: Array<{ expense_type: string; description: string; quantity: number; rate: number; unit?: string }> = [];

      for (const ticket of groupTickets) {
        const t = ticket as ServiceTicket & { recordId?: string; headerOverrides?: unknown };
        const recordId = t.recordId;
        let expenses: Array<{ expense_type: string; description: string; quantity: number; rate: number; unit?: string }> = [];
        if (recordId) {
          try {
            expenses = await serviceTicketExpensesService.getByTicketId(recordId);
            allExpenses.push(...expenses);
          } catch {
            expenses = [];
          }
        }
        const result = await generateAndStorePdf(ticket, expenses, {
          uploadToStorage: false,
          downloadLocally: false,
        });
        blobs.push(result.blob);
      }

      try {
        const summaryPdf = await generateBatchSummaryPdf(groupTickets, allExpenses, exportLabourNotes);
        blobs.unshift(summaryPdf);
      } catch (err) {
        console.warn('Failed to generate summary PDF:', err);
      }

      if (blobs.length > 0) {
        const merged = await mergePdfBlobs(blobs);
        const filename = getInvoicePdfFilename(key, groupTickets);
        saveAs(merged, filename);
        await markTicketsAsPdfExported(groupTickets);
      }
    } catch (err) {
      console.error('Export error:', err);
      setExportError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExportingGroupIdx(null);
    }
  };

  const isExportingGroup = (groupId: string) => exportingGroupIdx === groupId;

  const handleDownloadBatchWithInvoice = async (
    group: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] },
    groupId: string,
    fileOverride?: File
  ) => {
    const invoiceFile = fileOverride ?? invoiceFilesByGroupId[groupId];
    const saved = savedInvoiceMetadata?.[groupId];
    let invoiceBlob: Blob;
    let sourceInvoiceName: string;
    if (invoiceFile) {
      invoiceBlob = invoiceFile;
      sourceInvoiceName = invoiceFile.name || 'invoice.pdf';
    } else if (saved?.storagePath) {
      invoiceBlob = await invoicedBatchInvoicesService.downloadInvoice(saved.storagePath);
      sourceInvoiceName = saved.filename || 'invoice.pdf';
    } else return;

    const downloadFilename = mergedInvoiceBatchDownloadFilename(sourceInvoiceName);
    const dlSnap = invoicedMarkRows.find((r) => r.group_id === groupId)?.key_snapshot as FrozenGroupSnapshot | undefined;
    const dlLabourNotes = dlSnap?.labourNotes ?? pendingLabourNotes[groupId];

    const { tickets: groupTickets } = group;
    setDownloadingWithInvoiceGroupId(groupId);
    setExportError(null);
    try {
      const blobs: Blob[] = [invoiceBlob];
      const allExpenses: Array<{ expense_type: string; description: string; quantity: number; rate: number; unit?: string }> = [];

      for (const ticket of groupTickets) {
        const t = ticket as ServiceTicket & { recordId?: string; headerOverrides?: unknown };
        const recordId = t.recordId;
        let expenses: Array<{ expense_type: string; description: string; quantity: number; rate: number; unit?: string }> = [];
        if (recordId) {
          try {
            expenses = await serviceTicketExpensesService.getByTicketId(recordId);
            allExpenses.push(...expenses);
          } catch {
            expenses = [];
          }
        }
        const result = await generateAndStorePdf(ticket, expenses, {
          uploadToStorage: false,
          downloadLocally: false,
        });
        blobs.push(result.blob);
      }

      try {
        const summaryPdf = await generateBatchSummaryPdf(groupTickets, allExpenses, dlLabourNotes);
        blobs.splice(1, 0, summaryPdf); // Insert after invoice PDF
      } catch (err) {
        console.warn('Failed to generate summary PDF:', err);
      }

      const merged = await mergePdfBlobs(blobs);
      saveAs(merged, downloadFilename);
      await markTicketsAsPdfExported(groupTickets);
    } catch (err) {
      console.error('Export with invoice error:', err);
      setExportError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setDownloadingWithInvoiceGroupId(null);
    }
  };

  /**
   * Download every ticket matching the current customer/project/date filters as a single merged PDF.
   * Independent of batch grouping (bi-weekly, monthly, etc.) — used when a client requests an ad-hoc
   * range like "all April tickets" that doesn't line up with the regular invoice cadence.
   * Does not mark tickets as pdf_exported, since this is outside the invoice flow.
   */
  const handleDownloadCustomRange = async () => {
    const ticketsToExport = ticketsForCustomer;
    if (ticketsToExport.length === 0) return;

    const customerLabel = selectedCustomerId
      ? (selectedCustomer?.name ?? 'Customer')
      : 'AllCustomers';
    const projectLabel = selectedProjectId
      ? (() => {
          const p = projects?.find((p: { id: string; name?: string; project_number?: string }) => p.id === selectedProjectId);
          return p?.project_number || p?.name || '';
        })()
      : '';
    const sanitize = (s: string) => s.replace(/[/\\?*:|"<>]/g, '_').trim();
    const parts = [
      'Service-Tickets',
      sanitize(customerLabel),
      projectLabel ? sanitize(projectLabel) : '',
      `${startDate}_to_${endDate}`,
    ].filter(Boolean);
    const filename = `${parts.join('_')}.pdf`;

    const total = ticketsToExport.length;
    setDownloadingCustomRange(true);
    setExportError(null);
    setExportProgress({ current: 0, total, label: `Preparing ${total} ticket(s)...` });

    try {
      const blobs: Blob[] = [];
      let processed = 0;
      for (const ticket of ticketsToExport) {
        const t = ticket as ServiceTicket & { recordId?: string };
        const recordId = t.recordId;
        let expenses: Array<{ expense_type: string; description: string; quantity: number; rate: number; unit?: string }> = [];
        if (recordId) {
          try {
            expenses = await serviceTicketExpensesService.getByTicketId(recordId);
          } catch {
            expenses = [];
          }
        }
        const result = await generateAndStorePdf(ticket, expenses, {
          uploadToStorage: false,
          downloadLocally: false,
        });
        blobs.push(result.blob);
        processed++;
        setExportProgress({ current: processed, total, label: `Generating PDF ${processed}/${total}` });
      }

      if (blobs.length > 0) {
        const merged = await mergePdfBlobs(blobs);
        saveAs(merged, filename);
      }
      setExportProgress(null);
    } catch (err) {
      console.error('Custom range download error:', err);
      setExportError(err instanceof Error ? err.message : 'Download failed');
      setExportProgress(null);
    } finally {
      setDownloadingCustomRange(false);
    }
  };

  const handleExportForInvoicing = async () => {
    setExportError(null);
    const total = uninvoicedGroups.reduce((sum, g) => sum + g.tickets.length, 0);
    let processed = 0;

    setExportProgress({ current: 0, total, label: 'Preparing...' });

    try {
      for (let i = 0; i < uninvoicedGroups.length; i++) {
        const { key, tickets: groupTickets } = uninvoicedGroups[i];
        setExportProgress({
          current: processed,
          total,
          label: `Processing group ${i + 1}/${uninvoicedGroups.length} (${groupTickets.length} ticket(s))`,
        });

        const blobs: Blob[] = [];
        const allExpenses: Array<{ expense_type: string; description: string; quantity: number; rate: number; unit?: string }> = [];

        for (const ticket of groupTickets) {
          const t = ticket as ServiceTicket & { recordId?: string; headerOverrides?: unknown };
          const recordId = t.recordId;
          let expenses: Array<{ expense_type: string; description: string; quantity: number; rate: number; unit?: string }> = [];
          if (recordId) {
            try {
              expenses = await serviceTicketExpensesService.getByTicketId(recordId);
              allExpenses.push(...expenses);
            } catch {
              expenses = [];
            }
          }
          const result = await generateAndStorePdf(ticket, expenses, {
            uploadToStorage: false,
            downloadLocally: false,
          });
          blobs.push(result.blob);
          processed++;
          setExportProgress({ current: processed, total, label: `Generating PDF ${processed}/${total}` });
        }

        try {
          const groupId = getGroupId(uninvoicedGroups[i]);
          const summaryPdf = await generateBatchSummaryPdf(groupTickets, allExpenses, pendingLabourNotes[groupId]);
          blobs.unshift(summaryPdf);
        } catch (err) {
          console.warn('Failed to generate summary PDF:', err);
        }

        if (blobs.length > 0) {
          const merged = await mergePdfBlobs(blobs);
          const filename = getInvoicePdfFilename(key, groupTickets);
          saveAs(merged, filename);
          await markTicketsAsPdfExported(groupTickets);
        }
      }

      setExportProgress(null);
    } catch (err) {
      console.error('Export error:', err);
      setExportError(err instanceof Error ? err.message : 'Export failed');
      setExportProgress(null);
    }
  };

  const handleCreateInQuickBooks = async () => {
    if (qboApiLocal) return;
    setQboError(null);
    setQboCreatedIds([]);
    const total = uninvoicedGroups.length;
    setQboProgress({ current: 0, total, label: 'Connecting to QuickBooks...' });

    try {
      for (let i = 0; i < uninvoicedGroups.length; i++) {
        const { key, tickets: groupTickets } = uninvoicedGroups[i];
        setQboProgress({
          current: i,
          total,
          label: `Creating invoice ${i + 1}/${total} in QuickBooks...`,
        });

        let poAfeLineItems: Array<{ poAfe: string; tickets: string[]; totalAmount: number }>;
        const isCnrlPeriodGroup = key.periodKey && key.approverCode && key.approverCode !== key.periodKey;
        if (key.periodKey && !isCnrlPeriodGroup) {
          // Non-CNRL period: single line item for the whole group
          let totalAmount = 0;
          const ticketNumbers: string[] = [];
          for (const ticket of groupTickets) {
            const recordId = (ticket as ServiceTicket & { recordId?: string }).recordId;
            let expenses: Array<{ quantity: number; rate: number }> = [];
            if (recordId) {
              try {
                const exp = await serviceTicketExpensesService.getByTicketId(recordId);
                expenses = exp.map((e) => ({ quantity: e.quantity, rate: e.rate }));
              } catch {
                // ignore
              }
            }
            totalAmount += calculateTicketTotalAmount(ticket, expenses);
            if (ticket.ticketNumber) ticketNumbers.push(ticket.ticketNumber);
          }
          poAfeLineItems = [{
            poAfe: key.periodLabel || key.periodKey,
            tickets: ticketNumbers,
            totalAmount: Math.round(totalAmount * 100) / 100,
          }];
        } else {
          // CNRL: sub-group by PO/AFE (each PO/AFE = one line item)
          const poAfeMap = new Map<string, ServiceTicket[]>();
          for (const ticket of groupTickets) {
            const t = ticket as ServiceTicket & { headerOverrides?: { approver?: string; po_afe?: string; cc?: string } };
            const { poAfe } = getApproverPoAfeCcFromTicket(t, t.headerOverrides);
            const poAfeKey = (poAfe || '').trim() || NO_PO_AFE_LABEL;
            const list = poAfeMap.get(poAfeKey) ?? [];
            list.push(ticket);
            poAfeMap.set(poAfeKey, list);
          }
          poAfeLineItems = [];
          const sortedPoAfeEntries = [...poAfeMap.entries()].sort(([keyA], [keyB]) => {
            if (keyA === NO_PO_AFE_LABEL) return 1;
            if (keyB === NO_PO_AFE_LABEL) return -1;
            const numA = /^\d+$/.test(keyA) ? Number(keyA) : NaN;
            const numB = /^\d+$/.test(keyB) ? Number(keyB) : NaN;
            if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA - numB;
            return keyA.localeCompare(keyB);
          });
          for (const [poAfe, poAfeTickets] of sortedPoAfeEntries) {
            if (poAfe === NO_PO_AFE_LABEL) continue;
            let totalAmount = 0;
            const ticketNumbers: string[] = [];
            for (const ticket of poAfeTickets) {
              const recordId = (ticket as ServiceTicket & { recordId?: string }).recordId;
              let expenses: Array<{ quantity: number; rate: number }> = [];
              if (recordId) {
                try {
                  const exp = await serviceTicketExpensesService.getByTicketId(recordId);
                  expenses = exp.map((e) => ({ quantity: e.quantity, rate: e.rate }));
                } catch {
                  // ignore
                }
              }
              totalAmount += calculateTicketTotalAmount(ticket, expenses);
              if (ticket.ticketNumber) ticketNumbers.push(ticket.ticketNumber);
            }
            poAfeLineItems.push({
              poAfe,
              tickets: ticketNumbers,
              totalAmount: Math.round(totalAmount * 100) / 100,
            });
          }
        }

        const firstTicket = groupTickets[0];
        const { poAfe: customerPo } = getApproverPoAfeCcFromTicket(
          firstTicket,
          (firstTicket as ServiceTicket & { headerOverrides?: { approver?: string; po_afe?: string; cc?: string } }).headerOverrides
        );
        const reference = key.periodKey ? key.periodLabel : key.approverCode;
        const date = firstTicket.date || new Date().toISOString().split('T')[0];
        const docNumber = (key.periodKey ? key.periodKey : key.approverCode)
          ? `INV-${(key.periodKey ?? key.approverCode).replace(/[/\\?*:|"]/g, '_')}-${date.replace(/-/g, '')}`
          : undefined;

        const result = await quickbooksClientService.createInvoiceFromGroup({
          customerName: firstTicket.customerName,
          customerEmail: firstTicket.customerInfo?.email,
          customerPo: customerPo || undefined,
          reference: reference || undefined,
          poAfeLineItems,
          date,
          docNumber,
        });

        if (result?.invoiceId) {
          setQboCreatedIds((prev) => [...prev, result.invoiceNumber]);

          // Attach merged PDF to invoice
          const blobs: Blob[] = [];
          const allExpenses: Array<{ expense_type: string; description: string; quantity: number; rate: number; unit?: string }> = [];

          for (const ticket of groupTickets) {
            const t = ticket as ServiceTicket & { recordId?: string; headerOverrides?: unknown };
            const recordId = t.recordId;
            let expenses: Array<{ expense_type: string; description: string; quantity: number; rate: number; unit?: string }> = [];
            if (recordId) {
              try {
                expenses = await serviceTicketExpensesService.getByTicketId(recordId);
                allExpenses.push(...expenses);
              } catch {
                expenses = [];
              }
            }
            const pdfResult = await generateAndStorePdf(ticket, expenses, {
              uploadToStorage: false,
              downloadLocally: false,
            });
            blobs.push(pdfResult.blob);
          }

          try {
            const groupId = getGroupId(uninvoicedGroups[i]);
            const summaryPdf = await generateBatchSummaryPdf(groupTickets, allExpenses, pendingLabourNotes[groupId]);
            blobs.unshift(summaryPdf);
          } catch (err) {
            console.warn('Failed to generate summary PDF:', err);
          }

          if (blobs.length > 0) {
            const merged = await mergePdfBlobs(blobs);
            const filename = getInvoicePdfFilename(key, groupTickets);
            const base64 = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                const result = reader.result as string;
                resolve(result.split(',')[1] || '');
              };
              reader.onerror = reject;
              reader.readAsDataURL(merged);
            });
            await quickbooksClientService.attachPdfToInvoice(result.invoiceId, base64, filename);
          }
        }
      }

      setQboProgress(null);
    } catch (err) {
      console.error('QBO create error:', err);
      setQboError(err instanceof Error ? err.message : 'Failed to create invoices in QuickBooks');
      setQboProgress(null);
    }
  };

  if (!isAdmin || !user) {
    return (
      <div style={{ padding: '24px', color: 'var(--text-secondary)' }}>
        Admin access required.
      </div>
    );
  }

  if (loadingApproved) {
    return (
      <div style={{ padding: '24px' }}>
        Loading approved tickets...
      </div>
    );
  }

  return (
    <div style={{ padding: '24px', maxWidth: 1200, margin: '0 auto' }}>
      <h1 style={{ marginBottom: '16px', fontSize: '24px', fontWeight: 600 }}>Invoices</h1>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '20px', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
        {([
          { id: 'pending' as const, label: 'Pending', count: pendingAccumulatingGroups.length },
          { id: 'ready' as const, label: 'Ready for invoicing', count: readyGroups.length },
          { id: 'submitted' as const, label: 'Submitted', count: submittedApprovalGroups.length },
          { id: 'approved' as const, label: 'Approved', count: approvedGroups.length },
          { id: 'portal_submission' as const, label: 'Portal Submission', count: portalSubmissionGroups.length },
          { id: 'invoiced' as const, label: 'Invoiced', count: finalInvoicedGroups.length },
          { id: 'settings' as const, label: 'Settings', count: null as number | null },
        ]).map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => { setActiveTab(tab.id); setExportError(null); }}
              style={{
                padding: '10px 16px',
                backgroundColor: 'transparent',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--primary-color)' : '2px solid transparent',
                color: isActive ? 'var(--primary-color)' : 'var(--text-secondary)',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer',
                marginBottom: '-1px',
              }}
            >
              {tab.label}
              {tab.count != null && (
                <span style={{ marginLeft: '6px', fontSize: '12px', color: isActive ? 'var(--primary-color)' : 'var(--text-tertiary)', fontWeight: 500 }}>
                  ({tab.count})
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ marginBottom: '24px' }}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Filters</div>
        <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flexShrink: 0, minWidth: '220px' }}>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Customer</label>
          <SearchableSelect
            value={selectedCustomerId}
            onChange={(val) => {
              setSelectedCustomerId(val);
              setSelectedProjectId('');
            }}
            options={(customers ?? []).map((c: { id: string; name: string }) => ({ value: c.id, label: c.name }))}
            emptyOption={{ value: '', label: 'All customers' }}
            placeholder="Search customers..."
            style={{ fontSize: '14px' }}
          />
        </div>
        <div style={{ flexShrink: 0, minWidth: '220px' }}>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Project</label>
          <SearchableSelect
            value={selectedProjectId}
            onChange={(val) => setSelectedProjectId(val)}
            options={projectsForFilter.map((p: { id: string; name?: string; project_number?: string }) => ({
              value: p.id,
              label: [p.project_number, p.name].filter(Boolean).join(' – ') || p.id,
            }))}
            emptyOption={{ value: '', label: 'All projects' }}
            placeholder="Search projects..."
            style={{ fontSize: '14px' }}
          />
        </div>
        {selectedProjectId && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <button
              type="button"
              onClick={() => {
                if (!invoiceFilterProject || invoiceFilterProject.status === 'completed') return;
                if (!window.confirm('Mark this project as completed in Projects? You can change status again from the Projects page.')) return;
                markProjectCompletedMutation.mutate(selectedProjectId);
              }}
              disabled={
                !selectedProjectId ||
                markProjectCompletedMutation.isPending ||
                invoiceFilterProject?.status === 'completed'
              }
              style={{
                padding: '8px 12px',
                backgroundColor: 'var(--bg-tertiary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'var(--text-primary)',
                fontSize: '13px',
                fontWeight: 600,
                cursor:
                  !selectedProjectId || markProjectCompletedMutation.isPending || invoiceFilterProject?.status === 'completed'
                    ? 'not-allowed'
                    : 'pointer',
                opacity: invoiceFilterProject?.status === 'completed' ? 0.6 : 1,
              }}
            >
              {invoiceFilterProject?.status === 'completed' ? 'Project completed' : 'Mark project as completed'}
            </button>
          </div>
        )}
        <div>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Date Range</label>
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <button
              type="button"
              onClick={() => setCalendarOpen((v) => !v)}
              aria-expanded={calendarOpen}
              title="Pick a date range"
              style={{
                padding: '8px 14px',
                backgroundColor: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'var(--text-primary)',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontFamily: 'inherit',
                minWidth: '230px',
              }}
            >
              <span style={{ fontSize: '14px' }}>📅</span>
              <span>
                {(() => {
                  const fmt = (s: string) => {
                    try {
                      return new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    } catch {
                      return s;
                    }
                  };
                  return `${fmt(startDate)} – ${fmt(endDate)}`;
                })()}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--text-tertiary)' }}>▼</span>
            </button>
            {calendarOpen && (
              <PayPeriodCalendar
                value={{ start: startDate, end: endDate }}
                onChange={({ start, end }) => {
                  setStartDate(start);
                  setEndDate(end);
                }}
                onClose={() => setCalendarOpen(false)}
                initialMode="custom"
                hideModeToggle
              />
            )}
          </div>
        </div>
        {selectedCustomerId && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Custom range download</label>
            <button
              type="button"
              onClick={handleDownloadCustomRange}
              disabled={downloadingCustomRange || ticketsForCustomer.length === 0}
              title={
                ticketsForCustomer.length === 0
                  ? 'No tickets match the current filters'
                  : `Merge all ${ticketsForCustomer.length} ticket(s) in this range into one PDF (ignores batch grouping; does not mark as exported).`
              }
              style={{
                padding: '8px 12px',
                backgroundColor: 'var(--bg-tertiary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'var(--text-primary)',
                fontSize: '13px',
                fontWeight: 600,
                cursor: downloadingCustomRange || ticketsForCustomer.length === 0 ? 'not-allowed' : 'pointer',
                opacity: downloadingCustomRange || ticketsForCustomer.length === 0 ? 0.6 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              {downloadingCustomRange
                ? 'Downloading...'
                : `Download ${ticketsForCustomer.length} ticket(s) as PDF`}
            </button>
          </div>
        )}
        <span style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>
          Filters pick which approved tickets feed the tabs above. Marked-as-invoiced batches live on the <strong>Invoiced</strong> tab.{selectedCustomerId ? ' Use ' : ' Pick a customer to enable '}<strong>Custom range download</strong>{selectedCustomerId ? ' to merge every ticket in this range (incl. invoiced) into one PDF for ad-hoc client requests.' : ' for ad-hoc client requests outside the regular invoice cadence.'}
        </span>
        </div>
      </div>

      {exportProgress && (
        <div
          style={{
            marginBottom: '24px',
            padding: '16px',
            backgroundColor: 'var(--bg-tertiary)',
            borderRadius: '8px',
            border: '1px solid var(--border-color)',
          }}
        >
          <div style={{ marginBottom: '8px', fontSize: '14px' }}>{exportProgress.label}</div>
          <div
            style={{
              height: '8px',
              backgroundColor: 'var(--border-color)',
              borderRadius: '4px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${exportProgress.total > 0 ? (exportProgress.current / exportProgress.total) * 100 : 0}%`,
                backgroundColor: 'var(--primary-color)',
                transition: 'width 0.2s ease',
              }}
            />
          </div>
        </div>
      )}

      {exportError && (
        <div
          style={{
            marginBottom: '24px',
            padding: '12px 14px',
            backgroundColor: 'rgba(239, 83, 80, 0.1)',
            border: '1px solid #ef5350',
            borderRadius: '8px',
            color: '#ef5350',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '12px',
          }}
        >
          <span style={{ flex: 1 }}>{exportError}</span>
          <button
            type="button"
            onClick={() => setExportError(null)}
            aria-label="Dismiss error"
            style={{
              flexShrink: 0,
              border: 'none',
              background: 'transparent',
              color: '#ef5350',
              fontSize: '16px',
              fontWeight: 700,
              cursor: 'pointer',
              padding: '0 4px',
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {qboProgress && (
        <div
          style={{
            marginBottom: '24px',
            padding: '16px',
            backgroundColor: 'var(--bg-tertiary)',
            borderRadius: '8px',
            border: '1px solid var(--border-color)',
          }}
        >
          <div style={{ marginBottom: '8px', fontSize: '14px' }}>{qboProgress.label}</div>
          <div
            style={{
              height: '8px',
              backgroundColor: 'var(--border-color)',
              borderRadius: '4px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${qboProgress.total > 0 ? (qboProgress.current / qboProgress.total) * 100 : 0}%`,
                backgroundColor: 'var(--primary-color)',
                transition: 'width 0.2s ease',
              }}
            />
          </div>
        </div>
      )}

      {qboError && (
        <div
          style={{
            marginBottom: '24px',
            padding: '12px',
            backgroundColor: 'rgba(239, 83, 80, 0.1)',
            border: '1px solid #ef5350',
            borderRadius: '8px',
            color: '#ef5350',
          }}
        >
          {qboError}
        </div>
      )}

      {qboCreatedIds.length > 0 && (
        <div
          style={{
            marginBottom: '24px',
            padding: '12px',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            border: '1px solid #10b981',
            borderRadius: '8px',
            color: '#10b981',
          }}
        >
          Created {qboCreatedIds.length} invoice(s) in QuickBooks: {qboCreatedIds.join(', ')}
        </div>
      )}

      {groupedTickets.length === 0 && invoicedGroups.length === 0 && (activeTab === 'pending' || activeTab === 'ready') ? (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
          {selectedCustomerId
            ? 'No approved tickets for this customer in the selected date range. Approve service tickets first in the Service Tickets page.'
            : 'No approved tickets ready for export. Approve service tickets first in the Service Tickets page.'}
        </div>
      ) : groupedTickets.length === 0 && (activeTab === 'pending' || activeTab === 'ready') ? (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
          All batches are marked as invoiced.
          <div style={{ marginTop: '12px' }}>
            <button
              onClick={() => setActiveTab('invoiced')}
              style={{
                padding: '8px 18px',
                backgroundColor: 'var(--primary-color)',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Go to Invoiced tab ({finalInvoicedGroups.length})
            </button>
          </div>
        </div>
      ) : showInvoiced ? (
        <div>
          <div style={{ marginBottom: '16px' }}>
            <h2 style={{ margin: '0 0 6px', fontSize: '18px', fontWeight: 600, color: 'var(--text-primary)' }}>
              Invoiced (locked)
            </h2>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              {finalInvoicedGroups.length} group(s). Service tickets in these batches cannot be edited until unmarked. A linked invoice PDF is optional.
            </span>
          </div>
          {finalInvoicedGroups.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
              No invoiced batches yet.
            </div>
          ) : (
          <>
          <div style={{ marginBottom: '12px' }}>
            <input
              type="text"
              value={invoiceSearchQuery}
              onChange={(e) => setInvoiceSearchQuery(e.target.value)}
              placeholder="Search invoices by number, customer, project, ticket…"
              style={{
                width: '100%',
                maxWidth: '400px',
                padding: '8px 12px',
                fontSize: '14px',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                backgroundColor: 'var(--bg-primary)',
                color: 'var(--text-primary)',
                outline: 'none',
              }}
            />
          </div>
          {activeStatusLabels.length > 0 && (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '4px' }}>
              <button
                type="button"
                onClick={() => setInvoiceStatusFilter('all')}
                style={{
                  fontSize: '12px',
                  fontWeight: invoiceStatusFilter === 'all' ? 700 : 500,
                  padding: '3px 12px',
                  borderRadius: '999px',
                  border: invoiceStatusFilter === 'all' ? '2px solid var(--primary-color)' : '1px solid var(--border-color)',
                  backgroundColor: invoiceStatusFilter === 'all' ? 'var(--primary-light)' : 'var(--bg-tertiary)',
                  color: invoiceStatusFilter === 'all' ? 'var(--primary-color)' : 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                All
              </button>
              {activeStatusLabels.map((s) => {
                const hex = statusColorHex(s.color);
                const isActive = invoiceStatusFilter === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setInvoiceStatusFilter(isActive ? 'all' : s.id)}
                    style={{
                      fontSize: '12px',
                      fontWeight: isActive ? 700 : 500,
                      padding: '3px 12px',
                      borderRadius: '999px',
                      border: isActive ? `2px solid ${hex}` : '1px solid var(--border-color)',
                      backgroundColor: isActive ? `${hex}18` : 'var(--bg-tertiary)',
                      color: isActive ? hex : 'var(--text-secondary)',
                      cursor: 'pointer',
                    }}
                  >
                    {s.label} ({s.count})
                  </button>
                );
              })}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {sortedFilteredInvoicedGroups.map((group) => {
              const { key, tickets: groupTickets } = group;
              const groupId = getGroupId(group);
              const persistId = resolvedPersistGroupId(group, invoicedMarkRows);
              const isCnrlPeriodGroup = key.periodKey && key.approverCode && key.approverCode !== key.periodKey;
              const isCombined = combinedExpenseGroupIds.has(persistId);
              const isSplitRate = splitRateGroupIds.has(persistId);
              const breakdownMode: BreakdownMode = isCombined ? 'combined' : isSplitRate ? 'split' : 'itemized';
              const breakdownLines = isSplitRate
                ? buildRateTypeBreakdown(groupTickets as (ServiceTicket & { recordId?: string })[], expensesByRecordId, false)
                : key.periodKey && !isCnrlPeriodGroup
                ? buildSingleLineBreakdown(groupTickets as (ServiceTicket & { recordId?: string })[], expensesByRecordId, isCombined)
                : buildPoAfeBreakdown(
                    groupTickets as (ServiceTicket & { headerOverrides?: unknown; recordProjectId?: string; recordId?: string })[],
                    (t) =>
                      getInvoiceGroupKey(
                        {
                          projectId: t.recordProjectId ?? t.projectId,
                          projectName: t.projectName,
                          projectNumber: t.projectNumber,
                          location: t.location,
                          projectApproverPoAfe: t.projectApproverPoAfe,
                          projectLocation: t.projectLocation,
                          projectOther: t.projectOther,
                          customerInfo: t.customerInfo,
                          entries: t.entries,
                        },
                        t.headerOverrides as { approver_po_afe?: string; approver?: string; po_afe?: string; cc?: string; other?: string; service_location?: string } | undefined
                      ),
                    expensesByRecordId,
                    isCombined
                  );
              const gstTotals = computeInvoicedGroupTotalsWithGst(
                groupTickets as (ServiceTicket & { recordId?: string })[],
                expensesByRecordId
              );
              const hasMissingPoAfe =
                isCnrlPeriodGroup &&
                groupTickets.some((t) => {
                  const key = getInvoiceGroupKey(
                    {
                      projectId: (t as ServiceTicket & { recordProjectId?: string }).recordProjectId ?? t.projectId,
                      projectName: t.projectName,
                      projectNumber: t.projectNumber,
                      location: t.location,
                      projectApproverPoAfe: (t as ServiceTicket & { projectApproverPoAfe?: string }).projectApproverPoAfe,
                      projectLocation: (t as ServiceTicket & { projectLocation?: string }).projectLocation,
                      projectOther: (t as ServiceTicket & { projectOther?: string }).projectOther,
                      customerInfo: t.customerInfo,
                      entries: t.entries,
                    },
                    (t as ServiceTicket & { headerOverrides?: unknown }).headerOverrides as { approver_po_afe?: string; approver?: string; po_afe?: string; cc?: string; other?: string; service_location?: string } | undefined
                  );
                  return !(key.poAfe || '').trim();
                });
              const isBreakdownExpanded = invoicedBreakdownExpanded.has(persistId);
              const uniquePoAfeFromBreakdown = [...new Set(breakdownLines.map((l) => l.poAfe).filter(Boolean))];
              const headerPoAfe =
                uniquePoAfeFromBreakdown.length === 0
                  ? '(none)'
                  : uniquePoAfeFromBreakdown.length === 1
                    ? uniquePoAfeFromBreakdown[0]!
                    : 'Multiple';
              const ionexProjectNum = key.projectNumber?.trim() || '';
              const projectNameOnly = key.projectName?.trim() || '';
              const invoiceLabel = invoiceFilesByGroupId[persistId]?.name
                ?? savedInvoiceMetadata?.[persistId]?.filename
                ?? null;
              const isAccordionOpen = isBreakdownExpanded;
              const batchMarkRow = invoicedMarkRows.find((r) => r.group_id === persistId);
              const batchSnap = batchMarkRow?.key_snapshot as FrozenGroupSnapshot | undefined;
              const batchWorkflow = getWorkflowForCustomer(groupTickets[0]?.customerName, key.projectNumber);
              const batchStatusId = batchSnap?.statusId ?? batchWorkflow?.statuses?.[0]?.id;
              const batchCurrentStatus = batchWorkflow?.statuses?.find((s) => s.id === batchStatusId);
              const statusSinceDate = batchSnap?.statusChangedAt ?? batchMarkRow?.marked_at;
              // Calendar-day diff (local time), so something set 23h ago is "yesterday", not "today".
              const daysSinceStatus = (() => {
                if (!statusSinceDate) return null;
                const then = new Date(statusSinceDate);
                if (Number.isNaN(then.getTime())) return null;
                const now = new Date();
                const a = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
                const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
                return Math.round((b - a) / 86400000);
              })();
              const statusSinceTitle = statusSinceDate
                ? new Date(statusSinceDate).toLocaleString(undefined, {
                    weekday: 'short',
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })
                : '';
              return (
                <div
                  key={persistId}
                  style={{
                    backgroundColor: 'var(--bg-secondary)',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color)',
                    overflow: 'hidden',
                  }}
                >
                  {/* Accordion header */}
                  <button
                    type="button"
                    onClick={() => {
                      setInvoicedBreakdownExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(persistId)) next.delete(persistId);
                        else next.add(persistId);
                        return next;
                      });
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      width: '100%',
                      padding: '12px 16px',
                      backgroundColor: 'var(--bg-secondary)',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontFamily: 'inherit',
                      color: 'var(--text-primary)',
                      fontSize: '13px',
                    }}
                  >
                    <span style={{ fontSize: '11px', flexShrink: 0, color: 'var(--text-tertiary)' }}>
                      {isAccordionOpen ? '▼' : '▶'}
                    </span>
                    <span style={{ fontWeight: 700, flexShrink: 0 }}>
                      {groupTickets[0]?.customerName || 'Unknown'}
                    </span>
                    <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>
                      #{ionexProjectNum || '—'}
                    </span>
                    {(key.periodLabel || key.periodKey) && (
                      <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>
                        {key.periodLabel || key.periodKey}
                      </span>
                    )}
                    <span style={{ color: 'var(--text-tertiary)', fontSize: '12px', marginLeft: 'auto', flexShrink: 0 }}>
                      {invoiceLabel
                        ? <span style={{ color: 'var(--success-color, #16a34a)' }}>{invoiceLabel}</span>
                        : 'No invoice'}
                    </span>
                    {batchCurrentStatus && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                        <span
                          style={{
                            fontSize: '11px',
                            fontWeight: 600,
                            padding: '2px 10px',
                            borderRadius: '999px',
                            backgroundColor: `${statusColorHex(batchCurrentStatus.color)}18`,
                            color: statusColorHex(batchCurrentStatus.color),
                            border: `1px solid ${statusColorHex(batchCurrentStatus.color)}40`,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {batchCurrentStatus.label}
                        </span>
                        {daysSinceStatus !== null && (
                          <span
                            title={statusSinceTitle}
                            style={{ fontSize: '11px', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}
                          >
                            {daysSinceStatus <= 0
                              ? 'today'
                              : daysSinceStatus === 1
                              ? 'yesterday'
                              : `${daysSinceStatus} days ago`}
                          </span>
                        )}
                      </span>
                    )}
                    <span style={{ fontWeight: 700, color: 'var(--primary-color)', flexShrink: 0, fontSize: '14px' }}>
                      ${gstTotals.totalInclGst.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </button>

                  {/* Expanded body */}
                  {isAccordionOpen && (
                    <div style={{ padding: '0 16px 16px', borderTop: '1px solid var(--border-color)' }}>
                      {/* Full details */}
                      <div style={{ marginTop: '12px', marginBottom: '12px' }}>
                        <div
                          style={{
                            fontSize: '18px',
                            fontWeight: 700,
                            color: 'var(--text-primary)',
                            marginBottom: '8px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '6px',
                          }}
                        >
                          {groupTickets[0]?.customerName && (
                            <div>
                              <strong>Customer:</strong>{' '}
                              <CopyableHeaderValue copyText={groupTickets[0].customerName}>
                                {groupTickets[0].customerName}
                              </CopyableHeaderValue>
                            </div>
                          )}
                          <div>
                            <strong>IONEX project #:</strong>{' '}
                            <CopyableHeaderValue copyText={ionexProjectNum}>
                              {ionexProjectNum || '(none)'}
                            </CopyableHeaderValue>
                          </div>
                          <div>
                            <strong>Project name:</strong>{' '}
                            <CopyableHeaderValue copyText={projectNameOnly}>
                              {projectNameOnly || '(none)'}
                            </CopyableHeaderValue>
                          </div>
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px', display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                          <span>
                            <strong>Approver:</strong>{' '}
                            <CopyableHeaderValue copyText={key.approverCode || key.approver || ''}>
                              {key.approverCode || key.approver || '(none)'}
                            </CopyableHeaderValue>
                          </span>
                          <span>
                            <strong>PO/AFE/CC:</strong>{' '}
                            <CopyableHeaderValue copyText={headerPoAfe === '(none)' ? '' : headerPoAfe}>
                              {headerPoAfe}
                            </CopyableHeaderValue>
                          </span>
                          {key.cc ? (
                            <span>
                              <strong>Coding:</strong>{' '}
                              <CopyableHeaderValue copyText={key.cc}>{key.cc}</CopyableHeaderValue>
                              {key.periodLabel || key.periodKey ? (
                                <>
                                  {' · '}
                                  <strong>
                                    <CopyableHeaderValue copyText={key.periodLabel || key.periodKey || ''}>
                                      {key.periodLabel || key.periodKey}
                                    </CopyableHeaderValue>
                                  </strong>
                                </>
                              ) : null}
                            </span>
                          ) : key.periodLabel || key.periodKey ? (
                            <span>
                              <strong>Period:</strong>{' '}
                              <CopyableHeaderValue copyText={key.periodLabel || key.periodKey || ''}>
                                <strong>{key.periodLabel || key.periodKey}</strong>
                              </CopyableHeaderValue>
                            </span>
                          ) : null}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
                            <span style={{ fontSize: '20px', fontWeight: 700, color: 'var(--primary-color)' }}>
                              Total (incl. GST): $
                              {gstTotals.totalInclGst.toLocaleString('en-CA', {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                            <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', lineHeight: 1.4 }}>
                              {(() => {
                                const fmt = (n: number) => n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                                const expSubtotal = Math.round((gstTotals.subtotal - gstTotals.labourSubtotal) * 100) / 100;
                                const parts: string[] = [];
                                if (gstTotals.labourSubtotal > 0) parts.push(`Labour $${fmt(gstTotals.labourSubtotal)}`);
                                if (expSubtotal > 0) parts.push(`Expenses $${fmt(expSubtotal)}`);
                                if (parts.length === 0) parts.push(`Subtotal $${fmt(gstTotals.subtotal)}`);
                                else parts.unshift(`Subtotal $${fmt(gstTotals.subtotal)}`);
                                if (gstTotals.gstOnLabour > 0) parts.push(`GST on labour (5%) $${fmt(gstTotals.gstOnLabour)}`);
                                if (gstTotals.expenseGstTotal > 0) {
                                  const label = gstTotals.expenseGstFromReceipt ? 'Receipt GST (expenses)' : 'GST on expenses (5%)';
                                  parts.push(`${label} $${fmt(gstTotals.expenseGstTotal)}`);
                                }
                                return parts.join(' · ');
                              })()}
                            </span>
                          </div>
                          <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                            <button
                              onClick={() => handleExportSingleGroup(group)}
                              disabled={!!exportProgress || !!qboProgress || exportingGroupIdx !== null}
                              style={{
                                padding: '6px 12px',
                                backgroundColor: 'var(--primary-color)',
                                color: 'white',
                                border: 'none',
                                borderRadius: '6px',
                                fontSize: '12px',
                                fontWeight: 600,
                                cursor: exportProgress || qboProgress || exportingGroupIdx !== null ? 'not-allowed' : 'pointer',
                              }}
                              title="Download this group's merged PDF"
                            >
                              {isExportingGroup(groupId) ? 'Generating…' : 'Download'}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (editingLabourNotesGroupId === persistId) {
                                  setEditingLabourNotesGroupId(null);
                                  setApplyLabourNotesToSimilarBatches(false);
                                } else {
                                  setEditingLabourNotes(batchSnap?.labourNotes ?? {});
                                  setApplyLabourNotesToSimilarBatches(false);
                                  setEditingLabourNotesGroupId(persistId);
                                }
                              }}
                              style={{
                                padding: '6px 12px',
                                backgroundColor: editingLabourNotesGroupId === persistId ? 'var(--primary-color)' : 'var(--bg-tertiary)',
                                color: editingLabourNotesGroupId === persistId ? 'white' : 'var(--text-secondary)',
                                border: '1px solid var(--border-color)',
                                borderRadius: '6px',
                                fontSize: '12px',
                                fontWeight: 600,
                                cursor: 'pointer',
                              }}
                              title="Short description for each rate type (ST/TT/FT/SO/FO) — used to justify or explain rates on the batch summary PDF cover page (e.g. 'overtime > 8 hrs')"
                            >
                              Edit rate descriptions
                            </button>
                            <button
                              type="button"
                              onClick={() => handleUnmarkAsInvoiced(persistId)}
                              disabled={!!exportProgress || !!qboProgress || unmarkInvoicedMutation.isPending}
                              style={{
                                padding: '6px 12px',
                                backgroundColor: 'var(--bg-tertiary)',
                                color: 'var(--text-secondary)',
                                border: '1px solid var(--border-color)',
                                borderRadius: '6px',
                                fontSize: '12px',
                                fontWeight: 600,
                                cursor: exportProgress || qboProgress || unmarkInvoicedMutation.isPending ? 'not-allowed' : 'pointer',
                              }}
                              title="Move this group back to pending (removes DB mark and linked invoice file if any)"
                            >
                              {unmarkInvoicedMutation.isPending ? 'Updating…' : 'Unmark as invoiced'}
                            </button>
                          </div>
                        </div>
                      </div>
                      {/* Labour notes editor */}
                      {editingLabourNotesGroupId === persistId && (
                        <div style={{
                          marginTop: '10px',
                          padding: '12px',
                          backgroundColor: 'var(--bg-secondary)',
                          border: '1px solid var(--border-color)',
                          borderRadius: '8px',
                          borderLeft: '4px solid var(--primary-color)',
                        }}>
                          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                            Rate descriptions (justify/annotate each rate type)
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '10px' }}>
                            Short justification or explanation for each rate type. Appears in brackets after the rate on the <strong>batch summary PDF</strong> (cover page of the exported invoice bundle) — e.g. <em>Shop Time (ST) (overtime &gt; 8 hrs)</em>. Leave a field blank to omit. Does not appear on per-ticket PDFs or in QuickBooks.
                          </div>
                          {SUMMARY_LABOUR_TYPES.map(({ key: ltKey, label: ltLabel }) => (
                            <div key={ltKey} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                              <span style={{ width: '150px', fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', flexShrink: 0 }}>{ltLabel}</span>
                              <input
                                type="text"
                                value={editingLabourNotes[ltKey] ?? ''}
                                onChange={(e) => setEditingLabourNotes((prev) => ({ ...prev, [ltKey]: e.target.value }))}
                                placeholder="Add a note…"
                                style={{
                                  flex: 1,
                                  padding: '4px 8px',
                                  fontSize: '12px',
                                  border: '1px solid var(--border-color)',
                                  borderRadius: '4px',
                                  backgroundColor: 'var(--bg-primary)',
                                  color: 'var(--text-primary)',
                                }}
                              />
                            </div>
                          ))}
                          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginTop: '10px', fontSize: '12px', color: 'var(--text-secondary)', cursor: 'pointer', lineHeight: 1.4 }}>
                            <input
                              type="checkbox"
                              checked={applyLabourNotesToSimilarBatches}
                              onChange={(e) => setApplyLabourNotesToSimilarBatches(e.target.checked)}
                              style={{ marginTop: '2px', flexShrink: 0 }}
                            />
                            <span>Also apply to every <strong>invoiced</strong> batch with the same project, approver, PO/AFE, and CC</span>
                          </label>
                          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '10px' }}>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingLabourNotesGroupId(null);
                                setApplyLabourNotesToSimilarBatches(false);
                              }}
                              style={{ padding: '5px 12px', fontSize: '12px', border: '1px solid var(--border-color)', borderRadius: '5px', backgroundColor: 'var(--bg-tertiary)', cursor: 'pointer', color: 'var(--text-secondary)' }}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              disabled={saveLabourNotesMutation.isPending}
                              onClick={() => {
                                const cleaned = Object.fromEntries(
                                  Object.entries(editingLabourNotes).filter(([, v]) => v.trim())
                                );
                                const mk = summaryDescriptionMatchKey(key);
                                void (async () => {
                                  try {
                                    if (applyLabourNotesToSimilarBatches) {
                                      for (const g of invoicedGroups) {
                                        if (summaryDescriptionMatchKey(g.key) !== mk) continue;
                                        const pid = resolvedPersistGroupId(g, invoicedMarkRows);
                                        await saveLabourNotesMutation.mutateAsync({ groupId: pid, labourNotes: cleaned });
                                      }
                                    } else {
                                      await saveLabourNotesMutation.mutateAsync({ groupId: persistId, labourNotes: cleaned });
                                    }
                                    setEditingLabourNotesGroupId(null);
                                    setApplyLabourNotesToSimilarBatches(false);
                                  } catch {
                                    /* onError on mutation / toast if needed */
                                  }
                                })();
                              }}
                              style={{ padding: '5px 12px', fontSize: '12px', border: 'none', borderRadius: '5px', backgroundColor: 'var(--primary-color)', color: 'white', fontWeight: 600, cursor: saveLabourNotesMutation.isPending ? 'not-allowed' : 'pointer' }}
                            >
                              {saveLabourNotesMutation.isPending ? 'Saving…' : 'Save'}
                            </button>
                          </div>
                        </div>
                      )}
                      {/* Invoice status workflow */}
                      {batchWorkflow && batchWorkflow.statuses.length > 0 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px', marginBottom: '4px' }}>
                          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', flexShrink: 0 }}>Status:</span>
                          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                            {batchWorkflow.statuses.map((ws) => {
                              const isActive = ws.id === batchStatusId;
                              const hex = statusColorHex(ws.color);
                              return (
                                <button
                                  key={ws.id}
                                  type="button"
                                  onClick={() => {
                                    if (isActive) return;
                                    updateBatchStatusMutation.mutate({
                                      groupId: persistId,
                                      statusId: ws.id,
                                      prevStatusId: batchStatusId,
                                      statusLabel: ws.label,
                                      customerName: groupTickets[0]?.customerName,
                                      projectNumber: key.projectNumber || undefined,
                                      workflowId: batchWorkflow?.id,
                                    });
                                  }}
                                  style={{
                                    fontSize: '12px',
                                    fontWeight: isActive ? 700 : 500,
                                    padding: '3px 12px',
                                    borderRadius: '999px',
                                    border: isActive ? `2px solid ${hex}` : '1px solid var(--border-color)',
                                    backgroundColor: isActive ? `${hex}18` : 'var(--bg-tertiary)',
                                    color: isActive ? hex : 'var(--text-secondary)',
                                    cursor: isActive ? 'default' : 'pointer',
                                    transition: 'all 0.15s ease',
                                  }}
                                >
                                  {ws.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {/* Attach invoice PDF and download batch with invoice */}
                      <div style={{ marginTop: '12px', marginBottom: '12px' }}>
                        <div
                          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.style.borderColor = 'var(--primary-color)'; }}
                          onDragLeave={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = ''; }}
                          onDrop={async (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            e.currentTarget.style.borderColor = '';
                            const file = e.dataTransfer?.files?.[0];
                            if (file?.type !== 'application/pdf') return;
                            setUploadingInvoiceGroupId(persistId);
                            setExportError(null);
                            try {
                              if (!isDemoMode) {
                                await markInvoicedMutation.mutateAsync({
                                  groupId: persistId,
                                  snapshot: getMergedMarkSnapshot(group, isCombined || undefined),
                                });
                              }
                              const { filename: storedName } = await invoicedBatchInvoicesService.uploadInvoice(persistId, file);
                              const fileForUi = new File([file], storedName, { type: file.type });
                              setInvoiceFileForGroup(persistId, fileForUi);
                              await queryClient.invalidateQueries({ queryKey: ['invoicedBatchInvoices'] });
                              await handleDownloadBatchWithInvoice(group, persistId, fileForUi);
                            } catch (err) {
                              setExportError(err instanceof Error ? err.message : 'Upload failed');
                            } finally {
                              setUploadingInvoiceGroupId(null);
                            }
                          }}
                          onClick={() => document.getElementById(`invoice-file-${persistId}`)?.click()}
                          style={{
                            border: '2px dashed var(--border-color)',
                            borderRadius: '8px',
                            padding: '12px 16px',
                            cursor: uploadingInvoiceGroupId === persistId ? 'wait' : 'pointer',
                            backgroundColor: 'var(--bg-tertiary)',
                            marginBottom: '8px',
                          }}
                        >
                          <input
                            id={`invoice-file-${persistId}`}
                            type="file"
                            accept=".pdf,application/pdf"
                            style={{ display: 'none' }}
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              e.target.value = '';
                              if (!file) return;
                              setUploadingInvoiceGroupId(persistId);
                              setExportError(null);
                              try {
                              if (!isDemoMode) {
                                await markInvoicedMutation.mutateAsync({
                                  groupId: persistId,
                                  snapshot: getMergedMarkSnapshot(group, isCombined || undefined),
                                });
                              }
                              const { filename: storedName } = await invoicedBatchInvoicesService.uploadInvoice(persistId, file);
                              const fileForUi = new File([file], storedName, { type: file.type });
                              setInvoiceFileForGroup(persistId, fileForUi);
                              await queryClient.invalidateQueries({ queryKey: ['invoicedBatchInvoices'] });
                              await handleDownloadBatchWithInvoice(group, persistId, fileForUi);
                            } catch (err) {
                              setExportError(err instanceof Error ? err.message : 'Upload failed');
                            } finally {
                              setUploadingInvoiceGroupId(null);
                            }
                          }}
                        />
                        {uploadingInvoiceGroupId === persistId ? (
                            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Uploading…</span>
                          ) : invoiceFilesByGroupId[persistId] || savedInvoiceMetadata?.[persistId] ? (
                            <span style={{ fontSize: '13px', color: 'var(--text-primary)' }}
                              title={invoiceFilesByGroupId[persistId]?.name ?? savedInvoiceMetadata?.[persistId]?.filename}
                            >
                              {invoiceFilesByGroupId[persistId]?.name ?? savedInvoiceMetadata?.[persistId]?.filename}
                            </span>
                          ) : (
                            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                              Drop invoice PDF here or click to choose (saved to storage)
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => handleDownloadBatchWithInvoice(group, persistId)}
                          disabled={!(invoiceFilesByGroupId[persistId] || savedInvoiceMetadata?.[persistId]) || !!exportProgress || !!qboProgress || downloadingWithInvoiceGroupId === persistId}
                          style={{
                            padding: '6px 12px',
                            backgroundColor: (invoiceFilesByGroupId[persistId] || savedInvoiceMetadata?.[persistId]) ? 'var(--primary-color)' : 'var(--bg-tertiary)',
                            color: (invoiceFilesByGroupId[persistId] || savedInvoiceMetadata?.[persistId]) ? 'white' : 'var(--text-tertiary)',
                            border: '1px solid var(--border-color)',
                            borderRadius: '6px',
                            fontSize: '12px',
                            fontWeight: 600,
                            cursor: (invoiceFilesByGroupId[persistId] || savedInvoiceMetadata?.[persistId]) && !exportProgress && !qboProgress && downloadingWithInvoiceGroupId !== persistId ? 'pointer' : 'not-allowed',
                          }}
                          title="Merge invoice PDF (first) with this batch and download"
                        >
                          {downloadingWithInvoiceGroupId === persistId ? 'Generating…' : 'Download batch with invoice'}
                        </button>
                      </div>
                      {/* Line item breakdown */}
                      {hasMissingPoAfe && (
                        <div style={{
                          marginTop: '12px',
                          padding: '8px 12px',
                          backgroundColor: 'var(--warning-bg, #fff3cd)',
                          color: 'var(--warning-text, #856404)',
                          borderRadius: '6px',
                          fontSize: '12px',
                        }}>
                          PO/AFE/CC is missing for some entries.
                        </div>
                      )}
                      <div style={{
                        marginTop: '12px',
                        padding: '12px',
                        backgroundColor: 'var(--bg-tertiary)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '6px',
                        borderLeft: '4px solid var(--primary-color)',
                      }}>
                        {(() => {
                          const { lines: expLines } = computeGroupExpenseTotal(
                            groupTickets as (ServiceTicket & { recordId?: string })[],
                            expensesByRecordId
                          );
                          const hasExpenses = expLines.length > 0;
                          const expCount = expLines.length;
                          const categoryLabel = isCombined && hasExpenses
                            ? `labour & ${expCount === 1 ? 'expense' : 'expenses'}`
                            : undefined;
                          return (
                            <>
                              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
                                <BreakdownModeToggle mode={breakdownMode} onMode={(m) => {
                                  setCombinedExpenseGroupIds((prev) => { const next = new Set(prev); if (m === 'combined') next.add(persistId); else next.delete(persistId); return next; });
                                  setSplitRateGroupIds((prev) => { const next = new Set(prev); if (m === 'split') next.add(persistId); else next.delete(persistId); return next; });
                                }} />
                              </div>
                              {breakdownLines.map(({ ticketList, poAfe, totalAmount, splitRate, splitHours }, i) => (
                                <PoAfeBreakdownLine key={i} ticketList={ticketList} poAfe={poAfe} totalAmount={totalAmount} category={categoryLabel} splitRate={splitRate} splitHours={splitHours} />
                              ))}
                              {!isCombined && !isSplitRate && expLines.map((l, i) => {
                                const suffix = l.ticketNums.length > 0 ? ` (${formatTicketNumbersWithRanges(l.ticketNums)})` : '';
                                return (
                                  <PoAfeBreakdownLine
                                    key={`exp-${i}`}
                                    ticketList={`${l.label}${suffix}`}
                                    poAfe=""
                                    totalAmount={l.amount}
                                    category="expense"
                                  />
                                );
                              })}
                              {isSplitRate && expLines.map((l, i) => {
                                const suffix = l.ticketNums.length > 0 ? ` (${formatTicketNumbersWithRanges(l.ticketNums)})` : '';
                                return (
                                  <PoAfeBreakdownLine
                                    key={`exp-split-${i}`}
                                    ticketList={`${l.label}${suffix}`}
                                    poAfe=""
                                    totalAmount={l.amount}
                                    category="expense"
                                  />
                                );
                              })}
                            </>
                          );
                        })()}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
                        {groupTickets.map((t) => {
                          const ticket = t as InvoiceTicketModalTicket;
                          return (
                            <button
                              key={t.id}
                              type="button"
                              onClick={() => setEditTicketRecordId(ticket.recordId?.trim() || ticket.id)}
                              style={{
                                padding: '4px 10px',
                                backgroundColor: 'var(--bg-tertiary)',
                                borderRadius: '6px',
                                fontSize: '13px',
                                color: 'inherit',
                                border: 'none',
                                cursor: 'pointer',
                                fontFamily: 'inherit',
                                textAlign: 'left',
                              }}
                            >
                              {t.ticketNumber} – {t.userName} ({t.totalHours}h)
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          </>
          )}
        </div>
      ) : uninvoicedGroups.length === 0 && (activeTab === 'pending' || activeTab === 'ready') ? (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
          All groups have been marked as invoiced.
          {finalInvoicedGroups.length > 0 && (
            <div style={{ marginTop: '16px' }}>
              <button
                type="button"
                onClick={() => setActiveTab('invoiced')}
                title="Switch to the Invoiced tab to view batches already marked as invoiced"
                style={{
                  padding: '8px 16px',
                  backgroundColor: 'var(--bg-tertiary)',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Go to Invoiced tab ({finalInvoicedGroups.length})
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {(activeTab === 'pending' || activeTab === 'ready') && (<>
          <div style={{ marginBottom: '14px' }}>
            <h2 style={{ fontSize: '18px', fontWeight: 600, margin: '0 0 6px', color: 'var(--text-primary)' }}>
              {activeTab === 'ready' ? 'Ready for invoicing' : 'Pending'}
            </h2>
            <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.45, maxWidth: '900px' }}>
              {activeTab === 'ready'
                ? <>Billing periods are closed for these batches — actionable now. Use <strong>Mark as invoiced</strong> for non-portal customers, or <strong>Download for approval &amp; mark ready to send</strong> for Portal Approval customers (per batch, or bulk per customer from the banner above).</>
                : <>Billing periods still open — more tickets may still be added before the period closes. These move to <strong>Ready</strong> automatically once their period ends.</>}
            </p>
          </div>
          <div style={{ marginBottom: '16px', display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              {(activeTab === 'ready' ? readyGroups : pendingAccumulatingGroups).reduce((sum, g) => sum + g.tickets.length, 0)} ticket(s) in {(activeTab === 'ready' ? readyGroups : pendingAccumulatingGroups).length} group(s)
            </span>
          </div>

          {activeTab === 'ready' && bulkApprovalCandidates.length > 0 && (
            <div style={{ marginBottom: '16px', padding: '12px 14px', backgroundColor: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.4)', borderRadius: '8px' }}>
              <div style={{ fontSize: '13px', fontWeight: 700, color: '#b45309', marginBottom: '8px' }}>
                Prepare approval batches — download zip per customer
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {bulkApprovalCandidates.map(({ customer, groups }) => {
                  const isBusy = bulkSendProgress?.customer === customer;
                  const label = isBusy
                    ? `Building ${bulkSendProgress!.current}/${bulkSendProgress!.total}…`
                    : `📥 Download ${groups.length} batch${groups.length === 1 ? '' : 'es'} for ${customer} (zip) & mark ready to send`;
                  return (
                    <button
                      key={customer}
                      type="button"
                      disabled={!!bulkSendProgress}
                      onClick={() => handleBulkSendForApproval(customer, groups)}
                      title={`Generates one merged PDF per batch (Approver_Period.pdf), zips them as ${customer}_for-approval_<date>.zip, downloads the zip, then marks each batch as ready to send. Nothing is sent automatically — you email/submit the zip to the approver yourself.`}
                      style={{
                        alignSelf: 'flex-start',
                        padding: '8px 14px',
                        fontSize: '13px',
                        fontWeight: 700,
                        backgroundColor: isBusy ? 'rgba(245, 158, 11, 0.18)' : 'rgba(245, 158, 11, 0.14)',
                        color: '#b45309',
                        border: '1px solid rgba(245, 158, 11, 0.55)',
                        borderRadius: '6px',
                        cursor: bulkSendProgress ? 'not-allowed' : 'pointer',
                        opacity: bulkSendProgress && !isBusy ? 0.6 : 1,
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{ marginBottom: '12px' }}>
            <input
              type="text"
              value={invoiceSearchQuery}
              onChange={(e) => setInvoiceSearchQuery(e.target.value)}
              placeholder="Search by customer, project, ticket number…"
              style={{
                width: '100%',
                maxWidth: '400px',
                padding: '8px 12px',
                fontSize: '14px',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                backgroundColor: 'var(--bg-primary)',
                color: 'var(--text-primary)',
                outline: 'none',
              }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {readyTabSections.map((section) => {
              const sectionMulti = section.groups.length > 1;
              const sectionCollapsed = sectionMulti && isSectionCollapsed('ready', section.key);
              const sectionFirstGroup = section.groups[0];
              const sectionFirstTicket = sectionFirstGroup.tickets[0];
              const sectionWorkflow = getWorkflowForCustomer(sectionFirstTicket?.customerName, sectionFirstGroup.key.projectNumber);
              const sectionIsPortalApproval = isPortalApprovalWorkflow(sectionWorkflow);
              const sectionBatchNoun = sectionIsPortalApproval ? 'approval' : 'invoice';
              const cards = section.groups.map((group, batchIndex) => {
              const { key, tickets: groupTickets } = group;
              const groupId = getGroupId(group);
              const batchOfLabel = sectionMulti
                ? `${sectionBatchNoun.charAt(0).toUpperCase()}${sectionBatchNoun.slice(1)} ${batchIndex + 1} of ${section.groups.length}`
                : null;
              const batchApprover = getApproverForGroupKey(key);
              const isCnrlPeriodGroup = key.periodKey && key.approverCode && key.approverCode !== key.periodKey;
              const hasMissingPoAfe =
                isCnrlPeriodGroup &&
                groupTickets.some((t) => {
                  const k = getInvoiceGroupKey(
                    {
                      projectId: (t as ServiceTicket & { recordProjectId?: string }).recordProjectId ?? t.projectId,
                      projectName: t.projectName,
                      projectNumber: t.projectNumber,
                      location: t.location,
                      projectApproverPoAfe: (t as ServiceTicket & { projectApproverPoAfe?: string }).projectApproverPoAfe,
                      projectLocation: (t as ServiceTicket & { projectLocation?: string }).projectLocation,
                      projectOther: (t as ServiceTicket & { projectOther?: string }).projectOther,
                      customerInfo: t.customerInfo,
                      entries: t.entries,
                    },
                    (t as ServiceTicket & { headerOverrides?: unknown }).headerOverrides as { approver_po_afe?: string; approver?: string; po_afe?: string; cc?: string; other?: string; service_location?: string } | undefined
                  );
                  return !(k.poAfe || '').trim();
                });
              const firstTicket = groupTickets[0];
              const custIdForPeriod = firstTicket?.customerId ?? '';
              const projIdForPeriod =
                (firstTicket as ServiceTicket & { recordProjectId?: string })?.recordProjectId ??
                firstTicket?.projectId ??
                '';
              const periodGrouping = cnrlPeriodGrouping(getGroupingForTicket(custIdForPeriod, projIdForPeriod));
              const periodStillAccumulating =
                !!key.periodKey &&
                !String(key.periodKey).startsWith('pc:') &&
                !String(key.periodKey).startsWith('prog:') &&
                isInvoicePeriodStillAccumulating(key.periodKey, periodGrouping);
              const groupWorkflow = getWorkflowForCustomer(firstTicket?.customerName, key.projectNumber);
              const groupIsPortalApproval = isPortalApprovalWorkflow(groupWorkflow);
              return (
              <div
                key={groupId}
                style={{
                  padding: '16px',
                  backgroundColor: 'var(--bg-secondary)',
                  borderRadius: '8px',
                  border: '1px solid var(--border-color)',
                  boxShadow: periodStillAccumulating ? 'inset 3px 0 0 0 rgba(217, 119, 6, 0.9)' : undefined,
                }}
              >
                {batchOfLabel && (
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                      marginBottom: '10px',
                      padding: '3px 10px',
                      borderRadius: '999px',
                      backgroundColor: 'var(--bg-tertiary)',
                      border: '1px solid var(--border-color)',
                      fontSize: '11px',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: 'var(--text-secondary)',
                    }}
                    title="One of several separate batches in this project + period. Each is downloaded, approved, and invoiced on its own."
                  >
                    <span>{batchOfLabel}</span>
                    <span style={{ color: 'var(--text-tertiary)', fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>·</span>
                    <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>Approver: {batchApprover || '—'}</span>
                  </div>
                )}
                {periodStillAccumulating && (
                  <div
                    style={{
                      marginBottom: '12px',
                      padding: '10px 12px',
                      backgroundColor: 'var(--warning-bg, #fffbeb)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      fontSize: '12px',
                      lineHeight: 1.45,
                      color: 'var(--text-secondary)',
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'flex-start',
                      gap: '10px',
                    }}
                  >
                    <span
                      style={{
                        flexShrink: 0,
                        fontSize: '10px',
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        padding: '4px 8px',
                        borderRadius: '4px',
                        backgroundColor: 'rgba(217, 119, 6, 0.18)',
                        color: 'var(--warning-text, #b45309)',
                      }}
                    >
                      Pending
                    </span>
                    <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                      <strong style={{ color: 'var(--text-primary)' }}>Period still open.</strong> Service tickets may still be
                      added through {periodAccumulationHintLabel(key.periodLabel)} — this batch is not complete for final
                      invoicing.
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const proj = projIdForPeriod ? projects?.find((p: { id: string; invoice_date_grouping?: string }) => p.id === projIdForPeriod) : null;
                        const cust = !projIdForPeriod ? customers?.find((c: { id: string; invoice_date_grouping?: string }) => c.id === custIdForPeriod) : null;
                        setEditingPeriodModal({
                          projectId: projIdForPeriod || null,
                          customerId: projIdForPeriod ? null : (custIdForPeriod || null),
                          value: proj?.invoice_date_grouping ?? cust?.invoice_date_grouping ?? '',
                        });
                      }}
                      style={{
                        flexShrink: 0,
                        alignSelf: 'center',
                        padding: '4px 10px',
                        backgroundColor: 'var(--bg-tertiary)',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '6px',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Edit Period
                    </button>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
                    {firstTicket?.customerName && (
                      <span>
                        <strong>Customer:</strong>{' '}
                        <CopyableHeaderValue copyText={firstTicket.customerName}>
                          {firstTicket.customerName}
                        </CopyableHeaderValue>
                      </span>
                    )}
                    <span>
                      <strong>IONEX project #:</strong>{' '}
                      <CopyableHeaderValue copyText={key.projectNumber?.trim() || ''}>
                        {key.projectNumber?.trim() || '(none)'}
                      </CopyableHeaderValue>
                    </span>
                    <span>
                      <strong>Project name:</strong>{' '}
                      <CopyableHeaderValue copyText={key.projectName?.trim() || ''}>
                        {key.projectName?.trim() || '(none)'}
                      </CopyableHeaderValue>
                    </span>
                    {key.periodKey ? (
                      <>
                        {key.approverCode && key.approverCode !== key.periodKey ? (
                          <span>
                            <strong>Approver:</strong>{' '}
                            <CopyableHeaderValue copyText={key.approverCode || key.approver || ''}>
                              {key.approverCode || key.approver || '(none)'}
                            </CopyableHeaderValue>
                          </span>
                        ) : null}
                        {key.cc ? (
                          <span>
                            <strong>Coding:</strong> <CopyableHeaderValue copyText={key.cc}>{key.cc}</CopyableHeaderValue>
                          </span>
                        ) : null}
                        <span>
                          <strong>Period:</strong>{' '}
                          <CopyableHeaderValue copyText={key.periodLabel || key.periodKey || ''}>
                            {key.periodLabel || key.periodKey}
                          </CopyableHeaderValue>
                        </span>
                      </>
                    ) : (
                      <>
                        <span>
                          <strong>Approver:</strong>{' '}
                          <CopyableHeaderValue copyText={key.approver || ''}>{key.approver || '(none)'}</CopyableHeaderValue>
                        </span>
                        <span><strong>PO/AFE/CC (Cost Center):</strong> {key.poAfe || '(none)'}</span>
                        <span><strong>Location:</strong> {key.location || '(none)'}</span>
                        <span>
                          <strong>Coding:</strong>{' '}
                          <CopyableHeaderValue copyText={key.cc && key.cc !== '(none)' ? key.cc : ''}>
                            {key.cc || '(none)'}
                          </CopyableHeaderValue>
                        </span>
                        <span><strong>Other:</strong> {key.other || '(none)'}</span>
                      </>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                    <button
                      onClick={() => handleExportSingleGroup(group)}
                      disabled={!!exportProgress || !!qboProgress || exportingGroupIdx !== null}
                      style={{
                        padding: '6px 12px',
                        backgroundColor: 'var(--primary-color)',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: exportProgress || qboProgress || exportingGroupIdx !== null ? 'not-allowed' : 'pointer',
                      }}
                      title="Download this group's merged PDF"
                    >
                      {isExportingGroup(groupId) ? 'Generating…' : 'Download'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (editingLabourNotesGroupId === groupId) {
                          setEditingLabourNotesGroupId(null);
                          setApplyLabourNotesToSimilarBatches(false);
                        } else {
                          setEditingLabourNotes(pendingLabourNotes[groupId] ?? {});
                          setApplyLabourNotesToSimilarBatches(false);
                          setEditingLabourNotesGroupId(groupId);
                        }
                      }}
                      style={{
                        padding: '6px 12px',
                        backgroundColor: editingLabourNotesGroupId === groupId ? 'var(--primary-color)' : 'var(--bg-tertiary)',
                        color: editingLabourNotesGroupId === groupId ? 'white' : 'var(--text-secondary)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '6px',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                      title="Short description for each rate type (ST/TT/FT/SO/FO) — used to justify or explain rates on the batch summary PDF cover page (e.g. 'overtime > 8 hrs')"
                    >
                      Edit rate descriptions
                    </button>
                    {groupIsPortalApproval ? (
                      <button
                        type="button"
                        onClick={() => handleMarkAsSubmittedForApproval(group)}
                        disabled={!!exportProgress || !!qboProgress || markInvoicedMutation.isPending}
                        style={{
                          padding: '6px 12px',
                          backgroundColor: 'rgba(245, 158, 11, 0.12)',
                          color: '#b45309',
                          border: '1px solid rgba(245, 158, 11, 0.55)',
                          borderRadius: '6px',
                          fontSize: '12px',
                          fontWeight: 700,
                          cursor:
                            exportProgress || qboProgress || markInvoicedMutation.isPending
                              ? 'not-allowed'
                              : 'pointer',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                        }}
                        title="Portal Approval flow: downloads the batch PDF for you to email/submit to the approver, then marks the batch as ready-to-send so it moves to the Submitted tab. Nothing is sent automatically. When the signed PDF comes back, drop it on the card under Submitted to advance to Approved."
                      >
                        <span aria-hidden style={{ fontSize: '13px' }}>📤</span>
                        {markInvoicedMutation.isPending ? 'Saving…' : 'Download for approval & mark ready to send'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setMarkInvoicedPromptGroup(group)}
                        onDragEnter={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (e.dataTransfer.types?.includes('Files')) setMarkInvoicedDropOverGroupId(groupId);
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (e.dataTransfer.types?.includes('Files')) {
                            e.dataTransfer.dropEffect = 'copy';
                            setMarkInvoicedDropOverGroupId(groupId);
                          }
                        }}
                        onDragLeave={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                            setMarkInvoicedDropOverGroupId((id) => (id === groupId ? null : id));
                          }
                        }}
                        onDrop={async (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setMarkInvoicedDropOverGroupId((id) => (id === groupId ? null : id));
                          const file = e.dataTransfer?.files?.[0];
                          if (!file) return;
                          await handleDropInvoiceOnMarkAsInvoiced(group, file);
                        }}
                        disabled={
                          !!exportProgress ||
                          !!qboProgress ||
                          markInvoicedMutation.isPending ||
                          uploadingInvoiceGroupId === groupId
                        }
                        style={{
                          padding: '6px 12px',
                          backgroundColor:
                            markInvoicedDropOverGroupId === groupId
                              ? 'rgba(34, 197, 94, 0.18)'
                              : 'rgba(34, 197, 94, 0.12)',
                          color: '#15803d',
                          border:
                            markInvoicedDropOverGroupId === groupId
                              ? '2px dashed #22c55e'
                              : '1px solid rgba(34, 197, 94, 0.55)',
                          borderRadius: '6px',
                          fontSize: '12px',
                          fontWeight: 700,
                          cursor:
                            exportProgress || qboProgress || markInvoicedMutation.isPending || uploadingInvoiceGroupId === groupId
                              ? 'not-allowed'
                              : 'pointer',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                        }}
                        title="Mark this batch as invoiced and lock its service tickets. Drop an invoice PDF here to attach it at the same time (recommended — invoices for non-portal customers normally go out immediately), or click to mark without a PDF and attach later."
                      >
                        <span aria-hidden style={{ fontSize: '13px' }}>📎</span>
                        {uploadingInvoiceGroupId === groupId
                          ? 'Attaching…'
                          : markInvoicedMutation.isPending
                            ? 'Saving…'
                            : 'Mark as invoiced (drop invoice PDF)'}
                      </button>
                    )}
                  </div>
                </div>
                {/* Labour notes editor */}
                {editingLabourNotesGroupId === groupId && (
                  <div style={{
                    marginBottom: '12px',
                    padding: '12px',
                    backgroundColor: 'var(--bg-secondary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    borderLeft: '4px solid var(--primary-color)',
                  }}>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      Edit Summary Descriptions
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '10px' }}>
                      Notes appear in brackets after the labour type on the summary PDF, e.g. <em>Shop Time (ST) (Conveyor installation)</em>
                    </div>
                    {SUMMARY_LABOUR_TYPES.map(({ key: ltKey, label: ltLabel }) => (
                      <div key={ltKey} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                        <span style={{ width: '150px', fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', flexShrink: 0 }}>{ltLabel}</span>
                        <input
                          type="text"
                          value={editingLabourNotes[ltKey] ?? ''}
                          onChange={(e) => setEditingLabourNotes((prev) => ({ ...prev, [ltKey]: e.target.value }))}
                          placeholder="Add a note…"
                          style={{
                            flex: 1,
                            padding: '4px 8px',
                            fontSize: '12px',
                            border: '1px solid var(--border-color)',
                            borderRadius: '4px',
                            backgroundColor: 'var(--bg-primary)',
                            color: 'var(--text-primary)',
                          }}
                        />
                      </div>
                    ))}
                    <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginTop: '10px', fontSize: '12px', color: 'var(--text-secondary)', cursor: 'pointer', lineHeight: 1.4 }}>
                      <input
                        type="checkbox"
                        checked={applyLabourNotesToSimilarBatches}
                        onChange={(e) => setApplyLabourNotesToSimilarBatches(e.target.checked)}
                        style={{ marginTop: '2px', flexShrink: 0 }}
                      />
                      <span>Also apply to every <strong>pending</strong> batch with the same project, approver, PO/AFE, and CC</span>
                    </label>
                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '10px' }}>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingLabourNotesGroupId(null);
                          setApplyLabourNotesToSimilarBatches(false);
                        }}
                        style={{ padding: '5px 12px', fontSize: '12px', border: '1px solid var(--border-color)', borderRadius: '5px', backgroundColor: 'var(--bg-tertiary)', cursor: 'pointer', color: 'var(--text-secondary)' }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const cleaned = Object.fromEntries(
                            Object.entries(editingLabourNotes).filter(([, v]) => v.trim())
                          );
                          const mk = summaryDescriptionMatchKey(key);
                          if (applyLabourNotesToSimilarBatches) {
                            setPendingLabourNotes((prev) => {
                              const next = { ...prev };
                              for (const g of uninvoicedGroups) {
                                if (summaryDescriptionMatchKey(g.key) === mk) {
                                  next[getGroupId(g)] = cleaned;
                                }
                              }
                              return next;
                            });
                          } else {
                            setPendingLabourNotes((prev) => ({ ...prev, [groupId]: cleaned }));
                          }
                          setApplyLabourNotesToSimilarBatches(false);
                          setEditingLabourNotesGroupId(null);
                        }}
                        style={{ padding: '5px 12px', fontSize: '12px', border: 'none', borderRadius: '5px', backgroundColor: 'var(--primary-color)', color: 'white', fontWeight: 600, cursor: 'pointer' }}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                )}
                <div style={{
                  marginBottom: '12px',
                  padding: '12px',
                  backgroundColor: 'var(--bg-tertiary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px',
                  borderLeft: '4px solid var(--primary-color)',
                }}>
                  {(() => {
                    const isCombined = combinedExpenseGroupIds.has(groupId);
                    const isSplitRatePending = splitRateGroupIds.has(groupId);
                    const pendingMode: BreakdownMode = isCombined ? 'combined' : isSplitRatePending ? 'split' : 'itemized';
                    const { lines: expLines } = computeGroupExpenseTotal(
                      groupTickets as (ServiceTicket & { recordId?: string })[],
                      expensesByRecordId
                    );
                    const hasExpenses = expLines.length > 0;
                    const expCount = expLines.length;
                    const getKeyFn = (t: ServiceTicket & { headerOverrides?: unknown; recordProjectId?: string; recordId?: string }) =>
                      getInvoiceGroupKey(
                        { projectId: t.recordProjectId ?? t.projectId, projectName: t.projectName, projectNumber: t.projectNumber, location: t.location, projectApproverPoAfe: t.projectApproverPoAfe, projectLocation: t.projectLocation, projectOther: t.projectOther, customerInfo: t.customerInfo, entries: t.entries },
                        t.headerOverrides as { approver_po_afe?: string; approver?: string; po_afe?: string; cc?: string; other?: string; service_location?: string } | undefined
                      );
                    const labourLines = isSplitRatePending
                      ? buildRateTypeBreakdown(groupTickets as (ServiceTicket & { recordId?: string })[], expensesByRecordId, false)
                      : (key.periodKey && key.approverCode === key.periodKey)
                      ? buildSingleLineBreakdown(groupTickets as (ServiceTicket & { recordId?: string })[], expensesByRecordId, isCombined)
                      : buildPoAfeBreakdown(groupTickets as (ServiceTicket & { headerOverrides?: unknown; recordProjectId?: string; recordId?: string })[], getKeyFn, expensesByRecordId, isCombined);
                    const categoryLabel = isCombined && hasExpenses
                      ? `labour & ${expCount === 1 ? 'expense' : 'expenses'}`
                      : undefined;
                    return (
                      <>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
                          <BreakdownModeToggle mode={pendingMode} onMode={(m) => {
                            setCombinedExpenseGroupIds((prev) => { const next = new Set(prev); if (m === 'combined') next.add(groupId); else next.delete(groupId); return next; });
                            setSplitRateGroupIds((prev) => { const next = new Set(prev); if (m === 'split') next.add(groupId); else next.delete(groupId); return next; });
                          }} />
                        </div>
                        {labourLines.map(({ ticketList, poAfe, totalAmount, splitRate, splitHours }, i) => (
                          <PoAfeBreakdownLine key={i} ticketList={ticketList} poAfe={poAfe} totalAmount={totalAmount} category={categoryLabel} splitRate={splitRate} splitHours={splitHours} />
                        ))}
                        {!isCombined && !isSplitRatePending && expLines.map((l, i) => {
                          const suffix = l.ticketNums.length > 0 ? ` (${formatTicketNumbersWithRanges(l.ticketNums)})` : '';
                          return (
                            <PoAfeBreakdownLine
                              key={`exp-${i}`}
                              ticketList={`${l.label}${suffix}`}
                              poAfe=""
                              totalAmount={l.amount}
                              category="expense"
                            />
                          );
                        })}
                        {isSplitRatePending && expLines.map((l, i) => {
                          const suffix = l.ticketNums.length > 0 ? ` (${formatTicketNumbersWithRanges(l.ticketNums)})` : '';
                          return (
                            <PoAfeBreakdownLine
                              key={`exp-split-${i}`}
                              ticketList={`${l.label}${suffix}`}
                              poAfe=""
                              totalAmount={l.amount}
                              category="expense"
                            />
                          );
                        })}
                      </>
                    );
                  })()}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {groupTickets.map((t) => {
                    const ticket = t as InvoiceTicketModalTicket;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setEditTicketRecordId(ticket.recordId?.trim() || ticket.id)}
                        style={{
                          padding: '4px 10px',
                          backgroundColor: 'var(--bg-tertiary)',
                          borderRadius: '6px',
                          fontSize: '13px',
                          color: 'inherit',
                          border: 'none',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          textAlign: 'left',
                        }}
                      >
                        {t.ticketNumber} – {t.userName} ({t.totalHours}h)
                      </button>
                    );
                  })}
                </div>
              </div>
            );
            });

            if (!sectionMulti) {
              return <Fragment key={section.key}>{cards[0]}</Fragment>;
            }
            return (
              <div
                key={section.key}
                style={{
                  padding: '12px',
                  backgroundColor: 'transparent',
                  border: '2px solid var(--border-color)',
                  borderRadius: '10px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: sectionCollapsed ? 0 : '12px' }}>
                  <button
                    type="button"
                    onClick={() => toggleSectionCollapsed('ready', section.key)}
                    aria-expanded={!sectionCollapsed}
                    title={sectionCollapsed ? 'Expand section' : 'Collapse section'}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '8px',
                      padding: '2px 6px', background: 'transparent', border: 'none',
                      color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    <span aria-hidden style={{ display: 'inline-block', transform: sectionCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s', fontSize: '12px' }}>▾</span>
                    <span style={{ fontSize: '15px', fontWeight: 700 }}>{section.customerName || 'Unknown customer'}</span>
                  </button>
                  {section.projectLine && (
                    <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{section.projectLine}</span>
                  )}
                  {section.periodLine && (
                    <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{section.periodLine}</span>
                  )}
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: '11px',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      padding: '3px 10px',
                      borderRadius: '999px',
                      backgroundColor: 'rgba(217, 119, 6, 0.12)',
                      color: 'var(--warning-text, #b45309)',
                      border: '1px solid rgba(217, 119, 6, 0.4)',
                    }}
                    title={`Each ${sectionBatchNoun} in this group is downloaded, ${sectionIsPortalApproval ? 'approved' : 'invoiced'}, and tracked separately.`}
                  >
                    {section.groups.length} separate {sectionBatchNoun}{section.groups.length === 1 ? '' : 's'} — handled individually
                  </span>
                </div>
                {!sectionCollapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {cards}
                  </div>
                )}
              </div>
            );
            })}
          </div>
          </>)}

          {/* Submitted for approval tab */}
          {activeTab === 'submitted' && (
            submittedApprovalGroups.length === 0 ? (
              <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
                No batches awaiting approval. From the Ready tab, click <strong>Download for approval & mark ready to send</strong> on a batch to prepare it for the approver.
              </div>
            ) : (
            <div>
              <div style={{ marginBottom: '12px' }}>
                <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                  Submitted for approval ({submittedApprovalGroups.length})
                </h3>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '4px 0 0' }}>
                  Waiting for the customer to approve. When the signed batch comes back, drop the PDF on the card to advance to Approved.
                </p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {submittedApprovalSections.map((section) => {
                  const isGrouped = section.groups.length > 1;
                  const renderBatch = (group: typeof section.groups[number], compact: boolean) => {
                    const persistId = resolvedPersistGroupId(group, invoicedMarkRows);
                    const customerName = group.tickets[0]?.customerName;
                    const wf = getWorkflowForCustomer(customerName, group.key.projectNumber);
                    const status = wf?.statuses?.find((s) => s.id === 'submitted_approval');
                    const statusHex = status ? statusColorHex(status.color) : '#888';
                    const projectLine = [group.key.projectNumber, group.key.projectName].filter(Boolean).join(' – ');
                    const periodLine = group.key.periodLabel || '';
                    const ticketCount = group.tickets.length;
                    const isUploading = uploadApprovalMutation.isPending && uploadApprovalMutation.variables?.groupId === persistId;
                    const codeFromKey = group.key.approverCode?.trim();
                    let approverDisplay: string | null = codeFromKey && codeFromKey.length > 0 ? codeFromKey : null;
                    if (!approverDisplay) {
                      const projNumLc = group.key.projectNumber?.toLowerCase().trim();
                      const proj = projects?.find((p) => (p.project_number || '').toLowerCase().trim() === projNumLc);
                      approverDisplay = proj?.approver?.trim() || null;
                    }
                    return (
                      <div
                        key={persistId}
                        style={{
                          padding: compact ? '12px 14px' : '16px',
                          backgroundColor: compact ? 'var(--bg-primary)' : 'var(--bg-secondary)',
                          borderRadius: '8px',
                          border: '1px solid var(--border-color)',
                          boxShadow: `inset 3px 0 0 0 ${statusHex}`,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '8px' }}>
                          {!compact && (
                            <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>{customerName || 'Unknown customer'}</span>
                          )}
                          {!compact && projectLine && (
                            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{projectLine}</span>
                          )}
                          {!compact && periodLine && (
                            <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{periodLine}</span>
                          )}
                          <span
                            style={{
                              fontSize: '12px',
                              fontWeight: 600,
                              padding: '2px 10px',
                              borderRadius: '999px',
                              backgroundColor: 'var(--bg-tertiary)',
                              color: 'var(--text-primary)',
                              border: '1px solid var(--border-color)',
                            }}
                            title="Approver for this batch"
                          >
                            Approver: {approverDisplay || '—'}
                          </span>
                          {status && (
                            <span
                              style={{
                                fontSize: '11px',
                                fontWeight: 700,
                                padding: '2px 10px',
                                borderRadius: '999px',
                                backgroundColor: `${statusHex}18`,
                                color: statusHex,
                                border: `1px solid ${statusHex}40`,
                                textTransform: 'uppercase',
                                letterSpacing: '0.04em',
                              }}
                            >
                              {status.label}
                            </span>
                          )}
                          <span style={{ marginLeft: 'auto', fontSize: '12px', color: 'var(--text-tertiary)' }}>{ticketCount} ticket(s)</span>
                        </div>
                        <div
                          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.style.borderColor = statusHex; }}
                          onDragLeave={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = ''; }}
                          onDrop={async (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            e.currentTarget.style.borderColor = '';
                            const file = e.dataTransfer?.files?.[0];
                            if (file?.type !== 'application/pdf' || !wf) return;
                            setExportError(null);
                            try {
                              await uploadApprovalMutation.mutateAsync({
                                groupId: persistId,
                                file,
                                customerName,
                                projectNumber: group.key.projectNumber || undefined,
                                workflow: wf,
                              });
                            } catch (err) {
                              setExportError(err instanceof Error ? err.message : 'Upload failed');
                            }
                          }}
                          onClick={() => document.getElementById(`approval-file-${persistId}`)?.click()}
                          style={{
                            border: '2px dashed var(--border-color)',
                            borderRadius: '8px',
                            padding: compact ? '10px 12px' : '14px 16px',
                            cursor: isUploading ? 'wait' : 'pointer',
                            backgroundColor: 'var(--bg-tertiary)',
                            textAlign: 'center',
                            fontSize: '13px',
                            color: 'var(--text-secondary)',
                          }}
                        >
                          <input
                            id={`approval-file-${persistId}`}
                            type="file"
                            accept=".pdf,application/pdf"
                            style={{ display: 'none' }}
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              e.target.value = '';
                              if (!file || !wf) return;
                              setExportError(null);
                              try {
                                await uploadApprovalMutation.mutateAsync({
                                  groupId: persistId,
                                  file,
                                  customerName,
                                  projectNumber: group.key.projectNumber || undefined,
                                  workflow: wf,
                                });
                              } catch (err) {
                                setExportError(err instanceof Error ? err.message : 'Upload failed');
                              }
                            }}
                          />
                          {isUploading
                            ? 'Uploading approval…'
                            : compact
                              ? `Drop signed PDF for ${approverDisplay || 'this approver'}, or click to choose`
                              : 'Drop signed batch PDF here, or click to choose a file'}
                        </div>
                        <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            disabled={redownloadingApprovalId === persistId}
                            onClick={async () => {
                              setExportError(null);
                              setRedownloadingApprovalId(persistId);
                              try {
                                const merged = await buildMergedBatchPdfBlob(group);
                                const filename = getApprovalBatchFilename(group.key, group.tickets, projects);
                                saveAs(merged, filename);
                              } catch (err) {
                                console.error('Re-download approval batch error:', err);
                                setExportError(err instanceof Error ? err.message : 'Could not generate batch PDF.');
                              } finally {
                                setRedownloadingApprovalId(null);
                              }
                            }}
                            title="Re-generate and download the merged batch PDF (Approver - Period.pdf). Does not change status."
                            style={{
                              padding: '6px 12px',
                              fontSize: '12px',
                              fontWeight: 600,
                              borderRadius: '6px',
                              border: '1px solid var(--border-color)',
                              backgroundColor: 'var(--bg-tertiary)',
                              color: 'var(--text-primary)',
                              cursor: redownloadingApprovalId === persistId ? 'wait' : 'pointer',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '6px',
                            }}
                          >
                            <span aria-hidden>📥</span>
                            {redownloadingApprovalId === persistId ? 'Building…' : 'Download batch again'}
                          </button>
                          <button
                            type="button"
                            disabled={unmarkInvoicedMutation.isPending}
                            onClick={() => setUndoApprovalConfirm({
                              persistId,
                              customerName: customerName || 'Unknown customer',
                              projectLine,
                              periodLine,
                              ticketCount,
                              scope: 'submitted',
                            })}
                            title="Undo submitted-for-approval. Returns the batch to the Ready tab so you can re-prepare or edit before re-sending."
                            style={{
                              padding: '6px 12px',
                              fontSize: '12px',
                              fontWeight: 500,
                              borderRadius: '6px',
                              border: '1px solid var(--border-color)',
                              backgroundColor: 'transparent',
                              color: 'var(--text-secondary)',
                              cursor: unmarkInvoicedMutation.isPending ? 'not-allowed' : 'pointer',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '6px',
                            }}
                          >
                            ↺ Undo
                          </button>
                        </div>
                      </div>
                    );
                  };

                  if (!isGrouped) {
                    return <Fragment key={section.key}>{renderBatch(section.groups[0], false)}</Fragment>;
                  }
                  const collapsed = isSectionCollapsed('submitted', section.key);
                  const bulkBuilding = bulkDownloadingSectionKey === section.key;
                  return (
                    <div
                      key={section.key}
                      style={{
                        padding: '14px',
                        backgroundColor: 'var(--bg-secondary)',
                        borderRadius: '10px',
                        border: '1px solid var(--border-color)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: collapsed ? 0 : '10px' }}>
                        <button
                          type="button"
                          onClick={() => toggleSectionCollapsed('submitted', section.key)}
                          aria-expanded={!collapsed}
                          title={collapsed ? 'Expand section' : 'Collapse section'}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: '8px',
                            padding: '2px 6px', background: 'transparent', border: 'none',
                            color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          <span aria-hidden style={{ display: 'inline-block', transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s', fontSize: '12px' }}>▾</span>
                          <span style={{ fontSize: '15px', fontWeight: 700 }}>{section.customerName || 'Unknown customer'}</span>
                        </button>
                        {section.projectLine && (
                          <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{section.projectLine}</span>
                        )}
                        {section.periodLine && (
                          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{section.periodLine}</span>
                        )}
                        <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{section.groups.length} batches · submit each separately</span>
                        <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            disabled={bulkBuilding}
                            onClick={async (e) => {
                              e.stopPropagation();
                              setExportError(null);
                              setBulkDownloadingSectionKey(section.key);
                              try {
                                for (const g of section.groups) {
                                  const merged = await buildMergedBatchPdfBlob(g);
                                  const filename = getApprovalBatchFilename(g.key, g.tickets, projects);
                                  saveAs(merged, filename);
                                }
                              } catch (err) {
                                console.error('Bulk re-download error:', err);
                                setExportError(err instanceof Error ? err.message : 'Could not generate one or more batch PDFs.');
                              } finally {
                                setBulkDownloadingSectionKey(null);
                              }
                            }}
                            title="Re-generate and download every approver batch PDF in this group. Each batch saves as its own file."
                            style={{
                              padding: '6px 10px', fontSize: '12px', fontWeight: 600,
                              borderRadius: '6px', border: '1px solid var(--border-color)',
                              backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                              cursor: bulkBuilding ? 'wait' : 'pointer',
                              display: 'inline-flex', alignItems: 'center', gap: '6px',
                            }}
                          >
                            <span aria-hidden>📥</span>
                            {bulkBuilding ? 'Building…' : `Download all (${section.groups.length})`}
                          </button>
                          <button
                            type="button"
                            disabled={unmarkInvoicedMutation.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              setUndoBulkApprovalConfirm({
                                sectionKey: section.key,
                                customerName: section.customerName || 'Unknown customer',
                                projectLine: section.projectLine,
                                periodLine: section.periodLine,
                                scope: 'submitted',
                                batches: section.groups.map((g) => ({
                                  persistId: resolvedPersistGroupId(g, invoicedMarkRows),
                                  approver: getApproverForGroupKey(g.key),
                                })),
                              });
                            }}
                            title="Undo every batch in this group — they all return to the Ready tab."
                            style={{
                              padding: '6px 10px', fontSize: '12px', fontWeight: 500,
                              borderRadius: '6px', border: '1px solid var(--border-color)',
                              backgroundColor: 'transparent', color: 'var(--text-secondary)',
                              cursor: unmarkInvoicedMutation.isPending ? 'not-allowed' : 'pointer',
                              display: 'inline-flex', alignItems: 'center', gap: '6px',
                            }}
                          >
                            ↺ Undo all
                          </button>
                        </div>
                      </div>
                      {!collapsed && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {section.groups.map((g) => renderBatch(g, true))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            )
          )}

          {/* Approved tab */}
          {activeTab === 'approved' && (
            approvedGroups.length === 0 ? (
              <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
                No approved batches yet. Drop a signed batch PDF on a Submitted card to advance it here.
              </div>
            ) : (
            <div>
              <div style={{ marginBottom: '12px' }}>
                <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                  Approved ({approvedGroups.length})
                </h3>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '4px 0 0' }}>
                  Customer has approved the batch. Drop the invoice PDF here, then click <strong>Move to Portal Submission</strong> to copy the details into the customer portal.
                </p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {approvedSections.map((section) => {
                  const isGrouped = section.groups.length > 1;
                  const renderBatch = (group: typeof section.groups[number], compact: boolean) => {
                    const persistId = resolvedPersistGroupId(group, invoicedMarkRows);
                    const customerName = group.tickets[0]?.customerName;
                    const wf = getWorkflowForCustomer(customerName, group.key.projectNumber);
                    const status = wf?.statuses?.find((s) => s.id === 'approved');
                    const statusHex = status ? statusColorHex(status.color) : '#3b82f6';
                    const projectLine = [group.key.projectNumber, group.key.projectName].filter(Boolean).join(' – ');
                    const periodLine = group.key.periodLabel || '';
                    const ticketCount = group.tickets.length;
                    const approval = savedApprovalMetadata?.[persistId];
                    const invoice = savedInvoiceMetadata?.[persistId];
                    const hasInvoice = !!invoice;
                    const isUploadingInvoice = uploadingInvoiceGroupId === persistId;
                    const isMarking = advanceToPortalSubmissionMutation.isPending && advanceToPortalSubmissionMutation.variables?.groupId === persistId;
                    const approverDisplay = getApproverForGroupKey(group.key);
                    return (
                    <div
                      key={persistId}
                      style={{
                        padding: compact ? '12px 14px' : '16px',
                        backgroundColor: compact ? 'var(--bg-primary)' : 'var(--bg-secondary)',
                        borderRadius: '8px',
                        border: '1px solid var(--border-color)',
                        boxShadow: `inset 3px 0 0 0 ${statusHex}`,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '8px' }}>
                        {!compact && (
                          <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>{customerName || 'Unknown customer'}</span>
                        )}
                        {!compact && projectLine && (
                          <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{projectLine}</span>
                        )}
                        {!compact && periodLine && (
                          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{periodLine}</span>
                        )}
                        <span
                          style={{
                            fontSize: '12px', fontWeight: 600, padding: '2px 10px', borderRadius: '999px',
                            backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)',
                          }}
                          title="Approver for this batch"
                        >
                          Approver: {approverDisplay || '—'}
                        </span>
                        {status && (
                          <span
                            style={{
                              fontSize: '11px',
                              fontWeight: 700,
                              padding: '2px 10px',
                              borderRadius: '999px',
                              backgroundColor: `${statusHex}18`,
                              color: statusHex,
                              border: `1px solid ${statusHex}40`,
                              textTransform: 'uppercase',
                              letterSpacing: '0.04em',
                            }}
                          >
                            {status.label}
                          </span>
                        )}
                        <span style={{ marginLeft: 'auto', fontSize: '12px', color: 'var(--text-tertiary)' }}>{ticketCount} ticket(s)</span>
                      </div>
                      {/* Attached approval pill */}
                      {approval && (
                        <div style={{ marginBottom: '8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                          Approval: <button
                            type="button"
                            onClick={async () => {
                              try {
                                const blob = await invoicedBatchApprovalsService.downloadApproval(approval.storagePath);
                                saveAs(blob, invoiceFilenameForDownload(approval.filename));
                              } catch (err) {
                                setExportError(err instanceof Error ? err.message : 'Download failed');
                              }
                            }}
                            style={{
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              color: 'var(--primary-color)',
                              textDecoration: 'underline',
                              cursor: 'pointer',
                              fontSize: '12px',
                              fontFamily: 'inherit',
                            }}
                          >
                            {approval.filename}
                          </button>
                        </div>
                      )}
                      {/* Invoice drop zone — only until invoice attached */}
                      {!hasInvoice && (
                        <div
                          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.style.borderColor = 'var(--primary-color)'; }}
                          onDragLeave={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = ''; }}
                          onDrop={async (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            e.currentTarget.style.borderColor = '';
                            const file = e.dataTransfer?.files?.[0];
                            if (file?.type !== 'application/pdf') return;
                            setUploadingInvoiceGroupId(persistId);
                            setExportError(null);
                            try {
                              const { filename: storedName } = await invoicedBatchInvoicesService.uploadInvoice(persistId, file);
                              const fileForUi = new File([file], storedName, { type: file.type });
                              setInvoiceFileForGroup(persistId, fileForUi);
                              await queryClient.invalidateQueries({ queryKey: ['invoicedBatchInvoices'] });
                            } catch (err) {
                              setExportError(err instanceof Error ? err.message : 'Upload failed');
                            } finally {
                              setUploadingInvoiceGroupId(null);
                            }
                          }}
                          onClick={() => document.getElementById(`invoice-file-approved-${persistId}`)?.click()}
                          style={{
                            border: '2px dashed var(--border-color)',
                            borderRadius: '8px',
                            padding: '14px 16px',
                            cursor: isUploadingInvoice ? 'wait' : 'pointer',
                            backgroundColor: 'var(--bg-tertiary)',
                            textAlign: 'center',
                            fontSize: '13px',
                            color: 'var(--text-secondary)',
                            marginBottom: '8px',
                          }}
                        >
                          <input
                            id={`invoice-file-approved-${persistId}`}
                            type="file"
                            accept=".pdf,application/pdf"
                            style={{ display: 'none' }}
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              e.target.value = '';
                              if (!file) return;
                              setUploadingInvoiceGroupId(persistId);
                              setExportError(null);
                              try {
                                const { filename: storedName } = await invoicedBatchInvoicesService.uploadInvoice(persistId, file);
                                const fileForUi = new File([file], storedName, { type: file.type });
                                setInvoiceFileForGroup(persistId, fileForUi);
                                await queryClient.invalidateQueries({ queryKey: ['invoicedBatchInvoices'] });
                              } catch (err) {
                                setExportError(err instanceof Error ? err.message : 'Upload failed');
                              } finally {
                                setUploadingInvoiceGroupId(null);
                              }
                            }}
                          />
                          {isUploadingInvoice ? 'Uploading invoice…' : 'Drop invoice PDF here, or click to choose a file'}
                        </div>
                      )}
                      {hasInvoice && (
                        <div style={{ marginBottom: '8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                          Invoice: <button
                            type="button"
                            onClick={async () => {
                              if (!invoice) return;
                              try {
                                const blob = await invoicedBatchInvoicesService.downloadInvoice(invoice.storagePath);
                                saveAs(blob, invoiceFilenameForDownload(invoice.filename));
                              } catch (err) {
                                setExportError(err instanceof Error ? err.message : 'Download failed');
                              }
                            }}
                            style={{
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              color: 'var(--primary-color)',
                              textDecoration: 'underline',
                              cursor: 'pointer',
                              fontSize: '12px',
                              fontFamily: 'inherit',
                            }}
                          >
                            {invoice.filename}
                          </button>
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                        <button
                          type="button"
                          onClick={() => {
                            if (!wf) return;
                            advanceToPortalSubmissionMutation.mutate({
                              groupId: persistId,
                              customerName,
                              projectNumber: group.key.projectNumber || undefined,
                              workflow: wf,
                            });
                          }}
                          disabled={!hasInvoice || isMarking}
                          title={hasInvoice ? 'Move to Portal Submission — copy invoice details into the customer portal there.' : 'Attach the invoice PDF first'}
                          style={{
                            padding: '8px 14px',
                            backgroundColor: hasInvoice ? 'var(--primary-color)' : 'var(--bg-tertiary)',
                            color: hasInvoice ? 'white' : 'var(--text-tertiary)',
                            border: '1px solid var(--border-color)',
                            borderRadius: '6px',
                            fontSize: '13px',
                            fontWeight: 600,
                            cursor: hasInvoice && !isMarking ? 'pointer' : 'not-allowed',
                          }}
                        >
                          {isMarking ? 'Saving…' : 'Move to Portal Submission'}
                        </button>
                        <button
                          type="button"
                          disabled={redownloadingApprovalId === persistId}
                          onClick={async () => {
                            setExportError(null);
                            setRedownloadingApprovalId(persistId);
                            try {
                              const merged = await buildMergedBatchPdfBlob(group);
                              const filename = getApprovalBatchFilename(group.key, group.tickets, projects);
                              saveAs(merged, filename);
                            } catch (err) {
                              console.error('Re-download approval batch error:', err);
                              setExportError(err instanceof Error ? err.message : 'Could not generate batch PDF.');
                            } finally {
                              setRedownloadingApprovalId(null);
                            }
                          }}
                          title="Re-generate and download the merged batch PDF (Approver - Period.pdf). Does not change status."
                          style={{
                            padding: '6px 12px',
                            fontSize: '12px',
                            fontWeight: 600,
                            borderRadius: '6px',
                            border: '1px solid var(--border-color)',
                            backgroundColor: 'var(--bg-tertiary)',
                            color: 'var(--text-primary)',
                            cursor: redownloadingApprovalId === persistId ? 'wait' : 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px',
                          }}
                        >
                          <span aria-hidden>📥</span>
                          {redownloadingApprovalId === persistId ? 'Building…' : 'Download batch again'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setUndoApprovalConfirm({
                            persistId,
                            customerName: customerName || 'Unknown customer',
                            projectLine,
                            periodLine,
                            ticketCount,
                            scope: 'approved',
                            workflowId: wf?.id,
                          })}
                          title="Undo approval. Deletes the attached signed PDF and returns the batch to the Submitted tab."
                          style={{
                            padding: '6px 12px',
                            fontSize: '12px',
                            fontWeight: 500,
                            borderRadius: '6px',
                            border: '1px solid var(--border-color)',
                            backgroundColor: 'transparent',
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px',
                          }}
                        >
                          ↺ Undo
                        </button>
                      </div>
                    </div>
                    );
                  };

                  if (!isGrouped) {
                    return <Fragment key={section.key}>{renderBatch(section.groups[0], false)}</Fragment>;
                  }
                  const collapsed = isSectionCollapsed('approved', section.key);
                  const bulkBuilding = bulkDownloadingSectionKey === section.key;
                  return (
                    <div
                      key={section.key}
                      style={{
                        padding: '14px',
                        backgroundColor: 'var(--bg-secondary)',
                        borderRadius: '10px',
                        border: '1px solid var(--border-color)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: collapsed ? 0 : '10px' }}>
                        <button
                          type="button"
                          onClick={() => toggleSectionCollapsed('approved', section.key)}
                          aria-expanded={!collapsed}
                          title={collapsed ? 'Expand section' : 'Collapse section'}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: '8px',
                            padding: '2px 6px', background: 'transparent', border: 'none',
                            color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          <span aria-hidden style={{ display: 'inline-block', transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s', fontSize: '12px' }}>▾</span>
                          <span style={{ fontSize: '15px', fontWeight: 700 }}>{section.customerName || 'Unknown customer'}</span>
                        </button>
                        {section.projectLine && (
                          <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{section.projectLine}</span>
                        )}
                        {section.periodLine && (
                          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{section.periodLine}</span>
                        )}
                        <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{section.groups.length} batches · advance each separately</span>
                        <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            disabled={bulkBuilding}
                            onClick={async (e) => {
                              e.stopPropagation();
                              setExportError(null);
                              setBulkDownloadingSectionKey(section.key);
                              try {
                                for (const g of section.groups) {
                                  const merged = await buildMergedBatchPdfBlob(g);
                                  const filename = getApprovalBatchFilename(g.key, g.tickets, projects);
                                  saveAs(merged, filename);
                                }
                              } catch (err) {
                                console.error('Bulk re-download error:', err);
                                setExportError(err instanceof Error ? err.message : 'Could not generate one or more batch PDFs.');
                              } finally {
                                setBulkDownloadingSectionKey(null);
                              }
                            }}
                            title="Re-generate and download every approver batch PDF in this group."
                            style={{
                              padding: '6px 10px', fontSize: '12px', fontWeight: 600,
                              borderRadius: '6px', border: '1px solid var(--border-color)',
                              backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                              cursor: bulkBuilding ? 'wait' : 'pointer',
                              display: 'inline-flex', alignItems: 'center', gap: '6px',
                            }}
                          >
                            <span aria-hidden>📥</span>
                            {bulkBuilding ? 'Building…' : `Download all (${section.groups.length})`}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setUndoBulkApprovalConfirm({
                                sectionKey: section.key,
                                customerName: section.customerName || 'Unknown customer',
                                projectLine: section.projectLine,
                                periodLine: section.periodLine,
                                scope: 'approved',
                                batches: section.groups.map((g) => {
                                  const cName = g.tickets[0]?.customerName;
                                  const wf = getWorkflowForCustomer(cName, g.key.projectNumber);
                                  return {
                                    persistId: resolvedPersistGroupId(g, invoicedMarkRows),
                                    approver: getApproverForGroupKey(g.key),
                                    workflowId: wf?.id,
                                  };
                                }),
                              });
                            }}
                            title="Undo approval for every batch in this group — they all return to the Submitted tab and their signed PDFs are deleted."
                            style={{
                              padding: '6px 10px', fontSize: '12px', fontWeight: 500,
                              borderRadius: '6px', border: '1px solid var(--border-color)',
                              backgroundColor: 'transparent', color: 'var(--text-secondary)',
                              cursor: 'pointer',
                              display: 'inline-flex', alignItems: 'center', gap: '6px',
                            }}
                          >
                            ↺ Undo all
                          </button>
                        </div>
                      </div>
                      {!collapsed && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {section.groups.map((g) => renderBatch(g, true))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            )
          )}

          {/* Portal Submission tab — copy/paste fields for entering invoice details into the customer portal */}
          {activeTab === 'portal_submission' && (
            portalSubmissionGroups.length === 0 ? (
              <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
                No batches awaiting portal submission. From the Approved tab, attach the invoice PDF and click <strong>Move to Portal Submission</strong>.
              </div>
            ) : (
            <div>
              <div style={{ marginBottom: '12px' }}>
                <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                  Portal Submission ({portalSubmissionGroups.length})
                </h3>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '4px 0 0' }}>
                  Click any field to copy its value into the customer portal. When the portal entry is complete, click <strong>Mark as invoiced</strong>.
                </p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {portalSubmissionSections.map((section) => {
                  const isGrouped = section.groups.length > 1;
                  const renderBatch = (group: typeof section.groups[number], compact: boolean) => {
                    const persistId = resolvedPersistGroupId(group, invoicedMarkRows);
                    const customerName = group.tickets[0]?.customerName;
                    const wf = getWorkflowForCustomer(customerName, group.key.projectNumber);
                    const status = wf?.statuses?.find((s) => s.id === 'portal_submission');
                    const statusHex = status ? statusColorHex(status.color) : '#14b8a6';
                    const projectLine = [group.key.projectNumber, group.key.projectName].filter(Boolean).join(' – ');
                    const periodLine = group.key.periodLabel || '';
                    const ticketCount = group.tickets.length;
                    const approval = savedApprovalMetadata?.[persistId];
                    const invoice = savedInvoiceMetadata?.[persistId];
                    const invoiceNumber = invoice?.filename ?? '';
                    const approvalCode = approval?.filename ?? '';
                    const description = group.key.projectName ?? '';
                    const approverDisplay = getApproverForGroupKey(group.key);

                    // Invoice date = period end date (data from original batch).
                    const firstTicket = group.tickets[0];
                    const custIdForPeriod = firstTicket?.customerId ?? '';
                    const projIdForPeriod =
                      (firstTicket as ServiceTicket & { recordProjectId?: string })?.recordProjectId ??
                      firstTicket?.projectId ??
                      '';
                    const grouping = cnrlPeriodGrouping(getGroupingForTicket(custIdForPeriod, projIdForPeriod));
                    const invoiceDate = group.key.periodKey
                      ? getPeriodEndYmd(group.key.periodKey, grouping) ?? ''
                      : '';

                    // Tickets paired — max 2 per field, joined with " - ".
                    const sortedTicketNums = group.tickets
                      .map((t) => t.ticketNumber)
                      .filter((n): n is string => !!n)
                      .sort((a, b) => ticketNumberSortValue(a) - ticketNumberSortValue(b));
                    const ticketPairs: string[] = [];
                    for (let i = 0; i < sortedTicketNums.length; i += 2) {
                      ticketPairs.push(sortedTicketNums.slice(i, i + 2).join(' - '));
                    }

                    // AFE/CC distinct values across tickets (CNRL splits one batch across multiple AFEs).
                    const afeSet = new Set<string>();
                    for (const t of group.tickets) {
                      const ov = (t as ServiceTicket & { headerOverrides?: { po_afe?: string; cc?: string } }).headerOverrides;
                      const afe = (ov?.po_afe ?? '').trim();
                      const cc = (ov?.cc ?? '').trim();
                      if (!afe && !cc) continue;
                      const combined = [afe, cc].filter(Boolean).join(' / ');
                      afeSet.add(combined);
                    }
                    const afeList = [...afeSet];

                    const isMarking = markFinalInvoicedMutation.isPending && markFinalInvoicedMutation.variables?.groupId === persistId;

                    return (
                    <div
                      key={persistId}
                      style={{
                        padding: compact ? '12px 14px' : '16px',
                        backgroundColor: compact ? 'var(--bg-primary)' : 'var(--bg-secondary)',
                        borderRadius: '8px',
                        border: '1px solid var(--border-color)',
                        boxShadow: `inset 3px 0 0 0 ${statusHex}`,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
                        {!compact && (
                          <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>{customerName || 'Unknown customer'}</span>
                        )}
                        {!compact && projectLine && (
                          <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{projectLine}</span>
                        )}
                        {!compact && periodLine && (
                          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{periodLine}</span>
                        )}
                        <span
                          style={{
                            fontSize: '12px', fontWeight: 600, padding: '2px 10px', borderRadius: '999px',
                            backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)',
                          }}
                          title="Approver for this batch"
                        >
                          Approver: {approverDisplay || '—'}
                        </span>
                        {status && (
                          <span
                            style={{
                              fontSize: '11px',
                              fontWeight: 700,
                              padding: '2px 10px',
                              borderRadius: '999px',
                              backgroundColor: `${statusHex}18`,
                              color: statusHex,
                              border: `1px solid ${statusHex}40`,
                              textTransform: 'uppercase',
                              letterSpacing: '0.04em',
                            }}
                          >
                            {status.label}
                          </span>
                        )}
                        <span style={{ marginLeft: 'auto', fontSize: '12px', color: 'var(--text-tertiary)' }}>{ticketCount} ticket(s)</span>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px', marginBottom: '12px' }}>
                        <PortalCopyField label="Invoice #" value={invoiceNumber} placeholder="(no invoice attached)" />
                        <PortalCopyField label="Invoice Date" value={invoiceDate} placeholder="(no period date)" />
                        <PortalCopyField label="Description" value={description} placeholder="(no project name)" />
                        <PortalCopyField label="Approval Code" value={approvalCode} placeholder="(no approval attached)" />
                      </div>

                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '6px' }}>
                          Tickets <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: 'var(--text-tertiary)' }}>(2 per field)</span>
                        </div>
                        {ticketPairs.length === 0 ? (
                          <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>No ticket numbers.</div>
                        ) : (
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '8px' }}>
                            {ticketPairs.map((pair, idx) => (
                              <PortalCopyField key={`${persistId}-tickets-${idx}`} label={`Tickets ${idx + 1}`} value={pair} />
                            ))}
                          </div>
                        )}
                      </div>

                      <div style={{ marginBottom: '14px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '6px' }}>
                          AFE / CC
                        </div>
                        {afeList.length === 0 ? (
                          <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>No AFE/CC on tickets.</div>
                        ) : (
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '8px' }}>
                            {afeList.map((afe, idx) => (
                              <PortalCopyField key={`${persistId}-afe-${idx}`} label={afeList.length > 1 ? `AFE/CC ${idx + 1}` : 'AFE/CC'} value={afe} />
                            ))}
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                        <button
                          type="button"
                          onClick={() => {
                            if (!wf) return;
                            markFinalInvoicedMutation.mutate({
                              groupId: persistId,
                              customerName,
                              projectNumber: group.key.projectNumber || undefined,
                              workflow: wf,
                            });
                          }}
                          disabled={isMarking}
                          title="Mark as invoiced — moves the batch to the Invoiced tab."
                          style={{
                            padding: '8px 14px',
                            backgroundColor: 'var(--primary-color)',
                            color: 'white',
                            border: '1px solid var(--border-color)',
                            borderRadius: '6px',
                            fontSize: '13px',
                            fontWeight: 600,
                            cursor: isMarking ? 'not-allowed' : 'pointer',
                          }}
                        >
                          {isMarking ? 'Saving…' : 'Mark as invoiced'}
                        </button>
                        {invoice && (
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const blob = await invoicedBatchInvoicesService.downloadInvoice(invoice.storagePath);
                                saveAs(blob, invoiceFilenameForDownload(invoice.filename));
                              } catch (err) {
                                setExportError(err instanceof Error ? err.message : 'Download failed');
                              }
                            }}
                            title="Download the attached invoice PDF."
                            style={{
                              padding: '6px 12px',
                              fontSize: '12px',
                              fontWeight: 600,
                              borderRadius: '6px',
                              border: '1px solid var(--border-color)',
                              backgroundColor: 'var(--bg-tertiary)',
                              color: 'var(--text-primary)',
                              cursor: 'pointer',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '6px',
                            }}
                          >
                            <span aria-hidden>📥</span> Invoice PDF
                          </button>
                        )}
                        {approval && (
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const blob = await invoicedBatchApprovalsService.downloadApproval(approval.storagePath);
                                saveAs(blob, invoiceFilenameForDownload(approval.filename));
                              } catch (err) {
                                setExportError(err instanceof Error ? err.message : 'Download failed');
                              }
                            }}
                            title="Download the signed approval PDF."
                            style={{
                              padding: '6px 12px',
                              fontSize: '12px',
                              fontWeight: 600,
                              borderRadius: '6px',
                              border: '1px solid var(--border-color)',
                              backgroundColor: 'var(--bg-tertiary)',
                              color: 'var(--text-primary)',
                              cursor: 'pointer',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '6px',
                            }}
                          >
                            <span aria-hidden>📥</span> Approval PDF
                          </button>
                        )}
                      </div>
                    </div>
                    );
                  };

                  if (!isGrouped) {
                    return <Fragment key={section.key}>{renderBatch(section.groups[0], false)}</Fragment>;
                  }
                  const collapsed = isSectionCollapsed('portal', section.key);
                  return (
                    <div
                      key={section.key}
                      style={{
                        padding: '14px',
                        backgroundColor: 'var(--bg-secondary)',
                        borderRadius: '10px',
                        border: '1px solid var(--border-color)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: collapsed ? 0 : '10px' }}>
                        <button
                          type="button"
                          onClick={() => toggleSectionCollapsed('portal', section.key)}
                          aria-expanded={!collapsed}
                          title={collapsed ? 'Expand section' : 'Collapse section'}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: '8px',
                            padding: '2px 6px', background: 'transparent', border: 'none',
                            color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          <span aria-hidden style={{ display: 'inline-block', transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s', fontSize: '12px' }}>▾</span>
                          <span style={{ fontSize: '15px', fontWeight: 700 }}>{section.customerName || 'Unknown customer'}</span>
                        </button>
                        {section.projectLine && (
                          <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{section.projectLine}</span>
                        )}
                        {section.periodLine && (
                          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{section.periodLine}</span>
                        )}
                        <span style={{ marginLeft: 'auto', fontSize: '12px', color: 'var(--text-tertiary)' }}>{section.groups.length} batches · submit each separately</span>
                      </div>
                      {!collapsed && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {section.groups.map((g) => renderBatch(g, true))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            )
          )}

          {/* Settings tab — per-customer / per-project workflow + grouping editors */}
          {activeTab === 'settings' && (() => {
            const groupingOptions = [
              { value: 'daily', label: 'Daily' },
              { value: 'weekly', label: 'Weekly' },
              { value: 'bi-weekly', label: 'Bi-weekly' },
              { value: 'monthly', label: 'Monthly' },
              { value: 'project-completion', label: 'Project completion' },
              { value: 'progress', label: 'Progress' },
            ];
            const workflowOptions = allWorkflows.map((w) => ({ value: w.id, label: w.name + (w.is_default ? ' (default)' : '') }));
            const defaultWorkflowName = defaultWorkflow?.name ?? '—';
            const q = settingsSearch.trim().toLowerCase();
            const filteredCustomers = (customers ?? []).filter((c: any) => !q || (c.name ?? '').toLowerCase().includes(q));
            const filteredProjects = (projects ?? []).filter((p: any) => {
              if (!q) return true;
              const blob = [p.name, p.project_number, p.customer?.name].filter(Boolean).join(' ').toLowerCase();
              return blob.includes(q);
            });
            const customerWorkflowName = (cid: string | null | undefined) => {
              if (!cid) return null;
              const c = customers?.find((x: any) => x.id === cid);
              if (!c?.invoice_workflow_id) return null;
              return allWorkflows.find((w) => w.id === c.invoice_workflow_id)?.name ?? null;
            };
            /** Effective grouping for a customer when no explicit value: app default is bi-weekly. */
            const effectiveCustomerGrouping = (cust: any): string =>
              cust?.invoice_date_grouping ?? 'bi-weekly';
            const customerById = (cid: string | null | undefined) =>
              cid ? customers?.find((x: any) => x.id === cid) : undefined;

            return (
              <div>
                <div style={{ display: 'flex', gap: '4px', marginBottom: '16px', borderBottom: '1px solid var(--border-color)' }}>
                  {(['customers', 'projects'] as const).map((sub) => {
                    const isActive = settingsTab === sub;
                    return (
                      <button
                        key={sub}
                        type="button"
                        onClick={() => setSettingsTab(sub)}
                        style={{
                          padding: '8px 14px',
                          backgroundColor: 'transparent',
                          border: 'none',
                          borderBottom: isActive ? '2px solid var(--primary-color)' : '2px solid transparent',
                          color: isActive ? 'var(--primary-color)' : 'var(--text-secondary)',
                          fontSize: '13px',
                          fontWeight: 600,
                          cursor: 'pointer',
                          marginBottom: '-1px',
                          textTransform: 'capitalize',
                        }}
                      >
                        {sub}
                      </button>
                    );
                  })}
                  <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px', paddingBottom: '6px' }}>
                    <input
                      type="text"
                      value={settingsSearch}
                      onChange={(e) => setSettingsSearch(e.target.value)}
                      placeholder={`Search ${settingsTab}…`}
                      style={{
                        padding: '6px 10px',
                        fontSize: '13px',
                        border: '1px solid var(--border-color)',
                        borderRadius: '6px',
                        backgroundColor: 'var(--bg-primary)',
                        color: 'var(--text-primary)',
                        width: '220px',
                      }}
                    />
                  </div>
                </div>

                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                  System default workflow: <strong>{defaultWorkflowName}</strong>. Workflow statuses managed on the <Link to="/invoice-workflows">Invoice Workflows</Link> page. Rate descriptions (per-batch) edited from each group card on the Pending/Ready/Invoiced tabs.
                </div>

                {settingsTab === 'customers' ? (
                  <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead style={{ backgroundColor: 'var(--bg-secondary)' }}>
                        <tr>
                          <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)' }}>Customer</th>
                          <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)' }}>Invoice workflow</th>
                          <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)' }}>Invoice grouping</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredCustomers.length === 0 ? (
                          <tr><td colSpan={3} style={{ padding: '20px', textAlign: 'center', color: 'var(--text-tertiary)' }}>No customers match.</td></tr>
                        ) : filteredCustomers.map((c: any) => (
                          <tr key={c.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                            <td style={{ padding: '8px 12px', fontWeight: 500 }}>{c.name}</td>
                            <td style={{ padding: '8px 12px' }}>
                              <select
                                value={c.invoice_workflow_id ?? ''}
                                onChange={(e) => updateWorkflowAssignmentMutation.mutate({ customerId: c.id, projectId: null, workflowId: e.target.value || null })}
                                style={{ padding: '4px 8px', fontSize: '13px', border: '1px solid var(--border-color)', borderRadius: '4px', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', minWidth: '180px' }}
                              >
                                <option value="">Use system default ({defaultWorkflowName})</option>
                                {workflowOptions.map((opt) => (
                                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                              </select>
                            </td>
                            <td style={{ padding: '8px 12px' }}>
                              <select
                                value={c.invoice_date_grouping ?? ''}
                                onChange={(e) => updatePeriodGroupingMutation.mutate({ customerId: c.id, projectId: null, value: e.target.value })}
                                style={{ padding: '4px 8px', fontSize: '13px', border: '1px solid var(--border-color)', borderRadius: '4px', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', minWidth: '200px' }}
                              >
                                <option value="">App default ({effectiveCustomerGrouping(c)})</option>
                                {groupingOptions.map((opt) => (
                                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead style={{ backgroundColor: 'var(--bg-secondary)' }}>
                        <tr>
                          <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)' }}>Project</th>
                          <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)' }}>Customer</th>
                          <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)' }}>Workflow override</th>
                          <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)' }}>Grouping override</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredProjects.length === 0 ? (
                          <tr><td colSpan={4} style={{ padding: '20px', textAlign: 'center', color: 'var(--text-tertiary)' }}>No projects match.</td></tr>
                        ) : filteredProjects.map((p: any) => {
                          const inheritedWf = customerWorkflowName(p.customer_id);
                          const wfFallback = inheritedWf ? `Inherit from customer (${inheritedWf})` : `Inherit from customer (${defaultWorkflowName})`;
                          const inheritedCust = customerById(p.customer_id);
                          const inheritedGrpEffective = inheritedCust ? effectiveCustomerGrouping(inheritedCust) : 'monthly';
                          const inheritedGrpExplicit = !!inheritedCust?.invoice_date_grouping;
                          const grpFallback = inheritedGrpExplicit
                            ? `Inherit from customer (${inheritedGrpEffective})`
                            : `Inherit from customer (${inheritedGrpEffective} — app default)`;
                          const label = [p.project_number, p.name].filter(Boolean).join(' – ') || p.id;
                          return (
                            <tr key={p.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                              <td style={{ padding: '8px 12px', fontWeight: 500 }}>{label}</td>
                              <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>{p.customer?.name ?? '—'}</td>
                              <td style={{ padding: '8px 12px' }}>
                                <select
                                  value={p.invoice_workflow_id ?? ''}
                                  onChange={(e) => updateWorkflowAssignmentMutation.mutate({ projectId: p.id, customerId: null, workflowId: e.target.value || null })}
                                  style={{ padding: '4px 8px', fontSize: '13px', border: '1px solid var(--border-color)', borderRadius: '4px', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', minWidth: '220px' }}
                                >
                                  <option value="">{wfFallback}</option>
                                  {workflowOptions.map((opt) => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                  ))}
                                </select>
                              </td>
                              <td style={{ padding: '8px 12px' }}>
                                <select
                                  value={p.invoice_date_grouping ?? ''}
                                  onChange={(e) => updatePeriodGroupingMutation.mutate({ projectId: p.id, customerId: null, value: e.target.value })}
                                  style={{ padding: '4px 8px', fontSize: '13px', border: '1px solid var(--border-color)', borderRadius: '4px', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', minWidth: '220px' }}
                                >
                                  <option value="">{grpFallback}</option>
                                  {groupingOptions.map((opt) => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })()}
        </>
      )}

      {invoiceTicketModalTicket && (
        <InvoiceTicketDetailModal
          ticket={invoiceTicketModalTicket}
          expenses={
            invoiceTicketModalTicket.recordId
              ? expensesByRecordId.get(invoiceTicketModalTicket.recordId) ?? []
              : []
          }
          onClose={() => setInvoiceTicketModalTicket(null)}
        />
      )}

      {undoApprovalConfirm && (() => {
        const isApprovedScope = undoApprovalConfirm.scope === 'approved';
        const title = isApprovedScope ? 'Undo approval?' : 'Undo submitted for approval?';
        const body = isApprovedScope
          ? 'The batch returns to the Submitted tab and the attached approval PDF is deleted. You can re-upload a different signed PDF or revert further to Ready from there.'
          : 'The batch returns to the Ready tab so you can re-prepare or edit before re-sending. The signed approval PDF (if any was attached) is removed.';
        const ctaLabel = isApprovedScope ? '↺ Return to Submitted' : '↺ Return to Ready';
        return (
          <div
            role="dialog"
            aria-modal="true"
            style={{
              position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 1000, padding: '20px',
            }}
            onClick={(e) => { if (e.target === e.currentTarget) setUndoApprovalConfirm(null); }}
          >
            <div style={{
              backgroundColor: 'var(--bg-primary)', borderRadius: '10px',
              padding: '20px', maxWidth: '480px', width: '100%',
              border: '1px solid var(--border-color)', boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
            }}>
              <h2 style={{ margin: '0 0 6px', fontSize: '16px', fontWeight: 700 }}>{title}</h2>
              <p style={{ margin: '0 0 14px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                <strong>{undoApprovalConfirm.customerName}</strong>{undoApprovalConfirm.projectLine ? ` — ${undoApprovalConfirm.projectLine}` : ''}{undoApprovalConfirm.periodLine ? ` · ${undoApprovalConfirm.periodLine}` : ''}<br />
                {undoApprovalConfirm.ticketCount} ticket{undoApprovalConfirm.ticketCount === 1 ? '' : 's'}. {body}
              </p>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => setUndoApprovalConfirm(null)}
                  style={{
                    padding: '8px 14px', fontSize: '13px', fontWeight: 600,
                    borderRadius: '6px', border: '1px solid var(--border-color)',
                    backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)', cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const confirm = undoApprovalConfirm;
                    setUndoApprovalConfirm(null);
                    if (confirm.scope === 'submitted') {
                      handleUnmarkAsInvoiced(confirm.persistId, { skipConfirm: true });
                      return;
                    }
                    // Approved → Submitted: delete approval PDF + revert status to submitted_approval
                    try {
                      await invoicedBatchApprovalsService.deleteApproval(confirm.persistId);
                      if (confirm.workflowId) {
                        const wf = allWorkflows.find((w) => w.id === confirm.workflowId);
                        const submittedStatus = wf?.statuses.find((s) => s.id === 'submitted_approval');
                        if (submittedStatus && wf) {
                          await updateBatchStatusMutation.mutateAsync({
                            groupId: confirm.persistId,
                            statusId: submittedStatus.id,
                            prevStatusId: 'approved',
                            statusLabel: submittedStatus.label,
                            customerName: confirm.customerName,
                            workflowId: wf.id,
                          });
                        }
                      }
                      await queryClient.invalidateQueries({ queryKey: ['invoicedBatchApprovals'] });
                    } catch (err) {
                      setExportError(err instanceof Error ? err.message : 'Could not revert approval.');
                    }
                  }}
                  style={{
                    padding: '8px 14px', fontSize: '13px', fontWeight: 600,
                    borderRadius: '6px', border: '1px solid var(--border-color)',
                    backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: '6px',
                  }}
                >
                  {ctaLabel}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {undoBulkApprovalConfirm && (() => {
        const isApprovedScope = undoBulkApprovalConfirm.scope === 'approved';
        const count = undoBulkApprovalConfirm.batches.length;
        const title = isApprovedScope ? `Undo approval for ${count} batches?` : `Undo submitted-for-approval for ${count} batches?`;
        const body = isApprovedScope
          ? 'Every batch in this group returns to the Submitted tab and each attached approval PDF is deleted. You can re-upload signed PDFs from there.'
          : 'Every batch in this group returns to the Ready tab so you can re-prepare or edit before re-sending. Any signed approval PDFs attached are removed.';
        const ctaLabel = isApprovedScope ? '↺ Return all to Submitted' : '↺ Return all to Ready';
        return (
          <div
            role="dialog"
            aria-modal="true"
            style={{
              position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 1000, padding: '20px',
            }}
            onClick={(e) => { if (e.target === e.currentTarget) setUndoBulkApprovalConfirm(null); }}
          >
            <div style={{
              backgroundColor: 'var(--bg-primary)', borderRadius: '10px',
              padding: '20px', maxWidth: '520px', width: '100%',
              border: '1px solid var(--border-color)', boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
            }}>
              <h2 style={{ margin: '0 0 6px', fontSize: '16px', fontWeight: 700 }}>{title}</h2>
              <p style={{ margin: '0 0 10px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                <strong>{undoBulkApprovalConfirm.customerName}</strong>{undoBulkApprovalConfirm.projectLine ? ` — ${undoBulkApprovalConfirm.projectLine}` : ''}{undoBulkApprovalConfirm.periodLine ? ` · ${undoBulkApprovalConfirm.periodLine}` : ''}<br />
                {body}
              </p>
              <ul style={{ margin: '0 0 14px 18px', padding: 0, fontSize: '12px', color: 'var(--text-tertiary)' }}>
                {undoBulkApprovalConfirm.batches.map((b) => (
                  <li key={b.persistId}>Approver: {b.approver || '—'}</li>
                ))}
              </ul>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => setUndoBulkApprovalConfirm(null)}
                  style={{
                    padding: '8px 14px', fontSize: '13px', fontWeight: 600,
                    borderRadius: '6px', border: '1px solid var(--border-color)',
                    backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)', cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const confirm = undoBulkApprovalConfirm;
                    setUndoBulkApprovalConfirm(null);
                    if (confirm.scope === 'submitted') {
                      for (const b of confirm.batches) {
                        handleUnmarkAsInvoiced(b.persistId, { skipConfirm: true });
                      }
                      return;
                    }
                    // Approved → Submitted, per batch
                    for (const b of confirm.batches) {
                      try {
                        await invoicedBatchApprovalsService.deleteApproval(b.persistId);
                        if (b.workflowId) {
                          const wf = allWorkflows.find((w) => w.id === b.workflowId);
                          const submittedStatus = wf?.statuses.find((s) => s.id === 'submitted_approval');
                          if (submittedStatus && wf) {
                            await updateBatchStatusMutation.mutateAsync({
                              groupId: b.persistId,
                              statusId: submittedStatus.id,
                              prevStatusId: 'approved',
                              statusLabel: submittedStatus.label,
                              customerName: confirm.customerName,
                              workflowId: wf.id,
                            });
                          }
                        }
                      } catch (err) {
                        setExportError(err instanceof Error ? err.message : 'Could not revert one or more approvals.');
                      }
                    }
                    await queryClient.invalidateQueries({ queryKey: ['invoicedBatchApprovals'] });
                  }}
                  style={{
                    padding: '8px 14px', fontSize: '13px', fontWeight: 600,
                    borderRadius: '6px', border: '1px solid var(--border-color)',
                    backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: '6px',
                  }}
                >
                  {ctaLabel}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {markInvoicedPromptGroup && (() => {
        const group = markInvoicedPromptGroup;
        const cust = group.tickets[0]?.customerName ?? 'Unknown customer';
        const projLine = [group.key.projectNumber, group.key.projectName].filter(Boolean).join(' – ');
        const ticketCount = group.tickets.length;
        return (
          <div
            role="dialog"
            aria-modal="true"
            style={{
              position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 1000, padding: '20px',
            }}
            onClick={(e) => { if (e.target === e.currentTarget) setMarkInvoicedPromptGroup(null); }}
          >
            <div style={{
              backgroundColor: 'var(--bg-primary)', borderRadius: '10px',
              padding: '20px', maxWidth: '480px', width: '100%',
              border: '1px solid var(--border-color)', boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
            }}>
              <h2 style={{ margin: '0 0 6px', fontSize: '16px', fontWeight: 700 }}>Attach invoice PDF?</h2>
              <p style={{ margin: '0 0 14px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                <strong>{cust}</strong>{projLine ? ` — ${projLine}` : ''}<br />
                {ticketCount} ticket{ticketCount === 1 ? '' : 's'}. You can attach the invoice PDF now or skip and attach later.
              </p>
              <input
                id="mark-invoiced-prompt-file"
                type="file"
                accept="application/pdf"
                style={{ display: 'none' }}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  const g = markInvoicedPromptGroup;
                  setMarkInvoicedPromptGroup(null);
                  if (g) await handleDropInvoiceOnMarkAsInvoiced(g, file);
                }}
              />
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => setMarkInvoicedPromptGroup(null)}
                  style={{
                    padding: '8px 14px', fontSize: '13px', fontWeight: 600,
                    borderRadius: '6px', border: '1px solid var(--border-color)',
                    backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)', cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const g = markInvoicedPromptGroup;
                    setMarkInvoicedPromptGroup(null);
                    if (g) handleMarkAsInvoiced(g);
                  }}
                  style={{
                    padding: '8px 14px', fontSize: '13px', fontWeight: 600,
                    borderRadius: '6px', border: '1px solid var(--border-color)',
                    backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', cursor: 'pointer',
                  }}
                >
                  Skip — mark only
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const el = document.getElementById('mark-invoiced-prompt-file') as HTMLInputElement | null;
                    el?.click();
                  }}
                  style={{
                    padding: '8px 14px', fontSize: '13px', fontWeight: 700,
                    borderRadius: '6px', border: '1px solid rgba(34, 197, 94, 0.55)',
                    backgroundColor: 'rgba(34, 197, 94, 0.12)', color: '#15803d', cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: '6px',
                  }}
                >
                  <span aria-hidden>📎</span>
                  Attach invoice PDF…
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {editingPeriodModal && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10050,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setEditingPeriodModal(null);
          }}
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              backgroundColor: 'var(--bg-primary)',
              borderRadius: '12px',
              width: '100%',
              maxWidth: 400,
              boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)',
              border: '1px solid var(--border-color)',
            }}
          >
            <div style={{ padding: '20px 20px 12px', borderBottom: '1px solid var(--border-color)' }}>
              <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>Edit Invoice Period</h2>
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                {editingPeriodModal.projectId
                  ? `Updating project-level setting`
                  : `Updating customer-level setting`}
              </div>
            </div>
            <div style={{ padding: '16px 20px 20px', display: 'grid', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: 'var(--text-primary)' }}>
                  Invoice Grouping
                </label>
                <select
                  value={editingPeriodModal.value}
                  onChange={(e) => setEditingPeriodModal({ ...editingPeriodModal, value: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    borderRadius: '6px',
                    border: '1px solid var(--border-color)',
                    backgroundColor: 'var(--bg-secondary)',
                    color: 'var(--text-primary)',
                    fontSize: '13px',
                  }}
                >
                  {editingPeriodModal.projectId && <option value="">Use customer default</option>}
                  {!editingPeriodModal.projectId && <option value="">App default (monthly)</option>}
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="bi-weekly">Bi-weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="project-completion">Project Completion</option>
                  <option value="progress">Progress</option>
                </select>
              </div>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => setEditingPeriodModal(null)}
                  style={{
                    padding: '7px 16px',
                    backgroundColor: 'var(--bg-tertiary)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={updatePeriodGroupingMutation.isPending}
                  onClick={() => updatePeriodGroupingMutation.mutate({
                    projectId: editingPeriodModal.projectId,
                    customerId: editingPeriodModal.customerId,
                    value: editingPeriodModal.value,
                  })}
                  style={{
                    padding: '7px 16px',
                    backgroundColor: 'var(--primary-color)',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: updatePeriodGroupingMutation.isPending ? 'not-allowed' : 'pointer',
                  }}
                >
                  {updatePeriodGroupingMutation.isPending ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editTicketRecordId && (
        <ServiceTickets
          pendingOpenRecord={editTicketRecordId}
          modalOnlyMode={{
            onClose: () => {
              setEditTicketRecordId(null);
              queryClient.invalidateQueries({ queryKey: ['ticketsReadyForExport'] });
              queryClient.invalidateQueries({ queryKey: ['billableEntriesForInvoices'] });
            },
          }}
        />
      )}
    </div>
  );
}
