import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import {
  serviceTicketsService,
  serviceTicketExpensesService,
  customersService,
  employeesService,
  projectsService,
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
  const isNone = poAfe === '(none)';
  const copyText = isNone ? ticketList : `${ticketList}; PO/AFE/CC: ${poAfe}`;
  const displayText = isNone ? ticketList : `${ticketList}; PO/AFE/CC: ${poAfe}`;
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

function getGroupId(group: { key: InvoiceGroupKey; tickets: ServiceTicket[] }): string {
  const ids = group.tickets
    .map((t) => (t as ServiceTicket & { recordId?: string }).recordId || t.id)
    .filter(Boolean)
    .sort();
  return `${group.key.approverCode}|${ids.join(',')}`;
}

/** Build PO/AFE/CC breakdown with totals: "AR_xx1, AR_xx2; PO/AFE/CC: xxxxxxxx – $X,XXX.XX" */
function buildPoAfeBreakdown(
  tickets: (ServiceTicket & { headerOverrides?: unknown; recordProjectId?: string; recordId?: string })[],
  getKey: (t: typeof tickets[0]) => InvoiceGroupKey,
  expensesByRecordId: Map<string, Array<{ quantity: number; rate: number }>>
): { ticketList: string; poAfe: string; totalAmount: number }[] {
  const byPoAfe = new Map<string, { nums: string[]; tickets: typeof tickets }>();
  for (const t of tickets) {
    const key = getKey(t);
    const poAfe = (key.poAfe || '').trim() || '(none)';
    const entry = byPoAfe.get(poAfe) ?? { nums: [], tickets: [] };
    if (t.ticketNumber) entry.nums.push(t.ticketNumber);
    entry.tickets.push(t);
    byPoAfe.set(poAfe, entry);
  }
  return [...byPoAfe.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([poAfe, { nums, tickets: poAfeTickets }]) => {
      let totalAmount = 0;
      for (const t of poAfeTickets) {
        const recordId = (t as { recordId?: string }).recordId;
        const expenses = recordId ? (expensesByRecordId.get(recordId) ?? []) : [];
        totalAmount += calculateTicketTotalAmount(t, expenses);
      }
      return {
        ticketList: formatTicketNumbersWithRanges(nums),
        poAfe,
        totalAmount: Math.round(totalAmount * 100) / 100,
      };
    });
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
  const [startDate, setStartDate] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 30);
    return date.toISOString().split('T')[0];
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().split('T')[0]);

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

  // Group tickets by approver code only — all tickets with same approver code merge together
  // Exclude tickets without approver codes (they shouldn't be invoiced until a PO/approver is assigned)
  const groupedTickets = useMemo(() => {
    const groups = new Map<string, ServiceTicket[]>();
    for (const ticket of tickets) {
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
      // Skip tickets without a real approver code — only show tickets with G### or PO
      if (!keyObj.approverCode || keyObj.approverCode === '_') continue;
      const groupKey = `${keyObj.projectId ?? ''}|${keyObj.approverCode}`;
      const list = groups.get(groupKey) ?? [];
      list.push(ticket);
      groups.set(groupKey, list);
    }
    // Sort groups by approver code, then within each group: by employee, then by ticket number
    const result: { key: InvoiceGroupKey; tickets: ServiceTicket[] }[] = [];
    const sortedGroupKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
    for (const groupKey of sortedGroupKeys) {
      const list = groups.get(groupKey) ?? [];
      list.sort((a, b) => {
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
      result.push({ key: keyObj, tickets: list });
    }
    return result;
  }, [tickets]);

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

  const invoicedGroups = useMemo(
    () => groupedTickets.filter((g) => markedInvoicedIds.has(getGroupId(g))),
    [groupedTickets, markedInvoicedIds]
  );

  const visibleGroups = useMemo(
    () => groupedTickets.filter((g) => !markedInvoicedIds.has(getGroupId(g))),
    [groupedTickets, markedInvoicedIds]
  );

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
        const approverLabel = key.approverCode || 'no-approver';
        const dateStr = new Date().toISOString().split('T')[0];
        const filename = `Invoices_${approverLabel}_${dateStr}.pdf`;
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
          const approverLabel = key.approverCode || 'no-approver';
          const dateStr = new Date().toISOString().split('T')[0];
          const filename = `Invoices_${approverLabel}_${dateStr}.pdf`;
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

        // Sub-group by PO/AFE (each PO/AFE = one line item) - NO PARSING, use direct po_afe field
        const poAfeMap = new Map<string, ServiceTicket[]>();
        for (const ticket of groupTickets) {
          const t = ticket as ServiceTicket & { headerOverrides?: { approver?: string; po_afe?: string; cc?: string } };
          const { poAfe } = getApproverPoAfeCcFromTicket(t, t.headerOverrides);
          const poAfeKey = (poAfe || '').trim() || '(no PO/AFE)';
          const list = poAfeMap.get(poAfeKey) ?? [];
          list.push(ticket);
          poAfeMap.set(poAfeKey, list);
        }

        const poAfeLineItems: Array<{ poAfe: string; tickets: string[]; totalAmount: number }> = [];
        for (const [poAfe, poAfeTickets] of poAfeMap) {
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
            poAfe: poAfe === '(no PO/AFE)' ? '' : poAfe,
            tickets: ticketNumbers,
            totalAmount: Math.round(totalAmount * 100) / 100,
          });
        }

        const firstTicket = groupTickets[0];
        const { poAfe: customerPo } = getApproverPoAfeCcFromTicket(
          firstTicket,
          (firstTicket as ServiceTicket & { headerOverrides?: { approver?: string; po_afe?: string; cc?: string } }).headerOverrides
        );
        const reference = key.approverCode;
        const date = firstTicket.date || new Date().toISOString().split('T')[0];
        const docNumber = key.approverCode
          ? `INV-${key.approverCode}-${date.replace(/-/g, '')}`
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
            const filename = `ServiceTickets_${key.approverCode || 'group'}_${date}.pdf`;
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
        Approved service tickets ready for PDF export. Only tickets with an approver code (G### or PO) are shown — add PO/AFE/CC (Cost Center), Approver, and Coding to the project in Projects to include tickets.
      </p>
      <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end', marginBottom: '24px', flexWrap: 'wrap' }}>
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
          No approved tickets ready for export. Approve service tickets first in the Service Tickets page.
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
                      <span><strong>Approver:</strong> {key.approver || '(none)'}</span>
                      <span><strong>PO/AFE/CC (Cost Center):</strong> {key.poAfe || '(none)'}</span>
                      <span><strong>Location:</strong> {key.location || '(none)'}</span>
                      <span><strong>Coding:</strong> {key.cc || '(none)'}</span>
                      <span><strong>Other:</strong> {key.other || '(none)'}</span>
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
                    {buildPoAfeBreakdown(
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
                    <span><strong>Approver:</strong> {key.approver || '(none)'}</span>
                    <span><strong>PO/AFE/CC (Cost Center):</strong> {key.poAfe || '(none)'}</span>
                    <span><strong>Location:</strong> {key.location || '(none)'}</span>
                    <span><strong>Coding:</strong> {key.cc || '(none)'}</span>
                    <span><strong>Other:</strong> {key.other || '(none)'}</span>
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
                  {buildPoAfeBreakdown(
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
