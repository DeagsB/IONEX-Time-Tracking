import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { projectsService, employeesService, timeEntriesService, payRateHistoryService } from '../services/supabaseServices';
import { supabase } from '../lib/supabaseClient';

interface ProjectFinancials {
  projectId: string;
  projectNumber: string;
  name: string;
  customerName: string;
  color: string;
  budget: number | null;
  revenue: number;
  laborCost: number;
  expenseCost: number;
  totalCost: number;
  profit: number;
  margin: number;
  totalHours: number;
  ticketCount: number;
}

export default function Profitability() {
  const { isAdmin } = useAuth();
  const { isDemoMode } = useDemoMode();
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'revenue' | 'profit' | 'margin' | 'budget_usage'>('revenue');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [showInactive, setShowInactive] = useState(false);

  const { data: projects = [] } = useQuery({
    queryKey: ['projects', showInactive],
    queryFn: () => projectsService.getAll(showInactive),
  });

  const { data: employees = [] } = useQuery({
    queryKey: ['employees'],
    queryFn: () => employeesService.getAll(),
    enabled: isAdmin,
  });

  const { data: allTimeEntries = [] } = useQuery({
    queryKey: ['allTimeEntries'],
    queryFn: () => timeEntriesService.getAll(isDemoMode),
    enabled: isAdmin,
  });

  const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';

  const { data: serviceTickets = [] } = useQuery({
    queryKey: ['profitability-tickets', isDemoMode],
    queryFn: async () => {
      const { data, error } = await supabase
        .from(tableName)
        .select('id, ticket_number, user_id, date, total_hours, total_amount, customer_id, project_id, is_edited, edited_hours, workflow_status')
        .or('is_discarded.is.null,is_discarded.eq.false');
      if (error) throw error;
      return data || [];
    },
    enabled: isAdmin,
  });

  const { data: ticketExpenses = [] } = useQuery({
    queryKey: ['profitability-ticket-expenses', isDemoMode],
    queryFn: async () => {
      const expTable = isDemoMode ? 'service_ticket_expenses' : 'service_ticket_expenses';
      const { data, error } = await supabase
        .from(expTable)
        .select(`
          id, service_ticket_id, expense_type, description, quantity, rate,
          service_tickets!inner(id, project_id, workflow_status, is_discarded)
        `)
        .not('service_tickets.workflow_status', 'in', '("draft","rejected")')
        .or('service_tickets.is_discarded.is.null,service_tickets.is_discarded.eq.false', { referencedTable: 'service_tickets' });
      if (error) throw error;
      return data || [];
    },
    enabled: isAdmin,
  });

  const { data: rateHistory = [] } = useQuery({
    queryKey: ['pay-rate-history'],
    queryFn: () => payRateHistoryService.getAll(),
    enabled: isAdmin,
  });

  const empByUserId = useMemo(() => {
    const map = new Map<string, any>();
    for (const emp of employees as any[]) {
      if (emp.user_id) map.set(emp.user_id, emp);
    }
    return map;
  }, [employees]);

  // Build lookup: employee_id → sorted rate snapshots (ascending by effective_date)
  const rateHistoryByEmpId = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const r of rateHistory) {
      const list = map.get(r.employee_id) || [];
      list.push(r);
      map.set(r.employee_id, list);
    }
    map.forEach((list) => list.sort((a: any, b: any) => a.effective_date.localeCompare(b.effective_date)));
    return map;
  }, [rateHistory]);

  // Return the rate snapshot effective on `date` for the given employee record.
  // Falls back to the employee's current rates if no history exists.
  const getRatesForDate = (emp: any, date: string) => {
    const history = rateHistoryByEmpId.get(emp.id);
    if (!history || history.length === 0) return emp;
    let match = history[0];
    for (const h of history) {
      if (h.effective_date <= date) match = h;
      else break;
    }
    return match;
  };

  const projectFinancials: ProjectFinancials[] = useMemo(() => {
    if (!projects.length) return [];

    const revenueByProject = new Map<string, number>();
    const ticketCountByProject = new Map<string, number>();
    const NON_REVENUE_STATUSES = new Set(['draft', 'submitted', 'rejected']);
    for (const t of serviceTickets as any[]) {
      if (!t.project_id) continue;
      ticketCountByProject.set(t.project_id, (ticketCountByProject.get(t.project_id) || 0) + 1);
      if (NON_REVENUE_STATUSES.has(t.workflow_status)) continue;
      const amt = Number(t.total_amount) || 0;
      revenueByProject.set(t.project_id, (revenueByProject.get(t.project_id) || 0) + amt);
    }

    const laborByProject = new Map<string, number>();
    const hoursByProject = new Map<string, number>();
    for (const entry of allTimeEntries as any[]) {
      if (!entry.project_id || !entry.hours) continue;
      const hours = Number(entry.hours) || 0;
      hoursByProject.set(entry.project_id, (hoursByProject.get(entry.project_id) || 0) + hours);

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

        const isContractor = (emp.employment_type || 'Employee') === 'Contractor';
        const burden = isContractor ? 0.05 : 0.30;
        payRate = payRate * (1 + burden);
      }
      laborByProject.set(entry.project_id, (laborByProject.get(entry.project_id) || 0) + hours * payRate);
    }

    const expenseByProject = new Map<string, number>();
    for (const exp of ticketExpenses as any[]) {
      const ticket = exp.service_tickets;
      if (!ticket?.project_id) continue;
      const amt = (Number(exp.quantity) || 0) * (Number(exp.rate) || 0);
      expenseByProject.set(ticket.project_id, (expenseByProject.get(ticket.project_id) || 0) + amt);
    }

    return (projects as any[]).map((p: any) => {
      const revenue = revenueByProject.get(p.id) || 0;
      const laborCost = laborByProject.get(p.id) || 0;
      const expenseCost = expenseByProject.get(p.id) || 0;
      const totalCost = laborCost + expenseCost;
      const profit = revenue - totalCost;
      const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

      return {
        projectId: p.id,
        projectNumber: p.project_number || '',
        name: p.name || '',
        customerName: p.customer?.name || 'No Customer',
        color: p.color || '#4ecdc4',
        budget: p.budget != null && Number(p.budget) > 0 ? Number(p.budget) : null,
        revenue,
        laborCost,
        expenseCost,
        totalCost,
        profit,
        margin,
        totalHours: hoursByProject.get(p.id) || 0,
        ticketCount: ticketCountByProject.get(p.id) || 0,
      };
    });
  }, [projects, serviceTickets, allTimeEntries, ticketExpenses, empByUserId, rateHistoryByEmpId]);

  const filtered = useMemo(() => {
    let list = projectFinancials;
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(term) ||
          p.projectNumber.toLowerCase().includes(term) ||
          p.customerName.toLowerCase().includes(term)
      );
    }
    list.sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortBy === 'revenue') cmp = a.revenue - b.revenue;
      else if (sortBy === 'profit') cmp = a.profit - b.profit;
      else if (sortBy === 'margin') cmp = a.margin - b.margin;
      else if (sortBy === 'budget_usage') {
        const aUsage = a.budget ? a.revenue / a.budget : -1;
        const bUsage = b.budget ? b.revenue / b.budget : -1;
        cmp = aUsage - bUsage;
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return list;
  }, [projectFinancials, searchTerm, sortBy, sortDir]);

  const totals = useMemo(() => {
    let revenue = 0, cost = 0, hours = 0, tickets = 0;
    for (const p of filtered) {
      revenue += p.revenue;
      cost += p.totalCost;
      hours += p.totalHours;
      tickets += p.ticketCount;
    }
    return { revenue, cost, profit: revenue - cost, hours, tickets };
  }, [filtered]);

  const expandedProject = useMemo(() => {
    if (!expandedProjectId) return null;
    return projectFinancials.find((p) => p.projectId === expandedProjectId) || null;
  }, [expandedProjectId, projectFinancials]);

  const expandedTickets = useMemo(() => {
    if (!expandedProjectId) return [];

    const projectTickets = (serviceTickets as any[]).filter((t: any) => t.project_id === expandedProjectId);

    const getLoadedRate = (emp: any, rates: any, rateType: string) => {
      let payRate = 0;
      if (rateType === 'Internal') payRate = Number(rates.internal_rate) || Number(rates.shop_pay_rate) || 0;
      else if (rateType === 'Shop Time') payRate = Number(rates.shop_pay_rate) || 0;
      else if (rateType === 'Field Time') payRate = Number(rates.field_pay_rate) || 0;
      else if (rateType === 'Travel Time') payRate = Number(rates.shop_pay_rate) || 0;
      else if (rateType === 'Shop Overtime') payRate = Number(rates.shop_ot_pay_rate) || 0;
      else if (rateType === 'Field Overtime') payRate = Number(rates.field_ot_pay_rate) || 0;
      const isContractor = (emp.employment_type || 'Employee') === 'Contractor';
      return payRate * (1 + (isContractor ? 0.05 : 0.30));
    };

    // Pre-compute blended loaded rate per user from their time entries on this project
    const blendedRateByUser = new Map<string, number>();
    const hoursByUser = new Map<string, number>();
    for (const e of allTimeEntries as any[]) {
      if (e.project_id !== expandedProjectId || !e.hours) continue;
      const h = Number(e.hours) || 0;
      const emp = empByUserId.get(e.user_id);
      if (!emp) continue;
      const rates = getRatesForDate(emp, e.date);
      const cost = h * getLoadedRate(emp, rates, e.rate_type || 'Shop Time');
      blendedRateByUser.set(e.user_id, (blendedRateByUser.get(e.user_id) || 0) + cost);
      hoursByUser.set(e.user_id, (hoursByUser.get(e.user_id) || 0) + h);
    }

    const getBillableRate = (emp: any, rateType: string) => {
      if (!emp) return 0;
      const rt = rateType.toLowerCase();
      if (rt.includes('shop') && rt.includes('overtime')) return Number(emp.shop_ot_rate) || 0;
      if (rt.includes('field') && rt.includes('overtime')) return Number(emp.field_ot_rate) || 0;
      if (rt.includes('field')) return Number(emp.ft_rate) || 0;
      if (rt.includes('travel')) return Number(emp.tt_rate) || 0;
      return Number(emp.rt_rate) || 0;
    };

    return projectTickets
      .map((t: any) => {
        let payrollCost = 0;
        const emp = empByUserId.get(t.user_id);
        const ticketHours = Number(t.total_hours) || 0;
        const savedAmount = Number(t.total_amount) || 0;
        const isDraftOrSubmitted = t.workflow_status === 'draft' || t.workflow_status === 'submitted' || t.workflow_status === 'rejected';

        let estimatedRevenue = savedAmount;

        // Find matching time entries for this ticket (needed for drafts with 0 saved hours)
        const matchingEntries = (allTimeEntries as any[]).filter((e: any) =>
          e.user_id === t.user_id && e.project_id === t.project_id && e.date === t.date
        );
        const entryHours = matchingEntries.reduce((sum: number, e: any) => sum + (Number(e.hours) || 0), 0);
        const effectiveHours = ticketHours > 0 ? ticketHours : entryHours;

        if (emp && effectiveHours > 0) {
          if (t.is_edited && t.edited_hours) {
            const rates = getRatesForDate(emp, t.date);
            const editedHours = typeof t.edited_hours === 'string' ? JSON.parse(t.edited_hours) : t.edited_hours;
            Object.entries(editedHours).forEach(([rateType, hours]) => {
              const h = Array.isArray(hours) ? (hours as number[]).reduce((a: number, b: number) => a + b, 0) : Number(hours) || 0;
              payrollCost += h * getLoadedRate(emp, rates, rateType);
              if (isDraftOrSubmitted && savedAmount === 0) {
                estimatedRevenue += h * getBillableRate(emp, rateType);
              }
            });
          } else if (ticketHours > 0) {
            const totalCostForUser = blendedRateByUser.get(t.user_id) || 0;
            const totalHoursForUser = hoursByUser.get(t.user_id) || 0;
            const avgRate = totalHoursForUser > 0 ? totalCostForUser / totalHoursForUser : 0;
            payrollCost = ticketHours * avgRate;
            if (isDraftOrSubmitted && savedAmount === 0) {
              for (const e of matchingEntries) {
                const h = Number(e.hours) || 0;
                estimatedRevenue += h * getBillableRate(emp, e.rate_type || 'Shop Time');
              }
            }
          } else {
            // Draft/submitted/rejected with 0 saved hours — use time entries
            const rates = getRatesForDate(emp, t.date);
            for (const e of matchingEntries) {
              const h = Number(e.hours) || 0;
              const rt = e.rate_type || 'Shop Time';
              payrollCost += h * getLoadedRate(emp, rates, rt);
              if (isDraftOrSubmitted && savedAmount === 0) {
                estimatedRevenue += h * getBillableRate(emp, rt);
              }
            }
          }
        }

        return {
          ...t,
          payrollCost,
          total_hours: effectiveHours > 0 && ticketHours === 0 ? effectiveHours : ticketHours,
          total_amount: isDraftOrSubmitted && savedAmount === 0 ? estimatedRevenue : savedAmount,
          profit: estimatedRevenue - payrollCost,
        };
      })
      .sort((a: any, b: any) => b.date.localeCompare(a.date));
  }, [expandedProjectId, serviceTickets, allTimeEntries, empByUserId, rateHistoryByEmpId]);

  const expandedLaborByEmployee = useMemo(() => {
    if (!expandedProjectId) return [];
    const map = new Map<string, { name: string; hours: number; cost: number }>();
    for (const entry of allTimeEntries as any[]) {
      if (entry.project_id !== expandedProjectId || !entry.hours) continue;
      const hours = Number(entry.hours) || 0;
      const emp = empByUserId.get(entry.user_id);
      const empName = emp?.user
        ? `${emp.user.first_name || ''} ${emp.user.last_name || ''}`.trim()
        : 'Unknown';

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

        const isContractor = (emp.employment_type || 'Employee') === 'Contractor';
        const burden = isContractor ? 0.05 : 0.30;
        payRate = payRate * (1 + burden);
      }

      const existing = map.get(entry.user_id) || { name: empName, hours: 0, cost: 0 };
      existing.hours += hours;
      existing.cost += hours * payRate;
      map.set(entry.user_id, existing);
    }
    return Array.from(map.values()).sort((a, b) => b.cost - a.cost);
  }, [expandedProjectId, allTimeEntries, empByUserId, rateHistoryByEmpId]);

  const expandedExpenses = useMemo(() => {
    if (!expandedProjectId) return [];
    return (ticketExpenses as any[])
      .filter((exp: any) => exp.service_tickets?.project_id === expandedProjectId)
      .map((exp: any) => ({
        description: exp.description || exp.expense_type || 'Expense',
        type: exp.expense_type || '',
        quantity: Number(exp.quantity) || 0,
        rate: Number(exp.rate) || 0,
        total: (Number(exp.quantity) || 0) * (Number(exp.rate) || 0),
      }))
      .sort((a: any, b: any) => b.total - a.total);
  }, [expandedProjectId, ticketExpenses]);

  const fmt = (n: number) => n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const handleSort = (field: typeof sortBy) => {
    if (sortBy === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(field); setSortDir('desc'); }
  };

  const sortArrow = (field: typeof sortBy) =>
    sortBy === field ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  if (!isAdmin) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>
        <h2>Access Denied</h2>
        <p>This page is only available to administrators.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: '30px', maxWidth: '1400px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <h1 style={{ fontSize: '28px', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>
            Project Profitability
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginTop: '4px' }}>
            Financial overview across all projects
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Show inactive
          </label>
          <input
            type="text"
            placeholder="Search projects..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              padding: '8px 14px',
              borderRadius: '8px',
              border: '1px solid var(--border-color)',
              backgroundColor: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              fontSize: '13px',
              width: '220px',
            }}
          />
        </div>
      </div>

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '28px' }}>
        {[
          { label: 'Total Revenue', value: `$${fmt(totals.revenue)}`, color: '#2196F3' },
          { label: 'Total Cost', value: `$${fmt(totals.cost)}`, color: '#ff9800' },
          { label: 'Total Profit', value: `$${fmt(totals.profit)}`, color: totals.profit >= 0 ? '#4caf50' : '#e53935' },
          { label: 'Total Hours', value: totals.hours.toFixed(1), color: '#9c27b0' },
          { label: 'Service Tickets', value: String(totals.tickets), color: '#607d8b' },
        ].map((card) => (
          <div
            key={card.label}
            style={{
              backgroundColor: 'var(--bg-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: '12px',
              padding: '18px 20px',
              borderLeft: `4px solid ${card.color}`,
            }}
          >
            <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-tertiary)', marginBottom: '6px' }}>
              {card.label}
            </div>
            <div style={{ fontSize: '22px', fontWeight: '700', color: 'var(--text-primary)', fontFamily: 'monospace' }}>
              {card.value}
            </div>
          </div>
        ))}
      </div>

      {/* Project List */}
      <div style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '12px', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
              <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => handleSort('name')}>Project{sortArrow('name')}</th>
              <th style={{ ...thStyle, textAlign: 'center' }}>Budget Usage</th>
              <th style={{ ...thStyle, textAlign: 'right', cursor: 'pointer' }} onClick={() => handleSort('revenue')}>Revenue{sortArrow('revenue')}</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Cost</th>
              <th style={{ ...thStyle, textAlign: 'right', cursor: 'pointer' }} onClick={() => handleSort('profit')}>Profit{sortArrow('profit')}</th>
              <th style={{ ...thStyle, textAlign: 'right', cursor: 'pointer' }} onClick={() => handleSort('margin')}>Margin{sortArrow('margin')}</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Hours</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: '40px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
                  No projects found
                </td>
              </tr>
            )}
            {filtered.map((p) => {
              const isExpanded = expandedProjectId === p.projectId;
              const budgetPct = p.budget ? Math.min((p.revenue / p.budget) * 100, 100) : null;
              const overBudget = p.budget ? p.revenue > p.budget : false;

              return (
                <tr
                  key={p.projectId}
                  onClick={() => setExpandedProjectId(isExpanded ? null : p.projectId)}
                  style={{
                    borderBottom: '1px solid var(--border-color)',
                    cursor: 'pointer',
                    backgroundColor: isExpanded ? 'var(--bg-secondary)' : 'transparent',
                    transition: 'background-color 0.15s',
                  }}
                  onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.backgroundColor = 'var(--bg-secondary)'; }}
                  onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.backgroundColor = 'transparent'; }}
                >
                  <td style={{ ...tdStyle, display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div
                      style={{
                        width: '10px',
                        height: '10px',
                        borderRadius: '50%',
                        backgroundColor: p.color,
                        flexShrink: 0,
                      }}
                    />
                    <div>
                      <div style={{ fontWeight: '600', fontSize: '13px', color: 'var(--text-primary)' }}>
                        {p.projectNumber ? `${p.projectNumber} - ` : ''}{p.name}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{p.customerName}</div>
                    </div>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'center', minWidth: '180px' }}>
                    {p.budget ? (
                      <BudgetBar pct={budgetPct!} overBudget={overBudget} budget={p.budget} revenue={p.revenue} />
                    ) : (
                      <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontStyle: 'italic' }}>No budget</span>
                    )}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: '600' }}>
                    ${fmt(p.revenue)}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                    ${fmt(p.totalCost)}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: '600', color: p.profit >= 0 ? '#4caf50' : '#e53935' }}>
                    ${fmt(p.profit)}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    <span
                      style={{
                        padding: '3px 8px',
                        borderRadius: '12px',
                        fontSize: '12px',
                        fontWeight: '600',
                        backgroundColor: p.margin >= 20 ? 'rgba(76,175,80,0.12)' : p.margin >= 0 ? 'rgba(255,152,0,0.12)' : 'rgba(229,57,53,0.12)',
                        color: p.margin >= 20 ? '#4caf50' : p.margin >= 0 ? '#ff9800' : '#e53935',
                      }}
                    >
                      {p.margin.toFixed(1)}%
                    </span>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                    {p.totalHours.toFixed(1)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Expanded Detail Panel */}
      {expandedProject && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.5)',
            zIndex: 1000,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '20px',
          }}
          onClick={() => setExpandedProjectId(null)}
        >
          <div
            style={{
              backgroundColor: 'var(--bg-primary)',
              borderRadius: '16px',
              maxWidth: '1000px',
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
              padding: '32px',
              boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '28px' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '22px', color: 'var(--text-primary)' }}>
                  <span style={{ display: 'inline-block', width: '12px', height: '12px', borderRadius: '50%', backgroundColor: expandedProject.color, marginRight: '10px', verticalAlign: 'middle' }} />
                  {expandedProject.projectNumber ? `${expandedProject.projectNumber} - ` : ''}{expandedProject.name}
                </h2>
                <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--text-tertiary)' }}>{expandedProject.customerName}</p>
              </div>
              <button
                onClick={() => setExpandedProjectId(null)}
                style={{
                  background: 'none',
                  border: '1px solid var(--border-color)',
                  borderRadius: '8px',
                  padding: '6px 12px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  color: 'var(--text-secondary)',
                }}
              >
                {'\u2715'}
              </button>
            </div>

            {/* KPI Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginBottom: '28px' }}>
              {expandedProject.budget && (
                <KpiCard label="Budget" value={`$${fmt(expandedProject.budget)}`} />
              )}
              <KpiCard label="Revenue" value={`$${fmt(expandedProject.revenue)}`} color="#2196F3" />
              <KpiCard label="Total Cost" value={`$${fmt(expandedProject.totalCost)}`} color="#ff9800" />
              <KpiCard label="Profit" value={`$${fmt(expandedProject.profit)}`} color={expandedProject.profit >= 0 ? '#4caf50' : '#e53935'} />
              <KpiCard label="Margin" value={`${expandedProject.margin.toFixed(1)}%`} color={expandedProject.margin >= 20 ? '#4caf50' : expandedProject.margin >= 0 ? '#ff9800' : '#e53935'} />
              <KpiCard label="Hours" value={expandedProject.totalHours.toFixed(1)} color="#9c27b0" />
            </div>

            {/* Budget Bar (detail) */}
            {expandedProject.budget && (
              <div style={{ marginBottom: '28px' }}>
                <div style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Budget Usage
                </div>
                <BudgetBar
                  pct={Math.min((expandedProject.revenue / expandedProject.budget) * 100, 100)}
                  overBudget={expandedProject.revenue > expandedProject.budget}
                  budget={expandedProject.budget}
                  revenue={expandedProject.revenue}
                  large
                />
              </div>
            )}

            {/* Labor Breakdown */}
            <DetailSection title={`Labor Costs \u2014 $${fmt(expandedProject.laborCost)}`}>
              {expandedLaborByEmployee.length === 0 ? (
                <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>No labor recorded</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <th style={detailThStyle}>Employee</th>
                      <th style={{ ...detailThStyle, textAlign: 'right' }}>Hours</th>
                      <th style={{ ...detailThStyle, textAlign: 'right' }}>Loaded Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expandedLaborByEmployee.map((emp, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border-color)' }}>
                        <td style={detailTdStyle}>{emp.name}</td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace' }}>{emp.hours.toFixed(1)}</td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace' }}>${fmt(emp.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p style={{ fontSize: '10px', color: 'var(--text-tertiary)', fontStyle: 'italic', marginTop: '8px', marginBottom: 0 }}>
                * Labor costs include estimated burden (30% for employees, 5% GST for contractors)
              </p>
            </DetailSection>

            {/* Expenses Breakdown */}
            <DetailSection title={`Expenses \u2014 $${fmt(expandedProject.expenseCost)}`}>
              {expandedExpenses.length === 0 ? (
                <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>No expenses recorded</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <th style={detailThStyle}>Description</th>
                      <th style={{ ...detailThStyle, textAlign: 'right' }}>Qty</th>
                      <th style={{ ...detailThStyle, textAlign: 'right' }}>Rate</th>
                      <th style={{ ...detailThStyle, textAlign: 'right' }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expandedExpenses.map((exp: any, i: number) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border-color)' }}>
                        <td style={detailTdStyle}>
                          <span style={{ fontWeight: '500' }}>{exp.description}</span>
                          {exp.type && <span style={{ marginLeft: '8px', fontSize: '11px', color: 'var(--text-tertiary)' }}>({exp.type})</span>}
                        </td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace' }}>{exp.quantity}</td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace' }}>${fmt(exp.rate)}</td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace' }}>${fmt(exp.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </DetailSection>

            {/* Revenue (Tickets) Breakdown */}
            <DetailSection title={`Revenue \u2014 ${expandedTickets.length} ticket${expandedTickets.length !== 1 ? 's' : ''}`}>
              {expandedTickets.length === 0 ? (
                <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>No tickets recorded</p>
              ) : (
                <>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <th style={detailThStyle}>Date</th>
                      <th style={detailThStyle}>Ticket</th>
                      <th style={{ ...detailThStyle, textAlign: 'right' }}>Hours</th>
                      <th style={{ ...detailThStyle, textAlign: 'right' }}>Revenue</th>
                      <th style={{ ...detailThStyle, textAlign: 'right' }}>Payroll Cost</th>
                      <th style={{ ...detailThStyle, textAlign: 'right' }}>Net Profit</th>
                      <th style={{ ...detailThStyle, textAlign: 'center' }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expandedTickets.map((t: any) => {
                      const rev = Number(t.total_amount) || 0;
                      const emp = empByUserId.get(t.user_id);
                      const empName = emp?.user ? [emp.user.first_name, emp.user.last_name].filter(Boolean).join(' ') : null;
                      const isDraft = t.workflow_status === 'draft' || t.workflow_status === 'submitted' || t.workflow_status === 'rejected';
                      const isInternal = rev === 0 && (t.payrollCost || 0) > 0 && !isDraft;
                      const ticketId = t.ticket_number || t.id.substring(0, 8);
                      return (
                      <tr key={t.id} style={{ borderBottom: '1px solid var(--border-color)', opacity: isDraft ? 0.7 : 1 }}>
                        <td style={detailTdStyle}>{t.date}</td>
                        <td style={detailTdStyle}>
                          <div>
                            <span style={{ fontFamily: isInternal ? 'inherit' : 'monospace', color: 'var(--text-secondary)' }}>
                              {isInternal && empName ? `${empName} - internal` : ticketId}
                            </span>
                            {empName && !isInternal && (
                              <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '1px' }}>{empName}</div>
                            )}
                          </div>
                        </td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace' }}>{Number(t.total_hours || 0).toFixed(1)}</td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace' }}>
                          {isDraft ? (
                            <span style={{ color: '#ff9800', fontStyle: 'italic' }} title="Draft — not included in totals">
                              ${fmt(rev)} *
                            </span>
                          ) : (
                            `$${fmt(rev)}`
                          )}
                        </td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', color: isDraft ? '#ff9800' : 'var(--text-secondary)' }}>
                          {isDraft ? (
                            <span style={{ fontStyle: 'italic' }} title="Draft — not included in totals">${fmt(t.payrollCost || 0)} *</span>
                          ) : (
                            `$${fmt(t.payrollCost || 0)}`
                          )}
                        </td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', color: isDraft ? '#ff9800' : ((t.profit || 0) >= 0 ? '#4caf50' : '#e53935') }}>
                          {isDraft ? (
                            <span style={{ fontStyle: 'italic' }} title="Draft — not included in totals">${fmt(t.profit || 0)} *</span>
                          ) : (
                            `$${fmt(t.profit || 0)}`
                          )}
                        </td>
                        <td style={{ ...detailTdStyle, textAlign: 'center' }}>
                          <StatusBadge status={t.workflow_status} />
                        </td>
                      </tr>
                    ); })}
                    {(() => {
                      const ticketHours = expandedTickets.reduce((sum: number, t: any) => sum + (Number(t.total_hours) || 0), 0);
                      const ticketCost = expandedTickets.reduce((sum: number, t: any) => sum + (t.payrollCost || 0), 0);
                      const totalProjectHours = expandedProject?.totalHours || 0;
                      const totalProjectCost = expandedProject?.laborCost || 0;
                      const unbilledHours = totalProjectHours - ticketHours;
                      const unbilledCost = totalProjectCost - ticketCost;
                      if (unbilledHours <= 0.05) return null;
                      return (
                        <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'rgba(229, 57, 53, 0.05)' }}>
                          <td style={detailTdStyle}></td>
                          <td style={detailTdStyle}>
                            <span style={{ color: '#e53935', fontStyle: 'italic', fontSize: '12px' }}>Unbilled labor</span>
                          </td>
                          <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', color: '#e53935' }}>{unbilledHours.toFixed(1)}</td>
                          <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', color: 'var(--text-tertiary)' }}>—</td>
                          <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', color: '#e53935' }}>${fmt(unbilledCost)}</td>
                          <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', color: '#e53935' }}>
                            -${fmt(unbilledCost)}
                          </td>
                          <td style={{ ...detailTdStyle, textAlign: 'center' }}>
                            <span style={{ fontSize: '11px', color: '#e53935', fontStyle: 'italic' }}>No ticket</span>
                          </td>
                        </tr>
                      );
                    })()}
                  </tbody>
                </table>
                {expandedTickets.some((t: any) => t.workflow_status === 'draft' || t.workflow_status === 'submitted' || t.workflow_status === 'rejected') && (
                  <p style={{ margin: '6px 0 0', fontSize: '11px', color: '#ff9800', fontStyle: 'italic' }}>
                    * Draft/submitted/rejected amounts are shown for reference but not included in revenue or profit totals
                  </p>
                )}
                </>
              )}
            </DetailSection>
          </div>
        </div>
      )}
    </div>
  );
}

