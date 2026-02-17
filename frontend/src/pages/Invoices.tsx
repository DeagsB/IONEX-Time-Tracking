import { useState, useMemo, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import {
  serviceTicketsService,
  serviceTicketExpensesService,
  customersService,
  employeesService,
  projectsService,
  invoicedBatchInvoicesService,
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
import { generateAndStorePdf, mergePdfBlobs } from '../utils/pdfFromHtml';
import { saveAs } from 'file-saver';
import { quickbooksClientService } from '../services/quickbooksService';

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
  total_hours?: number | string | null;
  header_overrides?: { approver_po_afe?: string; service_location?: string } | null;
};

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

/** Single PO/AFE breakdown line with copy button (excludes total from copy) */
function PoAfeBreakdownLine({ ticketList, poAfe, totalAmount }: { ticketList: string; poAfe: string; totalAmount: number }) {
  const [copied, setCopied] = useState(false);
  const isNone = !poAfe || poAfe === '(none)' || poAfe === NO_PO_AFE_LABEL;
  const copyText = isNone ? ticketList : `PO/AFE/CC: ${poAfe}; ${ticketList}`;
  const displayText = isNone ? ticketList : `PO/AFE/CC: ${poAfe}; ${ticketList}`;
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', fontSize: '13px' }}>
      <span style={{ color: 'var(--text-primary)', flex: 1 }}>
        {displayText}
      </span>
      <span style={{ fontWeight: 700, color: 'var(--primary-color)', fontSize: '14px', minWidth: '70px', textAlign: 'right' }}>
        ${totalAmount.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
      <button
        onClick={handleCopy}
        title="Copy ticket list and PO/AFE/CC (excludes total)"
        style={{
          padding: '4px 8px',
          backgroundColor: copied ? 'var(--primary-color)' : 'var(--bg-secondary)',
          color: copied ? 'white' : 'var(--text-secondary)',
          border: '1px solid var(--border-color)',
          borderRadius: '4px',
          fontSize: '11px',
          fontWeight: 600,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}

const MARKED_INVOICED_STORAGE_KEY = 'ionex-invoices-marked';

export type DateRangeGrouping = 'daily' | 'weekly' | 'bi-weekly' | 'monthly';

/** Get period key for a ticket date for non-CNRL grouping (daily / weekly / bi-weekly / monthly) */
function getPeriodKey(dateStr: string, grouping: DateRangeGrouping): string {
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

type InvoiceGroupKeyWithPeriod = InvoiceGroupKey & { periodKey?: string; periodLabel?: string };

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

/** Single line for non-CNRL period groups (no PO/AFE breakdown); poAfe empty so "PO/AFE/CC:" is not shown */
function buildSingleLineBreakdown(
  tickets: (ServiceTicket & { recordId?: string })[],
  expensesByRecordId: Map<string, Array<{ quantity: number; rate: number }>>
): { ticketList: string; poAfe: string; totalAmount: number }[] {
  const nums = tickets.map((t) => t.ticketNumber).filter(Boolean) as string[];
  let totalAmount = 0;
  for (const t of tickets) {
    const recordId = t.recordId;
    const expenses = recordId ? (expensesByRecordId.get(recordId) ?? []) : [];
    totalAmount += calculateTicketTotalAmount(t, expenses);
  }
  return [{
    ticketList: formatTicketNumbersWithRanges(nums),
    poAfe: '',
    totalAmount: Math.round(totalAmount * 100) / 100,
  }];
}

const NO_PO_AFE_LABEL = '(no PO/AFE/CC)';

/** Build PO/AFE/CC breakdown with totals: "PO/AFE/CC: xxxxxxxx; AR_xx1, AR_xx2 – $X,XXX.XX". Sorted by PO/AFE value (ascending), with (no PO/AFE/CC) last. */
function buildPoAfeBreakdown(
  tickets: (ServiceTicket & { headerOverrides?: unknown; recordProjectId?: string; recordId?: string })[],
  getKey: (t: typeof tickets[0]) => InvoiceGroupKey,
  expensesByRecordId: Map<string, Array<{ quantity: number; rate: number }>>
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
        const recordId = (t as { recordId?: string }).recordId;
        const expenses = recordId ? (expensesByRecordId.get(recordId) ?? []) : [];
        totalAmount += calculateTicketTotalAmount(t, expenses);
      }
      return {
        ticketList: formatTicketNumbersWithRanges(sortedNums),
        poAfe,
        totalAmount: Math.round(totalAmount * 100) / 100,
      };
    })
    .filter((line) => line.poAfe !== NO_PO_AFE_LABEL);
}

export default function Invoices() {
  const { user, isAdmin } = useAuth();
  const { isDemoMode } = useDemoMode();

  const [exportProgress, setExportProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [qboProgress, setQboProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [qboError, setQboError] = useState<string | null>(null);
  const [qboCreatedIds, setQboCreatedIds] = useState<string[]>([]);

  // Date range filter - matches Service Tickets Approved tab (only show tickets in this range)
  const [startDate, setStartDate] = useState('2026-01-01');
  const [endDate, setEndDate] = useState(() => new Date().toISOString().split('T')[0]);

  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [dateRangeGroupingByCustomer, setDateRangeGroupingByCustomer] = useState<Record<string, DateRangeGrouping>>({});

  const { data: qboConnected } = useQuery({
    queryKey: ['qboStatus'],
    queryFn: () => quickbooksClientService.checkStatus(),
    enabled: isAdmin,
  });

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

  const getGroupingForCustomer = useCallback(
    (customerId: string) => {
      if (dateRangeGroupingByCustomer[customerId]) return dateRangeGroupingByCustomer[customerId];
      const customer = customers?.find((c: { id: string; name?: string }) => c.id === customerId);
      const isCnrl = (customer?.name ?? '').toUpperCase().includes('CNRL');
      return isCnrl ? 'bi-weekly' : 'monthly';
    },
    [dateRangeGroupingByCustomer, customers]
  );

  const { data: employees } = useQuery({
    queryKey: ['employees'],
    queryFn: () => employeesService.getAll(),
  });

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => projectsService.getAll(),
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
        if (rec.is_edited && rec.edited_hours) {
          const editedHours = rec.edited_hours as Record<string, number | number[]>;
          const hoursByRateType = { ...match.hoursByRateType };
          Object.keys(editedHours).forEach((rateType) => {
            if (rateType in hoursByRateType) {
              const hours = editedHours[rateType];
              (hoursByRateType as Record<string, number>)[rateType] = Array.isArray(hours)
                ? hours.reduce((s: number, h: number) => s + (h || 0), 0)
                : (hours as number) || 0;
            }
          });
          const totalHours = Object.values(hoursByRateType).reduce((s, h) => s + h, 0);
          const syntheticEntries = Object.entries(hoursByRateType)
            .filter(([, h]) => h > 0)
            .map(([rateType, hours]) => ({
              id: `syn-${rateType}`,
              date: match.date,
              hours,
              description: 'Work performed',
              rate_type: rateType,
              user_id: match.userId,
              user: match.entries[0]?.user,
              project_id: match.projectId,
              project: match.entries[0]?.project,
            })) as ServiceTicket['entries'];
          ticketToUse = {
            ...match,
            hoursByRateType,
            totalHours,
            entries: syntheticEntries.length > 0 ? syntheticEntries : match.entries,
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
    if (!selectedCustomerId) return tickets;
    return tickets.filter((t) => t.customerId === selectedCustomerId);
  }, [tickets, selectedCustomerId]);

  const selectedCustomer = customers?.find((c: { id: string }) => c.id === selectedCustomerId);
  const isCNRL = !!selectedCustomerId && (selectedCustomer?.name ?? '').toUpperCase().includes('CNRL');

  const isTicketCnrl = useCallback(
    (ticket: ServiceTicket) =>
      (customers?.find((c: { id: string }) => c.id === ticket.customerId)?.name ?? '').toUpperCase().includes('CNRL'),
    [customers]
  );

  // Group tickets: CNRL = by approver/PO/AFE etc.; non-CNRL = by project then date period (daily/weekly/bi-weekly/monthly)
  // When "All customers" is selected, split by customer: CNRL tickets use CNRL grouping, others use time-frame grouping
  const groupedTickets = useMemo((): { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] }[] => {
    const ticketsToGroupCnrl: ServiceTicket[] = [];
    const ticketsToGroupByPeriod: ServiceTicket[] = [];
    if (selectedCustomerId) {
      if (isCNRL) {
        ticketsToGroupCnrl.push(...ticketsForCustomer);
      } else {
        ticketsToGroupByPeriod.push(...ticketsForCustomer);
      }
    } else {
      for (const t of ticketsForCustomer) {
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
        const grouping = getGroupingForCustomer(customerIdForGrouping);
        const periodKey = getPeriodKey(t.date ?? '', grouping);
        const groupKey = `${keyObj.projectId ?? ''}|${keyObj.approverCode}|${periodKey}`;
        const list = groups.get(groupKey) ?? [];
        list.push(ticket);
        groups.set(groupKey, list);
      }
      // Sort CNRL groups by PO/AFE (approverCode) first, then period, then project (restore PO/AFE ordering)
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
        // Sort by PO/AFE/CC only (then name, ticket#) — Coding is not used for line order
        list.sort((a, b) => {
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
        const grouping = getGroupingForCustomer(customerIdForLabel);
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
        const grouping = singleCustomer ? getGroupingForCustomer(selectedCustomerId) : getGroupingForCustomer(t.customerId ?? '');
        const periodKey = getPeriodKey(t.date ?? '', grouping);
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
        const grouping = getGroupingForCustomer(customerIdForLabel);
        const periodLabel = getPeriodLabel(periodKey, grouping);
        const projectIdFromKey = singleCustomer ? parts[0]! : parts[1]!;
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

    return result;
  }, [ticketsForCustomer, selectedCustomerId, isCNRL, dateRangeGroupingByCustomer, getGroupingForCustomer, isTicketCnrl]);

  // Fetch expenses for all tickets (for CC breakdown totals)
  const [expensesByRecordId, setExpensesByRecordId] = useState<Map<string, Array<{ quantity: number; rate: number }>>>(new Map());
  useEffect(() => {
    const recordIds = new Set<string>();
    for (const { tickets: groupTickets } of groupedTickets) {
      for (const t of groupTickets) {
        const rid = (t as ServiceTicket & { recordId?: string }).recordId;
        if (rid) recordIds.add(rid);
      }
    }
    if (recordIds.size === 0) {
      setExpensesByRecordId(new Map());
      return;
    }
    let cancelled = false;
    const fetchAll = async () => {
      const map = new Map<string, Array<{ quantity: number; rate: number }>>();
      await Promise.all(
        [...recordIds].map(async (rid) => {
          try {
            const exp = await serviceTicketExpensesService.getByTicketId(rid);
            if (!cancelled) map.set(rid, exp.map((e) => ({ quantity: e.quantity, rate: e.rate })));
          } catch {
            if (!cancelled) map.set(rid, []);
          }
        })
      );
      if (!cancelled) setExpensesByRecordId(map);
    };
    fetchAll();
    return () => { cancelled = true; };
  }, [groupedTickets]);

  const [exportingGroupIdx, setExportingGroupIdx] = useState<string | null>(null);

  const [markedInvoicedIds, setMarkedInvoicedIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(MARKED_INVOICED_STORAGE_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw) as string[];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  });

  // Invoiced group IDs from DB (uploaded PDFs) — syncs across devices
  const { data: invoicedGroupIdsFromDb = [] } = useQuery({
    queryKey: ['invoicedBatchInvoices', 'allGroupIds'],
    queryFn: () => invoicedBatchInvoicesService.getAllInvoicedGroupIds(),
  });

  // Effective "marked as invoiced" = localStorage (this device) ∪ DB (any device)
  const effectiveMarkedInvoicedIds = useMemo(() => {
    const set = new Set(markedInvoicedIds);
    invoicedGroupIdsFromDb.forEach((id) => set.add(id));
    return set;
  }, [markedInvoicedIds, invoicedGroupIdsFromDb]);

  const handleMarkAsInvoiced = (groupId: string) => {
    setMarkedInvoicedIds((prev) => {
      const next = new Set(prev);
      next.add(groupId);
      try {
        localStorage.setItem(MARKED_INVOICED_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const handleUnmarkAsInvoiced = (groupId: string) => {
    setMarkedInvoicedIds((prev) => {
      const next = new Set(prev);
      next.delete(groupId);
      try {
        localStorage.setItem(MARKED_INVOICED_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const [showInvoiced, setShowInvoiced] = useState(false);
  const [invoicedBreakdownExpanded, setInvoicedBreakdownExpanded] = useState<Set<string>>(new Set());
  const [invoiceFilesByGroupId, setInvoiceFilesByGroupId] = useState<Record<string, File>>({});
  const [downloadingWithInvoiceGroupId, setDownloadingWithInvoiceGroupId] = useState<string | null>(null);
  const [uploadingInvoiceGroupId, setUploadingInvoiceGroupId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const setInvoiceFileForGroup = useCallback((groupId: string, file: File | null) => {
    setInvoiceFilesByGroupId((prev) => {
      const next = { ...prev };
      if (file) next[groupId] = file;
      else delete next[groupId];
      return next;
    });
  }, []);

  const invoicedGroups = useMemo(
    () => groupedTickets.filter((g) => effectiveMarkedInvoicedIds.has(getGroupId(g))),
    [groupedTickets, effectiveMarkedInvoicedIds]
  );

  const visibleGroups = useMemo(
    () => groupedTickets.filter((g) => !effectiveMarkedInvoicedIds.has(getGroupId(g))),
    [groupedTickets, effectiveMarkedInvoicedIds]
  );

  const invoicedGroupIds = useMemo(() => invoicedGroups.map((g) => getGroupId(g)), [invoicedGroups]);
  const { data: savedInvoiceMetadata } = useQuery({
    queryKey: ['invoicedBatchInvoices', [...invoicedGroupIds].sort().join(',')],
    queryFn: () => invoicedBatchInvoicesService.getMetadataByGroupIds(invoicedGroupIds),
    enabled: showInvoiced && invoicedGroupIds.length > 0,
  });

  const handleExportSingleGroup = async (group: { key: InvoiceGroupKey; tickets: ServiceTicket[] }) => {
    const { key, tickets: groupTickets } = group;
    const groupId = getGroupId(group);
    setExportingGroupIdx(groupId);
    setExportError(null);
    try {
      const blobs: Blob[] = [];
      for (const ticket of groupTickets) {
        const t = ticket as ServiceTicket & { recordId?: string; headerOverrides?: unknown };
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
      }
      if (blobs.length > 0) {
        const merged = await mergePdfBlobs(blobs);
        const filename = getInvoicePdfFilename(key, groupTickets);
        saveAs(merged, filename);
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
    let downloadFilename: string;
    if (invoiceFile) {
      invoiceBlob = invoiceFile;
      downloadFilename = invoiceFile.name || 'invoice.pdf';
    } else if (saved?.storagePath) {
      invoiceBlob = await invoicedBatchInvoicesService.downloadInvoice(saved.storagePath);
      downloadFilename = saved.filename || 'invoice.pdf';
    } else return;

    const { tickets: groupTickets } = group;
    setDownloadingWithInvoiceGroupId(groupId);
    setExportError(null);
    try {
      const blobs: Blob[] = [invoiceBlob];
      for (const ticket of groupTickets) {
        const t = ticket as ServiceTicket & { recordId?: string; headerOverrides?: unknown };
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
      }
      const merged = await mergePdfBlobs(blobs);
      saveAs(merged, downloadFilename);
    } catch (err) {
      console.error('Export with invoice error:', err);
      setExportError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setDownloadingWithInvoiceGroupId(null);
    }
  };

  const handleExportForInvoicing = async () => {
    setExportError(null);
    const total = visibleGroups.reduce((sum, g) => sum + g.tickets.length, 0);
    let processed = 0;

    setExportProgress({ current: 0, total, label: 'Preparing...' });

    try {
      for (let i = 0; i < visibleGroups.length; i++) {
        const { key, tickets: groupTickets } = visibleGroups[i];
        setExportProgress({
          current: processed,
          total,
          label: `Processing group ${i + 1}/${visibleGroups.length} (${groupTickets.length} ticket(s))`,
        });

        const blobs: Blob[] = [];
        for (const ticket of groupTickets) {
          const t = ticket as ServiceTicket & { recordId?: string; headerOverrides?: unknown };
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
          const filename = getInvoicePdfFilename(key, groupTickets);
          saveAs(merged, filename);
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
    setQboError(null);
    setQboCreatedIds([]);
    const total = visibleGroups.length;
    setQboProgress({ current: 0, total, label: 'Connecting to QuickBooks...' });

    try {
      for (let i = 0; i < visibleGroups.length; i++) {
        const { key, tickets: groupTickets } = visibleGroups[i];
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
          for (const ticket of groupTickets) {
            const t = ticket as ServiceTicket & { recordId?: string; headerOverrides?: unknown };
            const recordId = t.recordId;
            let expenses: Array<{ expense_type: string; description: string; quantity: number; rate: number; unit?: string }> = [];
            if (recordId) {
              try {
                expenses = await serviceTicketExpensesService.getByTicketId(recordId);
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
          ? 'Approved service tickets ready for PDF export, grouped by approver and period (default bi-weekly). Only tickets with an approver code (G### or PO) are shown — add PO/AFE/CC (Cost Center), Approver, and Coding to the project in Projects to include tickets.'
          : 'Approved service tickets grouped by project and selected date range (daily, weekly, bi-weekly, or monthly) for invoicing.'}
      </p>
      <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end', marginBottom: '24px', flexWrap: 'wrap' }}>
        <div>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Customer</label>
          <select
            value={selectedCustomerId}
            onChange={(e) => setSelectedCustomerId(e.target.value)}
            style={{
              padding: '8px 12px',
              backgroundColor: 'var(--bg-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              color: 'var(--text-primary)',
              fontSize: '14px',
              minWidth: '200px',
            }}
          >
            <option value="">All customers</option>
            {(customers ?? []).map((c: { id: string; name: string }) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        {selectedCustomerId && (
          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Group by</label>
            <select
              value={getGroupingForCustomer(selectedCustomerId)}
              onChange={(e) => setDateRangeGroupingByCustomer((prev) => ({ ...prev, [selectedCustomerId]: e.target.value as DateRangeGrouping }))}
              style={{
                padding: '8px 12px',
                backgroundColor: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'var(--text-primary)',
                fontSize: '14px',
              }}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="bi-weekly">Bi-weekly</option>
              <option value="monthly">Monthly</option>
            </select>
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
          Only tickets in this date range (matching Service Tickets Approved tab) are shown.
        </span>
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

      {groupedTickets.length === 0 ? (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
          {selectedCustomerId
            ? 'No approved tickets for this customer in the selected date range. Approve service tickets first in the Service Tickets page.'
            : 'No approved tickets ready for export. Approve service tickets first in the Service Tickets page.'}
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
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              {invoicedGroups.length} invoiced group(s)
            </span>
          </div>
          {invoicedGroups.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
              No invoiced groups. Use "Back to pending" to return.
            </div>
          ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {invoicedGroups.map((group) => {
              const { key, tickets: groupTickets } = group;
              const groupId = getGroupId(group);
              const isCnrlPeriodGroup = key.periodKey && key.approverCode && key.approverCode !== key.periodKey;
              const breakdownLines = key.periodKey && !isCnrlPeriodGroup
                ? buildSingleLineBreakdown(groupTickets as (ServiceTicket & { recordId?: string })[], expensesByRecordId)
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
                    expensesByRecordId
                  );
              const groupTotal = isCnrlPeriodGroup
                ? Math.round(
                    groupTickets.reduce((sum, t) => {
                      const recordId = (t as ServiceTicket & { recordId?: string }).recordId;
                      const expenses = recordId ? (expensesByRecordId.get(recordId) ?? []) : [];
                      return sum + calculateTicketTotalAmount(t as ServiceTicket & { recordId?: string }, expenses);
                    }, 0) * 100
                  ) / 100
                : breakdownLines.reduce((sum, line) => sum + line.totalAmount, 0);
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
              const isBreakdownExpanded = invoicedBreakdownExpanded.has(groupId);
              const uniquePoAfeFromBreakdown = [...new Set(breakdownLines.map((l) => l.poAfe).filter(Boolean))];
              const headerPoAfe =
                uniquePoAfeFromBreakdown.length === 0
                  ? '(none)'
                  : uniquePoAfeFromBreakdown.length === 1
                    ? uniquePoAfeFromBreakdown[0]!
                    : 'Multiple';
              const projectDisplay = (() => {
                const num = key.projectNumber?.trim();
                const name = key.projectName?.trim();
                return num && name ? `${num} – ${name}` : num || name || key.projectId || '(none)';
              })();
              return (
                <div
                  key={groupId}
                  style={{
                    padding: '16px',
                    backgroundColor: 'var(--bg-secondary)',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color)',
                  }}
                >
                  {/* Summary: project, approver, PO/AFE/CC, and total */}
                  <div style={{ marginBottom: '12px' }}>
                    <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }} title={projectDisplay}>
                      Project: {projectDisplay.length > 60 ? `${projectDisplay.slice(0, 60)}…` : projectDisplay}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px', display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                      <span><strong>Approver:</strong> {key.approverCode || key.approver || '(none)'}</span>
                      <span><strong>PO/AFE/CC:</strong> {headerPoAfe}</span>
                      {key.cc ? (
                        <span><strong>Coding:</strong> {key.cc}{key.periodLabel || key.periodKey ? <> · <strong>{key.periodLabel || key.periodKey}</strong></> : ''}</span>
                      ) : key.periodLabel || key.periodKey ? (
                        <span><strong>Period:</strong> <strong>{key.periodLabel || key.periodKey}</strong></span>
                      ) : null}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
                      <span style={{ fontSize: '20px', fontWeight: 700, color: 'var(--primary-color)' }}>
                        Total: ${groupTotal.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
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
                          onClick={() => handleUnmarkAsInvoiced(groupId)}
                          disabled={!!exportProgress || !!qboProgress}
                          style={{
                            padding: '6px 12px',
                            backgroundColor: 'var(--bg-tertiary)',
                            color: 'var(--text-secondary)',
                            border: '1px solid var(--border-color)',
                            borderRadius: '6px',
                            fontSize: '12px',
                            fontWeight: 600,
                            cursor: exportProgress || qboProgress ? 'not-allowed' : 'pointer',
                          }}
                          title="Move this group back to pending"
                        >
                          Unmark as invoiced
                        </button>
                      </div>
                    </div>
                  </div>
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
                        setUploadingInvoiceGroupId(groupId);
                        setExportError(null);
                        try {
                          await invoicedBatchInvoicesService.uploadInvoice(groupId, file);
                          setInvoiceFileForGroup(groupId, file);
                          await queryClient.invalidateQueries({ queryKey: ['invoicedBatchInvoices'] });
                          await handleDownloadBatchWithInvoice(group, groupId, file);
                        } catch (err) {
                          setExportError(err instanceof Error ? err.message : 'Upload failed');
                        } finally {
                          setUploadingInvoiceGroupId(null);
                        }
                      }}
                      onClick={() => document.getElementById(`invoice-file-${groupId}`)?.click()}
                      style={{
                        border: '2px dashed var(--border-color)',
                        borderRadius: '8px',
                        padding: '12px 16px',
                        cursor: uploadingInvoiceGroupId === groupId ? 'wait' : 'pointer',
                        backgroundColor: 'var(--bg-tertiary)',
                        marginBottom: '8px',
                      }}
                    >
                      <input
                        id={`invoice-file-${groupId}`}
                        type="file"
                        accept=".pdf,application/pdf"
                        style={{ display: 'none' }}
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (!file) return;
                          setUploadingInvoiceGroupId(groupId);
                          setExportError(null);
                          try {
                            await invoicedBatchInvoicesService.uploadInvoice(groupId, file);
                            setInvoiceFileForGroup(groupId, file);
                            await queryClient.invalidateQueries({ queryKey: ['invoicedBatchInvoices'] });
                            await handleDownloadBatchWithInvoice(group, groupId, file);
                          } catch (err) {
                            setExportError(err instanceof Error ? err.message : 'Upload failed');
                          } finally {
                            setUploadingInvoiceGroupId(null);
                          }
                        }}
                      />
                      {uploadingInvoiceGroupId === groupId ? (
                        <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Uploading…</span>
                      ) : invoiceFilesByGroupId[groupId] || savedInvoiceMetadata?.[groupId] ? (
                        <span style={{ fontSize: '13px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <span title={invoiceFilesByGroupId[groupId]?.name ?? savedInvoiceMetadata?.[groupId]?.filename}>
                            {invoiceFilesByGroupId[groupId]?.name ?? savedInvoiceMetadata?.[groupId]?.filename}
                          </span>
                          <button
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              setInvoiceFileForGroup(groupId, null);
                              try {
                                await invoicedBatchInvoicesService.deleteInvoice(groupId);
                                await queryClient.invalidateQueries({ queryKey: ['invoicedBatchInvoices'] });
                              } catch (err) {
                                setExportError(err instanceof Error ? err.message : 'Remove failed');
                              }
                            }}
                            style={{
                              padding: '2px 8px',
                              fontSize: '11px',
                              backgroundColor: 'var(--bg-primary)',
                              border: '1px solid var(--border-color)',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            Remove
                          </button>
                        </span>
                      ) : (
                        <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                          Drop invoice PDF here or click to choose (saved to storage)
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => handleDownloadBatchWithInvoice(group, groupId)}
                      disabled={!(invoiceFilesByGroupId[groupId] || savedInvoiceMetadata?.[groupId]) || !!exportProgress || !!qboProgress || downloadingWithInvoiceGroupId === groupId}
                      style={{
                        padding: '6px 12px',
                        backgroundColor: (invoiceFilesByGroupId[groupId] || savedInvoiceMetadata?.[groupId]) ? 'var(--primary-color)' : 'var(--bg-tertiary)',
                        color: (invoiceFilesByGroupId[groupId] || savedInvoiceMetadata?.[groupId]) ? 'white' : 'var(--text-tertiary)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '6px',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: (invoiceFilesByGroupId[groupId] || savedInvoiceMetadata?.[groupId]) && !exportProgress && !qboProgress && downloadingWithInvoiceGroupId !== groupId ? 'pointer' : 'not-allowed',
                      }}
                      title="Merge invoice PDF (first) with this batch and download"
                    >
                      {downloadingWithInvoiceGroupId === groupId ? 'Generating…' : 'Download batch with invoice'}
                    </button>
                  </div>
                  {/* Dropdown to show/hide detailed breakdown */}
                  <button
                    type="button"
                    onClick={() => {
                      setInvoicedBreakdownExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(groupId)) next.delete(groupId);
                        else next.add(groupId);
                        return next;
                      });
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      width: '100%',
                      padding: '8px 12px',
                      backgroundColor: 'var(--bg-tertiary)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      fontSize: '12px',
                      fontWeight: 600,
                      color: 'var(--text-secondary)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    {isBreakdownExpanded ? '▼' : '▶'} Invoice line item breakdown
                  </button>
                  {isBreakdownExpanded && (
                    <>
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
                        {breakdownLines.map(({ ticketList, poAfe, totalAmount }, i) => (
                          <PoAfeBreakdownLine key={i} ticketList={ticketList} poAfe={poAfe} totalAmount={totalAmount} />
                        ))}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
                        {groupTickets.map((t) => (
                          <span
                            key={t.id}
                            style={{
                              padding: '4px 10px',
                              backgroundColor: 'var(--bg-tertiary)',
                              borderRadius: '6px',
                              fontSize: '13px',
                            }}
                          >
                            {t.ticketNumber} – {t.userName} ({t.totalHours}h)
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          )}
        </div>
      ) : visibleGroups.length === 0 ? (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
          All groups have been marked as invoiced.
          {invoicedGroups.length > 0 && (
            <div style={{ marginTop: '16px' }}>
              <button
                onClick={() => setShowInvoiced(true)}
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
                See invoiced ({invoicedGroups.length})
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div style={{ marginBottom: '16px', display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={handleExportForInvoicing}
              disabled={!!exportProgress || !!qboProgress || visibleGroups.length === 0}
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
              disabled={!qboConnected || !!exportProgress || !!qboProgress || visibleGroups.length === 0}
              style={{
                padding: '10px 20px',
                backgroundColor: qboConnected ? '#0ea5e9' : 'var(--bg-tertiary)',
                color: qboConnected ? 'white' : 'var(--text-tertiary)',
                border: 'none',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: 600,
                cursor: qboConnected && !exportProgress && !qboProgress ? 'pointer' : 'not-allowed',
              }}
              title={!qboConnected ? 'Connect QuickBooks in Profile (admin) first' : 'Create invoices in QuickBooks Online'}
            >
              Create in QuickBooks
            </button>
            {!qboConnected && (
              <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                Connect QuickBooks in Profile (admin) to create invoices
              </span>
            )}
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              {visibleGroups.reduce((sum, g) => sum + g.tickets.length, 0)} ticket(s) in {visibleGroups.length} group(s)
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
              title="View groups marked as invoiced"
            >
              See invoiced ({invoicedGroups.length})
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {visibleGroups.map((group) => {
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
              return (
              <div
                key={groupId}
                style={{
                  padding: '16px',
                  backgroundColor: 'var(--bg-secondary)',
                  borderRadius: '8px',
                  border: '1px solid var(--border-color)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
                    <span title={[key.projectNumber, key.projectName].filter(Boolean).join(' – ') || key.projectId || '(none)'}>
                      <strong>Project:</strong>{' '}
                      {(() => {
                        const num = key.projectNumber?.trim();
                        const name = key.projectName?.trim();
                        const display = num && name ? `${num} – ${name}` : num || name || key.projectId || '(none)';
                        const maxLen = 40;
                        return display.length > maxLen ? `${display.slice(0, maxLen)}…` : display;
                      })()}
                    </span>
                    {key.periodKey ? (
                      <>
                        {key.approverCode && key.approverCode !== key.periodKey ? (
                          <span><strong>Approver:</strong> {key.approverCode || key.approver || '(none)'}</span>
                        ) : null}
                        <span><strong>Period:</strong> {key.periodLabel || key.periodKey}</span>
                      </>
                    ) : (
                      <>
                        <span><strong>Approver:</strong> {key.approver || '(none)'}</span>
                        <span><strong>PO/AFE/CC (Cost Center):</strong> {key.poAfe || '(none)'}</span>
                        <span><strong>Location:</strong> {key.location || '(none)'}</span>
                        <span><strong>Coding:</strong> {key.cc || '(none)'}</span>
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
                      onClick={() => handleMarkAsInvoiced(groupId)}
                      disabled={!!exportProgress || !!qboProgress}
                      style={{
                        padding: '6px 12px',
                        backgroundColor: 'var(--bg-tertiary)',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '6px',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: exportProgress || qboProgress ? 'not-allowed' : 'pointer',
                      }}
                      title="Mark this group as invoiced and hide it"
                    >
                      Mark as invoiced
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
                  <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                    Invoice Line Item Breakdown
                  </div>
                  {hasMissingPoAfe && (
                    <div style={{
                      marginBottom: '8px',
                      padding: '8px 12px',
                      backgroundColor: 'var(--warning-bg, #fff3cd)',
                      color: 'var(--warning-text, #856404)',
                      borderRadius: '6px',
                      fontSize: '12px',
                    }}>
                      PO/AFE/CC is missing for some entries.
                    </div>
                  )}
                  {((key.periodKey && key.approverCode === key.periodKey)
                    ? buildSingleLineBreakdown(
                        groupTickets as (ServiceTicket & { recordId?: string })[],
                        expensesByRecordId
                      )
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
                        expensesByRecordId
                      )
                  ).map(({ ticketList, poAfe, totalAmount }, i) => (
                    <PoAfeBreakdownLine key={i} ticketList={ticketList} poAfe={poAfe} totalAmount={totalAmount} />
                  ))}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {groupTickets.map((t) => (
                    <span
                      key={t.id}
                      style={{
                        padding: '4px 10px',
                        backgroundColor: 'var(--bg-tertiary)',
                        borderRadius: '6px',
                        fontSize: '13px',
                      }}
                    >
                      {t.ticketNumber} – {t.userName} ({t.totalHours}h)
                    </span>
                  ))}
                </div>
              </div>
            );
            })}
          </div>
        </>
      )}
    </div>
  );
}
