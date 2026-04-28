import { useState, useMemo, useEffect, useCallback, type ReactNode } from 'react';
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
import { quickbooksClientService, isQuickBooksApiLocal } from '../services/quickbooksService';
import SearchableSelect from '../components/SearchableSelect';

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

/**
 * Align invoice-batch PDFs with the Approved tab on Service Tickets.
 * Prefer edited_hours + edited_descriptions (same snapshot as buildLockedTicketFromRecord); then total_hours;
 * only then merge edited_entry_overrides into live entries. Stale override keys (no longer matching time entry
 * ids) used to win first and left PDFs at raw entry hours while the list showed corrected totals.
 */
function augmentMatchTicketForInvoicePdf(rec: ApprovedRecord, match: ServiceTicket): Partial<ServiceTicket> | null {
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

  const overrides = rec.edited_entry_overrides;
  if (overrides && Object.keys(overrides).length > 0 && match.entries.length > 0) {
    const rows = mergePdfEntryOverridesIntoRows(match.entries, overrides);
    const entries = serviceRowsToTicketPdfEntries(rows, match);
    if (entries.length === 0) return null;
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
  const [copiedLine, setCopiedLine] = useState(false);
  const [copiedAmount, setCopiedAmount] = useState(false);
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
            style={{
              flexShrink: 0,
              alignSelf: 'flex-start',
              padding: '8px 14px',
              borderRadius: '8px',
              fontWeight: 600,
              color: 'var(--text-secondary)',
              fontSize: '13px',
              textAlign: 'right',
              whiteSpace: 'nowrap',
              border: '1px solid var(--border-color)',
              backgroundColor: 'var(--bg-primary)',
              boxShadow: shadowRest,
            }}
            title="Hours"
          >
            {splitHours.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}h
          </div>
          <div
            style={{
              flexShrink: 0,
              alignSelf: 'flex-start',
              padding: '8px 14px',
              borderRadius: '8px',
              fontWeight: 600,
              color: 'var(--text-secondary)',
              fontSize: '13px',
              textAlign: 'right',
              whiteSpace: 'nowrap',
              border: '1px solid var(--border-color)',
              backgroundColor: 'var(--bg-primary)',
              boxShadow: shadowRest,
            }}
            title="Rate"
          >
            ${splitRate.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/h
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
            flexShrink: 0,
            alignSelf: 'flex-start',
            padding: '8px 14px',
            borderRadius: '8px',
            cursor: 'pointer',
            fontWeight: 700,
            color: 'var(--primary-color)',
            fontSize: '14px',
            textAlign: 'right',
            whiteSpace: 'nowrap',
            border: '1px solid var(--border-color)',
            backgroundColor: copiedAmount ? 'var(--bg-secondary)' : 'var(--bg-primary)',
            boxShadow: hoverAmount || copiedAmount ? shadowHover : shadowRest,
            transition: 'box-shadow 0.2s ease, background-color 0.2s ease',
            userSelect: 'none',
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
  statusId?: string
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

/** Single line for non-CNRL period groups (no PO/AFE breakdown); poAfe empty so "PO/AFE/CC:" is not shown */
function buildSingleLineBreakdown(
  tickets: (ServiceTicket & { recordId?: string })[],
  expensesByRecordId: Map<string, InvoiceExpenseLine[]>,
  includeExpenses = false
): { ticketList: string; poAfe: string; totalAmount: number }[] {
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
): { ticketList: string; poAfe: string; totalAmount: number }[] {
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
): { ticketList: string; poAfe: string; totalAmount: number; splitRate?: number; splitHours?: number }[] {
  const RATE_TYPES = [
    { key: 'ST', label: 'Shop Time (ST)', rateField: 'rt' as const },
    { key: 'TT', label: 'Travel Time (TT)', rateField: 'tt' as const },
    { key: 'FT', label: 'Field Time (FT)', rateField: 'ft' as const },
    { key: 'SO', label: 'Shop OT (SO)', rateField: 'shop_ot' as const },
    { key: 'FO', label: 'Field OT (FO)', rateField: 'field_ot' as const },
  ];
  const hoursMap = new Map<string, number>();
  const rateMap = new Map<string, number>();
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
        hoursMap.set(key, (hoursMap.get(key) ?? 0) + h);
        rateMap.set(key, t.rates[rateField] || 0);
        if (t.ticketNumber) {
          const arr = numsMap.get(key) ?? [];
          arr.push(t.ticketNumber);
          numsMap.set(key, arr);
        }
      }
    }
  }
  const lines: { ticketList: string; poAfe: string; totalAmount: number; splitRate?: number; splitHours?: number }[] = [];
  for (const { key, label } of RATE_TYPES) {
    const hrs = hoursMap.get(key) ?? 0;
    if (hrs <= 0) continue;
    const rate = rateMap.get(key) ?? 0;
    const amount = Math.round(hrs * rate * 100) / 100;
    if (amount > 0) {
      const nums = numsMap.get(key) ?? [];
      const ticketList = formatTicketNumbersWithRanges([...nums].sort((a, b) => ticketNumberSortValue(a) - ticketNumberSortValue(b)));
      lines.push({ ticketList: ticketList ? `${label} (${ticketList})` : label, poAfe: '', totalAmount: amount, splitRate: rate, splitHours: hrs });
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

  // Date range filter - matches Service Tickets Approved tab (only show tickets in this range)
  const [startDate, setStartDate] = useState('2026-01-01');
  const [endDate, setEndDate] = useState(() => new Date().toISOString().split('T')[0]);

  const [selectedCustomerId, setSelectedCustomerId] = useState<string>(() => {
    try { return localStorage.getItem('ionex-inv-customer') || ''; } catch { return ''; }
  });
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => {
    try { return localStorage.getItem('ionex-inv-project') || ''; } catch { return ''; }
  });
  const defaultGrouping: DateRangeGrouping = 'monthly';

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

  const getWorkflowForCustomer = useCallback(
    (customerName: string | undefined): InvoiceWorkflowRow | undefined => {
      if (!customerName || allWorkflows.length === 0) return defaultWorkflow;
      const cust = customers?.find((c: any) => c.name === customerName);
      if (cust?.invoice_workflow_id) {
        return allWorkflows.find((w) => w.id === cust.invoice_workflow_id) ?? defaultWorkflow;
      }
      return defaultWorkflow;
    },
    [customers, allWorkflows, defaultWorkflow]
  );

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => projectsService.getAll(),
  });

  const getGroupingForCustomer = useCallback(
    (customerId: string) => {
      const customer = customers?.find((c: { id: string; name?: string; invoice_date_grouping?: string }) => c.id === customerId);
      if (customer?.invoice_date_grouping) return customer.invoice_date_grouping as DateRangeGrouping;
      const isCnrl = (customer?.name ?? '').toUpperCase().includes('CNRL');
      return isCnrl ? 'bi-weekly' : defaultGrouping;
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
        const ticketWithOverrides = applyHeaderOverridesToTicket(rawTicket, rec.header_overrides ?? undefined);
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
          entries: [],
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
        const standaloneWithOverrides = applyHeaderOverridesToTicket(rawStandalone, rec.header_overrides ?? undefined);
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

  /** Load all DB marks for anyone on Invoices (admin + developer). Do not gate on isAdmin: developer "User" toggle cleared isAdmin but marks-only batches would disappear from "See invoiced". */
  const loadInvoicedBatchMarks = !!user && !isDemoMode && canAccessInvoices(user);

  const { data: invoicedMarkRows = [] } = useQuery({
    queryKey: ['invoicedBatchMarks'],
    queryFn: () => invoicedBatchMarksService.getAll(),
    enabled: loadInvoicedBatchMarks,
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

  const [showInvoiced, setShowInvoiced] = useState(false);
  const [invoiceSearchQuery, setInvoiceSearchQuery] = useState('');
  const [invoiceStatusFilter, setInvoiceStatusFilter] = useState<string>('all');
  const [invoiceTicketModalTicket, setInvoiceTicketModalTicket] = useState<InvoiceTicketModalTicket | null>(null);
  const [invoicedBreakdownExpanded, setInvoicedBreakdownExpanded] = useState<Set<string>>(new Set());
  const [combinedExpenseGroupIds, setCombinedExpenseGroupIds] = useState<Set<string>>(new Set());
  const [splitRateGroupIds, setSplitRateGroupIds] = useState<Set<string>>(new Set());
  const [invoiceFilesByGroupId, setInvoiceFilesByGroupId] = useState<Record<string, File>>({});
  const [downloadingWithInvoiceGroupId, setDownloadingWithInvoiceGroupId] = useState<string | null>(null);
  const [uploadingInvoiceGroupId, setUploadingInvoiceGroupId] = useState<string | null>(null);
  const [markInvoicedDropOverGroupId, setMarkInvoicedDropOverGroupId] = useState<string | null>(null);
  const [editingLabourNotesGroupId, setEditingLabourNotesGroupId] = useState<string | null>(null);
  const [editingLabourNotes, setEditingLabourNotes] = useState<Record<string, string>>({});

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
    return mergeMarkSnapshotForGroup(group, prevFromDb, expensesCombined, statusId);
  };

  const handleMarkAsInvoiced = (group: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] }) => {
    const persistId = resolvedPersistGroupId(group, invoicedMarkRows);
    const isCombined = combinedExpenseGroupIds.has(getGroupId(group));
    const customerName = group.tickets[0]?.customerName;
    const wf = getWorkflowForCustomer(customerName);
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
        const mergedSnap = mergeMarkSnapshotForGroup(group, prev[persistId], isCombined || undefined, initialStatusId);
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

  /** Drop a PDF on "Mark as invoiced": upload (prod), mark, then same merged download as the invoiced drop zone. */
  const handleDropInvoiceOnMarkAsInvoiced = async (
    group: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] },
    file: File
  ) => {
    const persistId = resolvedPersistGroupId(group, invoicedMarkRows);
    const isCombined = combinedExpenseGroupIds.has(getGroupId(group));
    const customerName = group.tickets[0]?.customerName;
    const wf = getWorkflowForCustomer(customerName);
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

  const handleUnmarkAsInvoiced = (groupId: string) => {
    const hasInvoice = !!(invoiceFilesByGroupId[groupId] || savedInvoiceMetadata?.[groupId]);
    const msg = hasInvoice
      ? 'This will unmark the batch as invoiced and permanently delete the attached invoice PDF. Continue?'
      : 'This will unmark the batch as invoiced and move it back to pending. Continue?';
    if (!window.confirm(msg)) return;

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

  /** groupedTickets already excludes invoiced tickets, so all groups here are uninvoiced. */
  const uninvoicedGroups = groupedTickets;

  const filteredUninvoicedGroups = useMemo(() => {
    if (!invoiceSearchQuery.trim()) return uninvoicedGroups;
    const q = invoiceSearchQuery.trim().toLowerCase();
    return uninvoicedGroups.filter((g) => {
      const custName = g.tickets[0]?.customerName?.toLowerCase() ?? '';
      const projName = g.key.projectName?.toLowerCase() ?? '';
      const projNum = g.key.projectNumber?.toLowerCase() ?? '';
      const ticketNums = g.tickets.map(t => t.ticketNumber?.toLowerCase() ?? '').join(' ');
      return custName.includes(q) || projName.includes(q) || projNum.includes(q) || ticketNums.includes(q);
    });
  }, [uninvoicedGroups, invoiceSearchQuery]);

  const { data: savedInvoiceMetadata } = useQuery({
    queryKey: ['invoicedBatchInvoices', [...invoicedGroupIdsFromDb].sort().join(',')],
    queryFn: () => invoicedBatchInvoicesService.getMetadataByGroupIds(invoicedGroupIdsFromDb),
    enabled: showInvoiced && invoicedGroupIdsFromDb.length > 0,
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
    for (const g of invoicedGroups) {
      const pid = resolvedPersistGroupId(g, invoicedMarkRows);
      const snap = invoicedMarkRows.find((r) => r.group_id === pid)?.key_snapshot as FrozenGroupSnapshot | undefined;
      const wf = getWorkflowForCustomer(g.tickets[0]?.customerName);
      const sid = snap?.statusId ?? wf?.statuses?.[0]?.id;
      if (!sid) continue;
      const st = wf?.statuses?.find((s) => s.id === sid);
      if (!st) continue;
      const existing = map.get(sid);
      if (existing) existing.count++;
      else map.set(sid, { id: sid, label: st.label, color: st.color, count: 1 });
    }
    return [...map.values()];
  }, [invoicedGroups, invoicedMarkRows, getWorkflowForCustomer]);

  const sortedFilteredInvoicedGroups = useMemo(() => {
    let groups = [...invoicedGroups];
    groups.sort((a, b) => extractInvoiceNumber(getInvoiceLabel(b)) - extractInvoiceNumber(getInvoiceLabel(a)));

    if (invoiceStatusFilter !== 'all') {
      groups = groups.filter((g) => {
        const pid = resolvedPersistGroupId(g, invoicedMarkRows);
        const snap = invoicedMarkRows.find((r) => r.group_id === pid)?.key_snapshot as FrozenGroupSnapshot | undefined;
        const wf = getWorkflowForCustomer(g.tickets[0]?.customerName);
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
  }, [invoicedGroups, invoiceSearchQuery, invoiceStatusFilter, getInvoiceLabel, extractInvoiceNumber, invoicedMarkRows]);

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
    const exportLabourNotes = exportSnap?.labourNotes;
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
    const dlLabourNotes = dlSnap?.labourNotes;

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
          const summaryPdf = await generateBatchSummaryPdf(groupTickets, allExpenses);
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
            const summaryPdf = await generateBatchSummaryPdf(groupTickets, allExpenses);
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
      <h1 style={{ marginBottom: '8px', fontSize: '24px', fontWeight: 600 }}>Invoices</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '16px', fontSize: '14px' }}>
        {isCNRL
          ? 'Approved service tickets ready for PDF export, grouped by approver and period (default bi-weekly). Only tickets with an approver code (G### or PO) are shown — add PO/AFE/CC (Cost Center), Approver, and Coding to the project in Projects to include tickets. Marked-as-invoiced state is stored in the database (admins only).'
          : 'Approved service tickets grouped by project using the filters below (daily, weekly, bi-weekly, monthly, or one batch per project). Marked-as-invoiced is saved to the database with a snapshot of the batch so status stays consistent across devices (admins only).'}
        {' '}
        <strong>Only pending (not yet invoiced) batches</strong> appear in the list below. <strong>Mark as invoiced</strong> locks those service tickets until you unmark (no invoice PDF required). Use <strong>See invoiced</strong> for batches already marked—they stay locked the same way, with or without a linked PDF.
      </p>
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
          <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Start Date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={{
              padding: '8px 12px',
              backgroundColor: 'var(--bg-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              color: 'var(--text-primary)',
              fontSize: '14px',
            }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>End Date</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={{
              padding: '8px 12px',
              backgroundColor: 'var(--bg-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              color: 'var(--text-primary)',
              fontSize: '14px',
            }}
          />
        </div>
        <span style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>
          Filters pick which approved tickets can form pending batches (same idea as Service Tickets → Approved). Marked batches are not listed here—use See invoiced.
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
            padding: '12px',
            backgroundColor: 'rgba(239, 83, 80, 0.1)',
            border: '1px solid #ef5350',
            borderRadius: '8px',
            color: '#ef5350',
          }}
        >
          {exportError}
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

      {groupedTickets.length === 0 && invoicedGroups.length === 0 ? (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
          {selectedCustomerId
            ? 'No approved tickets for this customer in the selected date range. Approve service tickets first in the Service Tickets page.'
            : 'No approved tickets ready for export. Approve service tickets first in the Service Tickets page.'}
        </div>
      ) : groupedTickets.length === 0 && !showInvoiced ? (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
          All batches are marked as invoiced.
          <div style={{ marginTop: '12px' }}>
            <button
              onClick={() => setShowInvoiced(true)}
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
              See invoiced ({invoicedGroups.length})
            </button>
          </div>
        </div>
      ) : showInvoiced ? (
        <div>
          <div style={{ marginBottom: '16px', display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={() => setShowInvoiced(false)}
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
              ← Back to pending
            </button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>
                Invoiced batches (locked)
              </span>
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                {invoicedGroups.length} group(s) — service tickets in these batches cannot be edited until unmarked. A linked invoice PDF is optional.
              </span>
            </div>
          </div>
          {invoicedGroups.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
              No invoiced groups. Use "Back to pending" to return.
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
              const batchWorkflow = getWorkflowForCustomer(groupTickets[0]?.customerName);
              const batchStatusId = batchSnap?.statusId ?? batchWorkflow?.statuses?.[0]?.id;
              const batchCurrentStatus = batchWorkflow?.statuses?.find((s) => s.id === batchStatusId);
              const statusSinceDate = batchSnap?.statusChangedAt ?? batchMarkRow?.marked_at;
              const daysSinceStatus = statusSinceDate
                ? Math.floor((Date.now() - new Date(statusSinceDate).getTime()) / (1000 * 60 * 60 * 24))
                : null;
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
                          <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                            {daysSinceStatus === 0 ? 'today' : daysSinceStatus === 1 ? '1 day' : `${daysSinceStatus} days`}
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
                                } else {
                                  setEditingLabourNotes(batchSnap?.labourNotes ?? {});
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
                              title="Add notes to labour types on the summary PDF"
                            >
                              Edit descriptions
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
                          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '10px' }}>
                            <button
                              type="button"
                              onClick={() => setEditingLabourNotesGroupId(null)}
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
                                saveLabourNotesMutation.mutate({ groupId: persistId, labourNotes: cleaned });
                                setEditingLabourNotesGroupId(null);
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
                              onClick={() => setInvoiceTicketModalTicket(ticket)}
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
      ) : uninvoicedGroups.length === 0 ? (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
          All groups have been marked as invoiced.
          {invoicedGroups.length > 0 && (
            <div style={{ marginTop: '16px' }}>
              <button
                type="button"
                onClick={() => setShowInvoiced(true)}
                title="View batches already marked as invoiced (service tickets locked until unmarked; PDF optional)"
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
                See invoiced — locked ({invoicedGroups.length})
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div style={{ marginBottom: '14px' }}>
            <h2 style={{ fontSize: '18px', fontWeight: 600, margin: '0 0 6px', color: 'var(--text-primary)' }}>
              Pending
            </h2>
            <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.45, maxWidth: '900px' }}>
              Batches here are not marked as invoiced yet. <strong>Mark as invoiced</strong> saves the batch and locks the
              listed service tickets until you unmark. You do not need a PDF first; you can attach one later from See invoiced.
            </p>
          </div>
          <div style={{ marginBottom: '16px', display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={handleExportForInvoicing}
              disabled={!!exportProgress || !!qboProgress || uninvoicedGroups.length === 0}
              style={{
                padding: '10px 20px',
                backgroundColor: 'var(--primary-color)',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: 600,
                cursor: exportProgress || qboProgress ? 'not-allowed' : 'pointer',
              }}
            >
              Export for invoicing
            </button>
            <button
              onClick={handleCreateInQuickBooks}
              disabled={!effectiveQboConnected || !!exportProgress || !!qboProgress || uninvoicedGroups.length === 0}
              style={{
                padding: '10px 20px',
                backgroundColor: effectiveQboConnected ? '#0ea5e9' : 'var(--bg-tertiary)',
                color: effectiveQboConnected ? 'white' : 'var(--text-tertiary)',
                border: 'none',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: 600,
                cursor: effectiveQboConnected && !exportProgress && !qboProgress ? 'pointer' : 'not-allowed',
              }}
              title={!effectiveQboConnected ? 'Connect QuickBooks in Profile (admin) first' : 'Create invoices in QuickBooks Online'}
            >
              Create in QuickBooks
            </button>
            {!effectiveQboConnected && (
              <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                Connect QuickBooks in Profile (admin) to create invoices
              </span>
            )}
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              {uninvoicedGroups.reduce((sum, g) => sum + g.tickets.length, 0)} ticket(s) in {uninvoicedGroups.length} group(s)
            </span>
            <button
              onClick={() => setShowInvoiced(true)}
              style={{
                padding: '6px 14px',
                backgroundColor: 'var(--bg-tertiary)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                marginLeft: 'auto',
              }}
              title="View batches already marked as invoiced (service tickets locked until unmarked; PDF optional)"
            >
              See invoiced — locked ({invoicedGroups.length})
            </button>
          </div>

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
            {filteredUninvoicedGroups.map((group) => {
              const { key, tickets: groupTickets } = group;
              const groupId = getGroupId(group);
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
                      onClick={() => handleMarkAsInvoiced(group)}
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
                          markInvoicedDropOverGroupId === groupId ? 'rgba(59, 130, 246, 0.12)' : 'var(--bg-tertiary)',
                        color: 'var(--text-secondary)',
                        border:
                          markInvoicedDropOverGroupId === groupId
                            ? '2px dashed var(--primary-color)'
                            : '1px solid var(--border-color)',
                        borderRadius: '6px',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor:
                          exportProgress || qboProgress || markInvoicedMutation.isPending || uploadingInvoiceGroupId === groupId
                            ? 'not-allowed'
                            : 'pointer',
                      }}
                      title="Save this batch as invoiced and lock these service tickets until unmarked (no PDF required). Or drop an invoice PDF here to attach, mark, and download the merged batch."
                    >
                      {uploadingInvoiceGroupId === groupId
                        ? 'Attaching…'
                        : markInvoicedMutation.isPending
                          ? 'Saving…'
                          : 'Mark as invoiced'}
                    </button>
                  </div>
                </div>
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
                        onClick={() => setInvoiceTicketModalTicket(ticket)}
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
            })}
          </div>
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
    </div>
  );
}