function BudgetBar({ pct, overBudget, budget, revenue, large }: { pct: number; overBudget: boolean; budget: number; revenue: number; large?: boolean }) {
  const height = large ? 24 : 16;
  const barColor = overBudget ? '#e53935' : pct > 80 ? '#ff9800' : '#2196F3';

  return (
    <div>
      <div
        style={{
          position: 'relative',
          height,
          borderRadius: height / 2,
          backgroundColor: overBudget ? 'rgba(229,57,53,0.1)' : 'rgba(33,150,243,0.1)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            height: '100%',
            width: `${pct}%`,
            borderRadius: height / 2,
            background: `repeating-linear-gradient(
              -45deg,
              ${barColor},
              ${barColor} 6px,
              ${adjustAlpha(barColor, 0.6)} 6px,
              ${adjustAlpha(barColor, 0.6)} 12px
            )`,
            transition: 'width 0.4s ease',
          }}
        />
        {large && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '11px',
              fontWeight: '700',
              color: pct > 50 ? '#fff' : 'var(--text-primary)',
              textShadow: pct > 50 ? '0 1px 2px rgba(0,0,0,0.3)' : 'none',
            }}
          >
            {pct.toFixed(0)}%
          </div>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '3px' }}>
        <span style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>
          ${(revenue / 1000).toFixed(1)}k
        </span>
        <span style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>
          ${(budget / 1000).toFixed(1)}k
        </span>
      </div>
    </div>
  );
}

function adjustAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function KpiCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div
      style={{
        padding: '14px 16px',
        borderRadius: '10px',
        border: '1px solid var(--border-color)',
        backgroundColor: 'var(--bg-secondary)',
        borderLeft: color ? `3px solid ${color}` : undefined,
      }}
    >
      <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-tertiary)', marginBottom: '4px' }}>
        {label}
      </div>
      <div style={{ fontSize: '18px', fontWeight: '700', color: color || 'var(--text-primary)', fontFamily: 'monospace' }}>
        {value}
      </div>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '24px' }}>
      <h3 style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '12px', paddingBottom: '8px', borderBottom: '1px solid var(--border-color)' }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, { bg: string; fg: string }> = {
    approved: { bg: 'rgba(76,175,80,0.12)', fg: '#4caf50' },
    pdf_exported: { bg: 'rgba(33,150,243,0.12)', fg: '#2196F3' },
    qbo_created: { bg: 'rgba(156,39,176,0.12)', fg: '#9c27b0' },
    sent_to_cnrl: { bg: 'rgba(255,152,0,0.12)', fg: '#ff9800' },
    cnrl_approved: { bg: 'rgba(0,150,136,0.12)', fg: '#009688' },
    submitted_to_cnrl: { bg: 'rgba(63,81,181,0.12)', fg: '#3f51b5' },
  };
  const c = colorMap[status] || { bg: 'rgba(158,158,158,0.12)', fg: '#9e9e9e' };
  const label = (status || 'unknown').replace(/_/g, ' ');
  return (
    <span style={{ padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: '600', backgroundColor: c.bg, color: c.fg, textTransform: 'capitalize' }}>
      {label}
    </span>
  );
}

const thStyle: React.CSSProperties = {
  padding: '12px 16px',
  fontSize: '11px',
  fontWeight: '600',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  color: 'var(--text-tertiary)',
  textAlign: 'left',
  userSelect: 'none',
};

const tdStyle: React.CSSProperties = {
  padding: '14px 16px',
  fontSize: '13px',
  color: 'var(--text-primary)',
};

const detailThStyle: React.CSSProperties = {
  padding: '8px 12px',
  fontSize: '11px',
  fontWeight: '600',
  textTransform: 'uppercase',
  letterSpacing: '0.3px',
  color: 'var(--text-tertiary)',
  textAlign: 'left',
};

const detailTdStyle: React.CSSProperties = {
  padding: '8px 12px',
  fontSize: '13px',
  color: 'var(--text-primary)',
};
