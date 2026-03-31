import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { supabase } from '../lib/supabaseClient';
import { timeEntriesService, employeesService, payRateHistoryService } from '../services/supabaseServices';
import { calculateBurden } from '../utils/employeeReports';
import { ticketExpenseCostForMargin } from '../utils/ticketExpenseReimbursement';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';
import DashboardWeeklyInsights from '../components/DashboardWeeklyInsights';
import { buildDashboardWeeklyInsights } from '../utils/dashboardWeeklyInsights';
import { localMondayWeekStartKey } from '../utils/localMondayWeek';

const fmt = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });

function dashExpenseReimbRate(exp: any, emp: any): number {
  const desc = (exp.description || '').toLowerCase();
  const expType = (exp.expense_type || '').toLowerCase();
  if (desc.includes('per diem')) return Number(emp?.per_diem_reimb_rate) || 1;
  if (expType === 'travel') return exp.needs_reimbursement === false ? 0 : Number(emp?.mileage_reimb_rate) || 0.9;
  if (expType === 'hotel' || desc.includes('hotel')) return exp.needs_reimbursement === false ? 0 : Number(emp?.hotel_reimb_rate) || 1;
  return 1;
}

export default function Dashboard() {
  const { isAdmin } = useAuth();
  const { isDemoMode } = useDemoMode();
  const navigate = useNavigate();

  const ticketTable = isDemoMode ? 'service_tickets_demo' : 'service_tickets';

  // ─── Tickets awaiting review (submitted, no ticket_number) ───
  const { data: awaitingReviewCount = 0 } = useQuery({
    queryKey: ['dash-awaiting-review', isDemoMode],
    queryFn: async () => {
      const { count, error } = await supabase
        .from(ticketTable)
        .select('*', { count: 'exact', head: true })
        .not('workflow_status', 'in', '("draft","rejected")')
        .is('ticket_number', null)
        .or('is_discarded.eq.false,is_discarded.is.null');
      if (error) return 0;
      return count ?? 0;
    },
    enabled: isAdmin,
  });

  // ─── Resubmitted tickets ───
  const { data: resubmittedCount = 0 } = useQuery({
    queryKey: ['dash-resubmitted', isDemoMode],
    queryFn: async () => {
      const { count, error } = await supabase
        .from(ticketTable)
        .select('*', { count: 'exact', head: true })
        .not('rejected_at', 'is', null)
        .not('workflow_status', 'in', '("draft","rejected")')
        .or('is_discarded.eq.false,is_discarded.is.null');
      if (error) return 0;
      return count ?? 0;
    },
    enabled: isAdmin,
  });

  // ─── Pending receipt reimbursements ───
  const { data: pendingExpenseCount = 0 } = useQuery({
    queryKey: ['dash-pending-expenses'],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('user_expenses')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending');
      if (error) return 0;
      return count ?? 0;
    },
    enabled: isAdmin,
  });

  // ─── Projects missing numbers ───
  const { data: missingNumberCount = 0 } = useQuery({
    queryKey: ['dash-missing-project-numbers'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('projects')
        .select('id, project_number')
        .or('active.eq.true,active.is.null');
      if (error) return 0;
      return (data || []).filter((p: any) => !p.project_number || String(p.project_number).trim() === '').length;
    },
    enabled: isAdmin,
  });

  // ─── Open bug reports ───
  const { data: openBugCount = 0 } = useQuery({
    queryKey: ['dash-open-bugs'],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('bug_reports')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'open');
      if (error) return 0;
      return count ?? 0;
    },
    enabled: isAdmin,
  });

  // ─── Financial: All non-draft/rejected tickets (for MTD Revenue, Uninvoiced WIP, revenue chart) ───
  const { data: ticketsRaw = [] } = useQuery({
    queryKey: ['dash-tickets-financials', isDemoMode],
    queryFn: async () => {
      const { data, error } = await supabase
        .from(ticketTable)
        .select('id, date, total_amount, total_hours, workflow_status, ticket_number, customer_id, project_id, is_discarded, customers(name)')
        .or('is_discarded.eq.false,is_discarded.is.null');
      if (error) throw error;
      return (data || []).filter((t: any) => {
        const ws = t.workflow_status || 'draft';
        return ws !== 'draft' && ws !== 'rejected';
      });
    },
    enabled: isAdmin,
  });

  // ─── Ticket expenses for cost (actual_cost) by ticket ───
  const { data: ticketExpensesRaw = [] } = useQuery({
    queryKey: ['dash-ticket-expenses', ticketsRaw.length, isDemoMode],
    queryFn: async () => {
      const ticketIds = (ticketsRaw as any[]).map((t: any) => t.id).filter(Boolean);
      if (ticketIds.length === 0) return [];
      const { data, error } = await supabase
        .from('service_ticket_expenses')
        .select('service_ticket_id, actual_cost, quantity, rate, needs_reimbursement, expense_type, description, service_tickets!inner(user_id)')
        .in('service_ticket_id', ticketIds);
      if (error) return [];
      return data || [];
    },
    enabled: isAdmin && (ticketsRaw as any[]).length > 0,
  });

  // ─── Time entries for labor cost ───
  const { data: allTimeEntries = [] } = useQuery({
    queryKey: ['allTimeEntries', isDemoMode],
    queryFn: () => timeEntriesService.getAll(isDemoMode),
    enabled: isAdmin,
  });

  const { data: employees = [] } = useQuery({
    queryKey: ['employees'],
    queryFn: () => employeesService.getAll(),
    enabled: isAdmin,
  });

  const { data: rateHistory = [] } = useQuery({
    queryKey: ['pay-rate-history'],
    queryFn: () => payRateHistoryService.getAll(),
    enabled: isAdmin,
  });

  // ─── Pending expense liability (pending user_expenses sum) ───
  const { data: pendingLiability = 0 } = useQuery({
    queryKey: ['dash-pending-liability'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('user_expenses')
        .select('amount, gst')
        .eq('status', 'pending');
      if (error) return 0;
      return (data || []).reduce((sum: number, r: any) => sum + (Number(r.amount) || 0) + (Number(r.gst) || 0), 0);
    },
    enabled: isAdmin,
  });

  // ─── Derived financial metrics ───
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  // Cost per ticket from expenses (aligned with Profitability / Employee Reports)
  const costByTicketId = useMemo(() => {
    const empByUserId = new Map<string, any>();
    for (const e of employees as any[]) {
      if (e.user_id) empByUserId.set(e.user_id, e);
    }
    const map = new Map<string, number>();
    for (const exp of ticketExpensesRaw as any[]) {
      const tid = exp.service_ticket_id;
      const emp = empByUserId.get(exp.service_tickets?.user_id);
      const lineCost = ticketExpenseCostForMargin(exp, dashExpenseReimbRate(exp, emp));
      map.set(tid, (map.get(tid) || 0) + lineCost);
    }
    return map;
  }, [ticketExpensesRaw, employees]);

  // Labor cost by week (from time entries: hours × pay rate × burden)
  const laborCostByWeek = useMemo(() => {
    const empByUserId = new Map<string, any>();
    for (const e of employees as any[]) {
      if (e.user_id) empByUserId.set(e.user_id, e);
    }
    const rateHistoryByEmpId = new Map<string, any[]>();
    for (const r of rateHistory as any[]) {
      const list = rateHistoryByEmpId.get(r.employee_id) || [];
      list.push(r);
      rateHistoryByEmpId.set(r.employee_id, list);
    }
    rateHistoryByEmpId.forEach((list) => list.sort((a: any, b: any) => (a.effective_date || '').localeCompare(b.effective_date || '')));

    const getRatesForDate = (emp: any, date: string) => {
      const history = rateHistoryByEmpId.get(emp?.id);
      if (!history?.length) return emp;
      let match = history[0];
      for (const h of history) {
        if ((h.effective_date || '') <= date) match = h;
        else break;
      }
      return match;
    };

    const weekMap = new Map<string, number>();
    for (const entry of allTimeEntries as any[]) {
      if (!entry.project_id || !entry.hours) continue;
      const hours = Number(entry.hours) || 0;
      const emp = empByUserId.get(entry.user_id);
      let payRate = 0;
      const rateType = entry.rate_type || 'Shop Time';
      if (emp) {
        const rates = getRatesForDate(emp, entry.date);
        if (rateType === 'Internal') payRate = Number(rates.internal_rate) || Number(rates.shop_pay_rate) || 0;
        else if (rateType === 'Shop Time') payRate = Number(rates.shop_pay_rate) || 0;
        else if (rateType === 'Field Time') payRate = Number(rates.field_pay_rate) || 0;
        else if (rateType === 'Travel Time') payRate = Number(rates.shop_pay_rate) || 0;
        else if (rateType === 'Shop Overtime') payRate = Number(rates.shop_ot_pay_rate) || 0;
        else if (rateType === 'Field Overtime') payRate = Number(rates.field_ot_pay_rate) || 0;
        payRate = payRate * (1 + calculateBurden(emp));
      }
      const weekKey = localMondayWeekStartKey(entry.date);
      weekMap.set(weekKey, (weekMap.get(weekKey) || 0) + hours * payRate);
    }
    return weekMap;
  }, [allTimeEntries, employees, rateHistory]);

  const { mtdRevenue, uninvoicedWip, revenueByWeek, topUnbilledCustomer } = useMemo(() => {
    let mtd = 0;
    let wip = 0;
    const weekMap = new Map<string, number>();
    const weekCostMap = new Map<string, number>();
    const custMap = new Map<string, number>();

    for (const t of ticketsRaw as any[]) {
      const amt = Number(t.total_amount) || 0;
      const cost = costByTicketId.get(t.id) || 0;

      if (t.date >= monthStart) mtd += amt;

      const hasTicketNumber = !!t.ticket_number;
      if (!hasTicketNumber) {
        wip += amt;

        const custName = t.customers?.name || 'Unknown';
        custMap.set(custName, (custMap.get(custName) || 0) + amt);
      }

      const weekKey = localMondayWeekStartKey(t.date);
      weekMap.set(weekKey, (weekMap.get(weekKey) || 0) + amt);
      weekCostMap.set(weekKey, (weekCostMap.get(weekKey) || 0) + cost);
    }

    // Add labor cost to each week
    for (const [weekKey, labor] of laborCostByWeek) {
      weekCostMap.set(weekKey, (weekCostMap.get(weekKey) || 0) + labor);
    }

    const weekKeysUnion = new Set<string>();
    for (const k of weekMap.keys()) weekKeysUnion.add(k);
    for (const k of weekCostMap.keys()) weekKeysUnion.add(k);

    const weeks = Array.from(weekKeysUnion)
      .sort((a, b) => a.localeCompare(b))
      .slice(-12)
      .map((weekKey) => {
        const d = new Date(`${weekKey}T12:00:00`);
        const label = `${d.toLocaleString('en', { month: 'short' })} ${d.getDate()}`;
        const rev = Math.round(weekMap.get(weekKey) || 0);
        const totalCost = Math.round(weekCostMap.get(weekKey) || 0);
        const profit = rev - totalCost;
        return { week: label, revenue: rev, totalCost, profit };
      });

    const sortedCust = Array.from(custMap.entries()).sort((a, b) => b[1] - a[1]);
    const top =
      sortedCust[0] != null
        ? {
            name:
              sortedCust[0][0].length > 28 ? sortedCust[0][0].slice(0, 26) + '…' : sortedCust[0][0],
            value: Math.round(sortedCust[0][1]),
          }
        : null;

    return { mtdRevenue: mtd, uninvoicedWip: wip, revenueByWeek: weeks, topUnbilledCustomer: top };
  }, [ticketsRaw, monthStart, costByTicketId, laborCostByWeek]);

  // ─── Action items (with search params to open Employee Overview on target page) ───
  const actionItems = [
    { label: 'Tickets Awaiting Review', count: awaitingReviewCount, path: '/service-tickets?overview=open&tab=submitted', color: '#3b82f6' },
    { label: 'Resubmitted Tickets', count: resubmittedCount, path: '/service-tickets?overview=open&tab=submitted', color: '#eab308' },
    { label: 'Pending Expense Approvals', count: pendingExpenseCount, path: '/expenses?overview=open&tab=pending', color: '#f59e0b' },
    { label: 'Projects Missing Numbers', count: missingNumberCount, path: '/projects?overview=open&missing=1', color: '#10b981' },
    { label: 'Open Bug Reports', count: openBugCount, path: '/service-tickets?overview=open&tab=submitted', color: '#ef4444' },
  ];

  const totalActionItems = actionItems.reduce((s, i) => s + i.count, 0);

  const weeklyInsights = useMemo(
    () =>
      buildDashboardWeeklyInsights({
        now: new Date(),
        ticketsRaw: ticketsRaw as any[],
        allTimeEntries: allTimeEntries as any[],
        revenueByWeek,
        uninvoicedWip,
        pendingLiability,
        topUnbilledCustomer,
        awaitingReviewCount,
        resubmittedCount,
        pendingExpenseCount,
        missingNumberCount,
        openBugCount,
        totalActionItems,
        mtdRevenue,
      }),
    [
      ticketsRaw,
      allTimeEntries,
      revenueByWeek,
      uninvoicedWip,
      pendingLiability,
      topUnbilledCustomer,
      awaitingReviewCount,
      resubmittedCount,
      pendingExpenseCount,
      missingNumberCount,
      openBugCount,
      totalActionItems,
      mtdRevenue,
    ],
  );

  if (!isAdmin) return null;

  return (
    <div style={{ padding: '32px 40px', maxWidth: '1400px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: '32px' }}>
        <h1 style={{ fontSize: '28px', fontWeight: '700', color: 'var(--text-primary)', margin: '0 0 4px 0' }}>
          Dashboard
        </h1>
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '14px' }}>
          Financial overview &amp; action items
        </p>
      </div>

      {/* ── KPI Cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '32px' }}>
        <KpiCard label="MTD Revenue" value={fmt(mtdRevenue)} color="#10b981" />
        <KpiCard label="Uninvoiced WIP" value={fmt(uninvoicedWip)} color="#3b82f6" />
        <KpiCard label="Pending Liability" value={fmt(pendingLiability)} color="#f59e0b" />
        <KpiCard label="Action Items" value={String(totalActionItems)} color={totalActionItems > 0 ? '#ef4444' : '#10b981'} />
      </div>

      {/* ── Action Items ── */}
      <div style={{
        backgroundColor: 'var(--bg-primary)',
        border: '1px solid var(--border-color)',
        borderRadius: '12px',
        padding: '24px',
        marginBottom: '32px',
      }}>
        <h2 style={{ margin: '0 0 16px', fontSize: '18px', fontWeight: '600', color: 'var(--text-primary)' }}>
          Action Items
        </h2>
        {totalActionItems === 0 ? (
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>All caught up — nothing requires attention.</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '12px' }}>
            {actionItems.filter(i => i.count > 0).map((item) => (
              <div
                key={item.label}
                onClick={() => navigate(item.path)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '14px',
                  padding: '14px 16px',
                  borderRadius: '10px',
                  backgroundColor: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  cursor: 'pointer',
                  transition: 'box-shadow .15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.boxShadow = 'var(--shadow-md, 0 4px 12px rgba(0,0,0,.08))'; }}
                onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none'; }}
              >
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: '36px', height: '36px', borderRadius: '10px',
                  backgroundColor: item.color + '18', color: item.color,
                  fontSize: '16px', fontWeight: '700',
                }}>
                  {item.count}
                </span>
                <span style={{ fontSize: '14px', fontWeight: '500', color: 'var(--text-primary)' }}>
                  {item.label}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Charts Row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        {/* Revenue Trend */}
        <div style={{
          backgroundColor: 'var(--bg-primary)',
          border: '1px solid var(--border-color)',
          borderRadius: '12px',
          padding: '24px',
        }}>
          <h2 style={{ margin: '0 0 8px', fontSize: '18px', fontWeight: '600', color: 'var(--text-primary)' }}>
            Weekly Revenue &amp; Cost (Last 12 Weeks)
          </h2>
          <p style={{ margin: '0 0 16px', fontSize: '12px', color: 'var(--text-tertiary)', lineHeight: 1.45 }}>
            Revenue is summed by <strong>service ticket date</strong> week. Cost is ticket expenses (same week) plus{' '}
            <strong>project labor</strong> from time-entry dates (may not match ticket weeks). Profit = revenue − cost.
            Grouped bars avoid hiding losses (previously stacked profit was capped at $0).
          </p>
          {revenueByWeek.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>No ticket or labor data in this window.</p>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={revenueByWeek} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                <XAxis dataKey="week" tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
                <YAxis tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0]?.payload;
                    const p = Number(d?.profit ?? 0);
                    return (
                      <div style={{
                        padding: '10px 14px',
                        backgroundColor: 'var(--bg-primary)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '8px',
                        fontSize: '13px',
                      }}>
                        <div style={{ fontWeight: '600', marginBottom: '6px' }}>{d?.week}</div>
                        <div style={{ color: '#10b981' }}>Revenue: {fmt(d?.revenue ?? 0)}</div>
                        <div style={{ color: '#ef4444' }}>Cost: {fmt(d?.totalCost ?? 0)}</div>
                        <div style={{ color: p >= 0 ? '#10b981' : '#ef4444' }}>
                          Profit: {fmt(p)}
                        </div>
                      </div>
                    );
                  }}
                />
                <Bar dataKey="revenue" fill="#10b981" name="Revenue" radius={[4, 4, 0, 0]} />
                <Bar dataKey="totalCost" fill="#ef4444" name="Cost" radius={[4, 4, 0, 0]} />
                <Legend formatter={(value) => <span style={{ color: 'var(--text-primary)', fontSize: '12px' }}>{value}</span>} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Insights of the week */}
        <div style={{
          backgroundColor: 'var(--bg-primary)',
          border: '1px solid var(--border-color)',
          borderRadius: '12px',
          padding: '24px',
        }}>
          <h2 style={{ margin: '0 0 8px', fontSize: '18px', fontWeight: '600', color: 'var(--text-primary)' }}>
            Insights of the week
          </h2>
          <p style={{ margin: '0 0 18px', fontSize: '12px', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
            Calendar week (Mon–Sun, same as payroll/calendar) for tickets and time; chart bars use ticket-week revenue vs costs. Red highlights need follow-up;
            green is momentum. Use the links to jump to the right screen.
          </p>
          <DashboardWeeklyInsights insights={weeklyInsights} />
        </div>
      </div>
    </div>
  );
}

function KpiCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      backgroundColor: 'var(--bg-primary)',
      border: '1px solid var(--border-color)',
      borderRadius: '12px',
      padding: '20px 24px',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, width: '4px', height: '100%',
        backgroundColor: color,
      }} />
      <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '8px' }}>
        {label}
      </div>
      <div style={{ fontSize: '26px', fontWeight: '700', color: 'var(--text-primary)', fontFamily: 'monospace' }}>
        {value}
      </div>
    </div>
  );
}
