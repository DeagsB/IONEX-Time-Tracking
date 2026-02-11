import { useState, useMemo } from 'react';
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
  InvoiceGroupKey,
} from '../utils/serviceTickets';
import { generateAndStorePdf, mergePdfBlobs } from '../utils/pdfFromHtml';
import { saveAs } from 'file-saver';

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
  header_overrides?: { approver_po_afe?: string; service_location?: string } | null;
};

/** Parse ticket number to extract numeric part for sorting (e.g. DB_25001 -> 25001) */
function ticketNumberSortValue(ticketNumber: string | undefined): number {
  if (!ticketNumber) return 0;
  const m = ticketNumber.match(/\d{3,}$/);
  return m ? parseInt(m[0], 10) : 0;
}

export default function Invoices() {
  const { user, isAdmin } = useAuth();
  const { isDemoMode } = useDemoMode();

  const [exportProgress, setExportProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Fetch approved tickets ready for export
  const { data: approvedRecords, isLoading: loadingApproved } = useQuery({
    queryKey: ['ticketsReadyForExport', isDemoMode],
    queryFn: () => serviceTicketsService.getTicketsReadyForExport(isDemoMode),
    enabled: isAdmin,
  });

  // Date range from approved tickets (with buffer for billable entries)
  const dateRange = useMemo(() => {
    if (!approvedRecords || approvedRecords.length === 0) {
      const today = new Date();
      const start = new Date(today);
      start.setDate(start.getDate() - 90);
      return {
        startDate: start.toISOString().split('T')[0],
        endDate: today.toISOString().split('T')[0],
      };
    }
    const dates = approvedRecords.map((r: ApprovedRecord) => r.date);
    const min = dates.reduce((a, b) => (a < b ? a : b), dates[0]);
    const max = dates.reduce((a, b) => (a > b ? a : b), dates[0]);
    const start = new Date(min);
    start.setDate(start.getDate() - 7);
    const end = new Date(max);
    end.setDate(end.getDate() + 7);
    return {
      startDate: start.toISOString().split('T')[0],
      endDate: end.toISOString().split('T')[0],
    };
  }, [approvedRecords]);

  const { startDate, endDate } = dateRange;

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
  const tickets = useMemo(() => {
    const baseTickets = billableEntries ? groupEntriesIntoTickets(billableEntries, employees) : [];
    const approved = (approvedRecords || []) as ApprovedRecord[];
    if (approved.length === 0) return [];

    const ticketList: (ServiceTicket & { recordId?: string; headerOverrides?: unknown; recordProjectId?: string })[] = [];

    // Add tickets that match approved records (from base or standalone)
    for (const rec of approved) {
      const ticketLocation = rec.location || '';
      const match = baseTickets.find(
        (bt) =>
          bt.date === rec.date &&
          bt.userId === rec.user_id &&
          (bt.customerId === rec.customer_id || (!rec.customer_id && bt.customerId === 'unassigned')) &&
          (bt.location || '') === ticketLocation
      );

      if (match) {
        ticketList.push({
          ...match,
          ticketNumber: rec.ticket_number,
          recordId: rec.id,
          headerOverrides: rec.header_overrides,
          recordProjectId: rec.project_id ?? match.projectId,
        });
      } else {
        // Standalone ticket
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
        const totalHours = Object.values(hoursByRateType).reduce((s, h) => s + h, 0);
        const customer = customers?.find((c: { id: string }) => c.id === rec.customer_id);
        const customerName = customer?.name || 'Unknown Customer';
        const emp = employees?.find((e: { user_id: string }) => e.user_id === rec.user_id);
        const u = emp?.user as { first_name?: string; last_name?: string } | undefined;
        const firstName = u?.first_name || '';
        const lastName = u?.last_name || '';
        const userName = `${firstName} ${lastName}`.trim() || 'Unknown';
        const userInitials = firstName && lastName ? `${firstName[0]}${lastName[0]}`.toUpperCase() : 'XX';
        const proj = projects?.find((p: { id: string }) => p.id === rec.project_id);
        ticketList.push({
          id: `${rec.date}-${rec.customer_id}-${rec.user_id}-${ticketLocation}`,
          date: rec.date,
          customerId: rec.customer_id || 'unassigned',
          customerName,
          location: ticketLocation || undefined,
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
          rates: { rt: 0, tt: 0, ft: 0, shop_ot: 0, field_ot: 0 },
          recordId: rec.id,
          headerOverrides: rec.header_overrides,
          recordProjectId: rec.project_id ?? undefined,
          projectId: rec.project_id ?? undefined,
          projectName: proj?.name,
          projectNumber: proj?.project_number,
          projectLocation: proj?.location,
          projectApproverPoAfe: proj?.approver_po_afe,
        });
      }
    }

    return ticketList;
  }, [billableEntries, employees, approvedRecords, customers, projects]);

  // Group tickets by project → approver → location → CC
  const groupedTickets = useMemo(() => {
    const groups = new Map<string, ServiceTicket[]>();
    for (const ticket of tickets) {
      const t = ticket as ServiceTicket & { headerOverrides?: unknown; recordProjectId?: string };
      const keyObj = getInvoiceGroupKey(
        {
          projectId: t.recordProjectId ?? t.projectId,
          location: t.location,
          projectApproverPoAfe: t.projectApproverPoAfe,
          projectLocation: t.projectLocation,
          customerInfo: t.customerInfo,
        },
        t.headerOverrides as { approver_po_afe?: string; service_location?: string } | undefined
      );
      const keyStr = JSON.stringify(keyObj);
      const list = groups.get(keyStr) ?? [];
      list.push(ticket);
      groups.set(keyStr, list);
    }
    // Sort within each group: by employee (userName), then by ticket number
    const result: { key: InvoiceGroupKey; tickets: ServiceTicket[] }[] = [];
    groups.forEach((list, keyStr) => {
      const key = JSON.parse(keyStr) as InvoiceGroupKey;
      list.sort((a, b) => {
        const nameCmp = (a.userName || '').localeCompare(b.userName || '');
        if (nameCmp !== 0) return nameCmp;
        return ticketNumberSortValue(a.ticketNumber) - ticketNumberSortValue(b.ticketNumber);
      });
      result.push({ key, tickets: list });
    });
    return result;
  }, [tickets]);

  const handleExportForInvoicing = async () => {
    setExportError(null);
    const total = groupedTickets.reduce((sum, g) => sum + g.tickets.length, 0);
    let processed = 0;

    setExportProgress({ current: 0, total, label: 'Preparing...' });

    try {
      for (let i = 0; i < groupedTickets.length; i++) {
        const { key, tickets: groupTickets } = groupedTickets[i];
        setExportProgress({
          current: processed,
          total,
          label: `Processing group ${i + 1}/${groupedTickets.length} (${groupTickets.length} ticket(s))`,
        });

        const blobs: Blob[] = [];
        for (const ticket of groupTickets) {
          const recordId = (ticket as ServiceTicket & { recordId?: string }).recordId;
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
          const label = [
            key.projectId ? `project-${key.projectId.slice(0, 8)}` : 'unknown',
            key.approverCode || 'no-approver',
            key.location || 'no-location',
            key.cc || 'no-cc',
          ]
            .filter(Boolean)
            .join('_');
          const filename = `Invoices_${label}_${new Date().toISOString().split('T')[0]}.pdf`;
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
      <p style={{ color: 'var(--text-secondary)', marginBottom: '24px', fontSize: '14px' }}>
        Approved service tickets ready for PDF export. Grouped by project, approver code (G###), location, and CC.
      </p>

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

      {groupedTickets.length === 0 ? (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
          No approved tickets ready for export. Approve service tickets first in the Service Tickets page.
        </div>
      ) : (
        <>
          <div style={{ marginBottom: '16px', display: 'flex', gap: '12px', alignItems: 'center' }}>
            <button
              onClick={handleExportForInvoicing}
              disabled={!!exportProgress}
              style={{
                padding: '10px 20px',
                backgroundColor: 'var(--primary-color)',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: 600,
                cursor: exportProgress ? 'not-allowed' : 'pointer',
              }}
            >
              Export for invoicing
            </button>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              {tickets.length} ticket(s) in {groupedTickets.length} group(s)
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {groupedTickets.map(({ key, tickets: groupTickets }, idx) => (
              <div
                key={idx}
                style={{
                  padding: '16px',
                  backgroundColor: 'var(--bg-secondary)',
                  borderRadius: '8px',
                  border: '1px solid var(--border-color)',
                }}
              >
                <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '8px' }}>
                  Project: {key.projectId || '(none)'} | Approver: {key.approverCode || '(none)'} | Location:{' '}
                  {key.location || '(none)'} | CC: {key.cc || '(none)'}
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
            ))}
          </div>
        </>
      )}
    </div>
  );
}
