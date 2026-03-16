import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { supabase } from '../lib/supabaseClient';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from 'recharts';

const fmt = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });

const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

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
        .eq('is_active', true);
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

  const { mtdRevenue, uninvoicedWip, revenueByWeek, unbilledByCustomer } = useMemo(() => {
    let mtd = 0;
    let wip = 0;
    const weekMap = new Map<string, number>();
    const custMap = new Map<string, number>();

    for (const t of ticketsRaw as any[]) {
      const amt = Number(t.total_amount) || 0;

      if (t.date >= monthStart) mtd += amt;

      const hasTicketNumber = !!t.ticket_number;
      if (!hasTicketNumber) {
        wip += amt;

        const custName = t.customers?.name || 'Unknown';
        custMap.set(custName, (custMap.get(custName) || 0) + amt);
      }

      const d = new Date(t.date);
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      const weekKey = weekStart.toISOString().slice(0, 10);
      weekMap.set(weekKey, (weekMap.get(weekKey) || 0) + amt);
    }

    const weeks = Array.from(weekMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12)
      .map(([week, total]) => {
        const d = new Date(week);
        const label = `${d.toLocaleString('en', { month: 'short' })} ${d.getDate()}`;
        return { week: label, revenue: Math.round(total) };
      });

    const customers = Array.from(custMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, value]) => ({ name: name.length > 20 ? name.slice(0, 18) + '...' : name, value: Math.round(value) }));

    return { mtdRevenue: mtd, uninvoicedWip: wip, revenueByWeek: weeks, unbilledByCustomer: customers };
  }, [ticketsRaw, monthStart]);

  // ─── Action items ───
  const actionItems = [
    { label: 'Tickets Awaiting Review', count: awaitingReviewCount, path: '/service-tickets', color: '#3b82f6' },
    { label: 'Resubmitted Tickets', count: resubmittedCount, path: '/service-tickets', color: '#eab308' },
    { label: 'Pending Expense Approvals', count: pendingExpenseCount, path: '/expenses', color: '#f59e0b' },
    { label: 'Projects Missing Numbers', count: missingNumberCount, path: '/projects', color: '#10b981' },
    { label: 'Open Bug Reports', count: openBugCount, path: '/service-tickets', color: '#ef4444' },
  ];

  const totalActionItems = actionItems.reduce((s, i) => s + i.count, 0);

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
          <h2 style={{ margin: '0 0 20px', fontSize: '18px', fontWeight: '600', color: 'var(--text-primary)' }}>
            Weekly Revenue (Last 12 Weeks)
          </h2>
          {revenueByWeek.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>No ticket data yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={revenueByWeek} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                <XAxis dataKey="week" tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
                <YAxis tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
                <Tooltip
                  formatter={(value: number) => [fmt(value), 'Revenue']}
                  contentStyle={{
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    fontSize: '13px',
                  }}
                />
                <Bar dataKey="revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Top Unbilled Customers (Donut) */}
        <div style={{
          backgroundColor: 'var(--bg-primary)',
          border: '1px solid var(--border-color)',
          borderRadius: '12px',
          padding: '24px',
        }}>
          <h2 style={{ margin: '0 0 20px', fontSize: '18px', fontWeight: '600', color: 'var(--text-primary)' }}>
            Top Unbilled Customers
          </h2>
          {unbilledByCustomer.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>No uninvoiced tickets.</p>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={unbilledByCustomer}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={2}
                >
                  {unbilledByCustomer.map((_, idx) => (
                    <Cell key={idx} fill={PIE_COLORS[idx % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: number) => fmt(value)}
                  contentStyle={{
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    fontSize: '13px',
                  }}
                />
                <Legend
                  formatter={(value: string) => <span style={{ color: 'var(--text-primary)', fontSize: '12px' }}>{value}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
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
