import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { projectsService, employeesService, timeEntriesService, payRateHistoryService } from '../services/supabaseServices';
import { supabase } from '../lib/supabaseClient';
import { calculateBurden, applyGst } from '../utils/employeeReports';
import { ticketExpenseCostForMargin } from '../utils/ticketExpenseReimbursement';
import {
  buildSharedFieldsMapForProject,
  entryServiceTicketMatchKeys,
  dbServiceTicketMatchKeys,
} from '../utils/serviceTickets';
import { ReportMethodologyCollapsible } from '../components/ReportMethodologyCollapsible';

interface ProjectFinancials {
  projectId: string;
  projectNumber: string;
  name: string;
  customerName: string;
  color: string;
  /** Closed on Projects page; row is muted on this screen */
  isCompleted: boolean;
  budget: number | null;
  revenue: number;
  /** Labor-only revenue (service ticket total_amount), before expense billouts */
  laborRevenuePreGst: number;
  /** Customer-billed expense lines (qty × rate) on included tickets, pre-GST */
  expenseBilledPreGst: number;
  /** Revenue from approved/exported tickets only */
  revenueApproved: number;
  /** Revenue from all tickets including draft/submitted/rejected */
  revenueAllTickets: number;
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
  const [sortBy, setSortBy] = useState<'project_number' | 'name' | 'revenue' | 'profit' | 'margin' | 'budget_usage'>('project_number');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [showInactive, setShowInactive] = useState(false);
  const [editingBudgetProjectId, setEditingBudgetProjectId] = useState<string | null>(null);
  const [budgetInputValue, setBudgetInputValue] = useState('');
  const budgetInputRef = useRef<HTMLInputElement>(null);
  const [expenseMarkupExpanded, setExpenseMarkupExpanded] = useState(true);
  const [includeGst, setIncludeGst] = useState(true);

  const queryClient = useQueryClient();
  const budgetMutation = useMutation({
    mutationFn: async ({ projectId, budget }: { projectId: string; budget: number }) => {
      return projectsService.update(projectId, { budget });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setEditingBudgetProjectId(null);
      setBudgetInputValue('');
    },
    onError: (err) => {
      alert(`Failed to save budget: ${err instanceof Error ? err.message : 'Unknown error'}`);
    },
  });

  useEffect(() => {
    if (editingBudgetProjectId && budgetInputRef.current) {
      budgetInputRef.current.focus();
    }
  }, [editingBudgetProjectId]);

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
        .select('id, ticket_number, user_id, date, total_hours, total_amount, customer_id, project_id, location, header_overrides, is_edited, edited_hours, workflow_status')
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
          id, service_ticket_id, expense_type, description, quantity, rate, actual_cost, needs_reimbursement,
          service_tickets!inner(id, project_id, user_id, workflow_status, is_discarded)
        `);
      if (error) throw error;
      return (data || []).filter((r: any) => {
        const st = r.service_tickets;
        if (!st) return false;
        if (st.is_discarded === true) return false;
        if (st.workflow_status === 'draft' || st.workflow_status === 'rejected') return false;
        return true;
      });
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

  /** Aligns with Employee Reports: reimbursable lines use base × rate; billed-only equipment/hotel uses actual_cost or billed as COGS proxy. */
  const ticketExpenseLineCost = useCallback(
    (exp: any) => {
      const emp = empByUserId.get(exp.service_tickets?.user_id);
      const desc = (exp.description || '').toLowerCase();
      const expType = (exp.expense_type || '').toLowerCase();
      let reimbRate = 1;
      if (desc.includes('per diem')) reimbRate = Number(emp?.per_diem_reimb_rate) || 1;
      else if (expType === 'travel') reimbRate = exp.needs_reimbursement === false ? 0 : Number(emp?.mileage_reimb_rate) || 0.9;
      else if (expType === 'hotel' || desc.includes('hotel')) reimbRate = exp.needs_reimbursement === false ? 0 : Number(emp?.hotel_reimb_rate) || 1;
      return ticketExpenseCostForMargin(exp, reimbRate);
    },
    [empByUserId]
  );

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
    const revenueAllTicketsByProject = new Map<string, number>();
    const ticketCountByProject = new Map<string, number>();
    const NON_REVENUE_STATUSES = new Set(['draft', 'submitted', 'rejected']);
    for (const t of serviceTickets as any[]) {
      if (!t.project_id) continue;
      // Skip empty placeholder records (auto-created drafts with no data)
      const tHrs = Number(t.total_hours) || 0;
      const tAmt = Number(t.total_amount) || 0;
      if (tHrs === 0 && tAmt === 0 && !t.is_edited && t.workflow_status === 'draft') continue;
      ticketCountByProject.set(t.project_id, (ticketCountByProject.get(t.project_id) || 0) + 1);
      const amt = Number(t.total_amount) || 0;
      revenueAllTicketsByProject.set(t.project_id, (revenueAllTicketsByProject.get(t.project_id) || 0) + amt);
      if (NON_REVENUE_STATUSES.has(t.workflow_status)) continue;
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

        payRate = payRate * (1 + calculateBurden(emp));
      }
      laborByProject.set(entry.project_id, (laborByProject.get(entry.project_id) || 0) + hours * payRate);
    }

    const expenseByProject = new Map<string, number>();
    /** Customer-billed totals from ticket expense lines (same tickets as ticketExpenses query). */
    const expenseBilledByProject = new Map<string, number>();
    for (const exp of ticketExpenses as any[]) {
      const ticket = exp.service_tickets;
      if (!ticket?.project_id) continue;
      const billed = (Number(exp.quantity) || 0) * (Number(exp.rate) || 0);
      expenseByProject.set(ticket.project_id, (expenseByProject.get(ticket.project_id) || 0) + ticketExpenseLineCost(exp));
      expenseBilledByProject.set(ticket.project_id, (expenseBilledByProject.get(ticket.project_id) || 0) + billed);
    }

    return (projects as any[]).map((p: any) => {
      const laborRevenuePreGst = revenueByProject.get(p.id) || 0;
      const expenseBilledPreGst = expenseBilledByProject.get(p.id) || 0;
      const revenuePreGst = laborRevenuePreGst + expenseBilledPreGst;
      const revenueAllTicketsPreGst = revenueAllTicketsByProject.get(p.id) || 0;
      const revenue = includeGst ? applyGst(revenuePreGst) : revenuePreGst;
      const revenueAllTickets = includeGst ? applyGst(revenueAllTicketsPreGst) : revenueAllTicketsPreGst;
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
        isCompleted: p.is_completed === true,
        budget: p.budget != null && Number(p.budget) > 0 ? Number(p.budget) : null,
        revenue,
        laborRevenuePreGst,
        expenseBilledPreGst,
        revenueApproved: revenue,
        revenueAllTickets,
        laborCost,
        expenseCost,
        totalCost,
        profit,
        margin,
        totalHours: hoursByProject.get(p.id) || 0,
        ticketCount: ticketCountByProject.get(p.id) || 0,
      };
    });
  }, [projects, serviceTickets, allTimeEntries, ticketExpenses, empByUserId, rateHistoryByEmpId, includeGst, ticketExpenseLineCost]);

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
      if (a.isCompleted !== b.isCompleted) return (a.isCompleted ? 1 : 0) - (b.isCompleted ? 1 : 0);
      let cmp = 0;
      if (sortBy === 'project_number') {
        const numA = parseInt(a.projectNumber, 10);
        const numB = parseInt(b.projectNumber, 10);
        const hasNumA = !isNaN(numA);
        const hasNumB = !isNaN(numB);
        // Default (desc): named projects first A–Z, then numeric by project number descending
        if (!hasNumA && hasNumB) cmp = -1;   // name before numeric
        else if (hasNumA && !hasNumB) cmp = 1;
        else if (!hasNumA && !hasNumB) cmp = a.name.localeCompare(b.name);
        else cmp = numB - numA;   // both numeric: higher number first
      } else if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
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
    const profit = Math.round((revenue - cost) * 100) / 100;
    return { revenue, cost, profit, hours, tickets };
  }, [filtered]);

  const expandedProject = useMemo(() => {
    if (!expandedProjectId) return null;
    return projectFinancials.find((p) => p.projectId === expandedProjectId) || null;
  }, [expandedProjectId, projectFinancials]);

  const expandedTickets = useMemo(() => {
    if (!expandedProjectId) return [];

    const projectTickets = (serviceTickets as any[]).filter((t: any) => t.project_id === expandedProjectId);
    const projectEntriesForShare = (allTimeEntries as any[]).filter((e: any) => e.project_id === expandedProjectId);
    const sharedByDayUserProject = buildSharedFieldsMapForProject(projectEntriesForShare, expandedProjectId);
    const projectById = new Map((projects as any[]).map((p: any) => [p.id, p]));

    const getLoadedRate = (emp: any, rates: any, rateType: string) => {
      let payRate = 0;
      if (rateType === 'Internal') payRate = Number(rates.internal_rate) || Number(rates.shop_pay_rate) || 0;
      else if (rateType === 'Shop Time') payRate = Number(rates.shop_pay_rate) || 0;
      else if (rateType === 'Field Time') payRate = Number(rates.field_pay_rate) || 0;
      else if (rateType === 'Travel Time') payRate = Number(rates.shop_pay_rate) || 0;
      else if (rateType === 'Shop Overtime') payRate = Number(rates.shop_ot_pay_rate) || 0;
      else if (rateType === 'Field Overtime') payRate = Number(rates.field_ot_pay_rate) || 0;
      return payRate * (1 + calculateBurden(emp));
    };

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

        const proj = projectById.get(t.project_id);
        const shareKey = `${t.date}-${t.user_id}-${t.project_id}`;
        const shared = sharedByDayUserProject.get(shareKey) || {};
        const ticketKeys = dbServiceTicketMatchKeys(t, proj);

        // Match time entries the same way service tickets are grouped: date + user + project + location + PO/AFE.
        // Otherwise every ticket on the same day gets the full day's payroll (duplicate cost bug).
        const matchingEntries = (allTimeEntries as any[]).filter((e: any) => {
          if (e.user_id !== t.user_id || e.project_id !== t.project_id || e.date !== t.date) return false;
          if (t.customer_id && e.project?.customer?.id && e.project.customer.id !== t.customer_id) return false;
          const ek = entryServiceTicketMatchKeys(e, shared, e.project ?? proj);
          return ek.locationKey === ticketKeys.locationKey && ek.groupingKey === ticketKeys.groupingKey;
        });
        const entryHours = matchingEntries.reduce((sum: number, e: any) => sum + (Number(e.hours) || 0), 0);
        const effectiveHours = ticketHours > 0 ? ticketHours : entryHours;

        // Payroll cost is ALWAYS based on actual time entries (hours worked), not billed hours.
        // This correctly handles cases like OPI where 4 hours billed but only 3 hours payroll cost.
        if (emp && matchingEntries.length > 0) {
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

        const ticketRevenue = isDraftOrSubmitted && savedAmount === 0 ? estimatedRevenue : savedAmount;
        const revenueWithGst = includeGst ? applyGst(ticketRevenue) : ticketRevenue;
        return {
          ...t,
          payrollCost,
          total_hours: effectiveHours > 0 && ticketHours === 0 ? effectiveHours : ticketHours,
          total_amount: revenueWithGst,
          profit: revenueWithGst - payrollCost,
        };
      })
      .filter((t: any) => {
        const hrs = Number(t.total_hours) || 0;
        const amt = Number(t.total_amount) || 0;
        const cost = t.payrollCost || 0;
        if (hrs === 0 && amt === 0 && cost === 0) return false;
        return true;
      })
      .sort((a: any, b: any) => b.date.localeCompare(a.date));
  }, [expandedProjectId, serviceTickets, allTimeEntries, empByUserId, rateHistoryByEmpId, includeGst, projects]);

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

        payRate = payRate * (1 + calculateBurden(emp));
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
      .map((exp: any) => {
        const billedTotal = (Number(exp.quantity) || 0) * (Number(exp.rate) || 0);
        const cost = ticketExpenseLineCost(exp);
        return {
          description: exp.description || exp.expense_type || 'Expense',
          type: exp.expense_type || '',
          quantity: Number(exp.quantity) || 0,
          rate: Number(exp.rate) || 0,
          total: billedTotal,
          cost,
          profit: billedTotal - cost,
        };
      })
      .filter((exp: any) => exp.total > 0)
      .sort((a: any, b: any) => b.profit - a.profit);
  }, [expandedProjectId, ticketExpenses, ticketExpenseLineCost]);

  const expandedExpenseMarkupKnownTotal = useMemo(
    () => expandedExpenses.reduce((s, e: any) => s + e.profit, 0),
    [expandedExpenses]
  );

  const fmt = (n: number) => n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const handleSort = (field: typeof sortBy) => {
    if (sortBy === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(field); setSortDir(field === 'project_number' ? 'desc' : 'desc'); }
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

  // Derived: overall margin for header KPI (revenue is GST-aware via includeGst).
  const overallMargin = totals.revenue > 0 ? (totals.profit / totals.revenue) * 100 : 0;

  return (
    <div style={{ padding: '28px 30px 60px', maxWidth: '1400px', margin: '0 auto' }}>
      <h1 className="ionex-page-title">
        Project Profitability
        <span className="ionex-page-title-actions">
          <span className="ionex-search-inline">
            <input
              type="text"
              placeholder="Search projects, customers, project #"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </span>
        </span>
      </h1>
      <p className="ionex-page-subtitle">
        Per-project P&amp;L · {filtered.length} of {projectFinancials.length} projects shown
      </p>

      <div className="ionex-filter-card">
        <div className="ionex-filter-card-row">
          <div className="ionex-field">
            <span className="ionex-field-label">Inactive</span>
            <div className="ionex-toggle-rail" role="group" aria-label="Active vs inactive">
              <button
                type="button"
                className={`ionex-toggle-button${!showInactive ? ' is-active' : ''}`}
                onClick={() => setShowInactive(false)}
              >
                Active only
              </button>
              <button
                type="button"
                className={`ionex-toggle-button${showInactive ? ' is-active' : ''}`}
                onClick={() => setShowInactive(true)}
              >
                Include inactive
              </button>
            </div>
          </div>
          <div className="ionex-field">
            <span className="ionex-field-label">GST</span>
            <div className="ionex-toggle-rail" role="group" aria-label="Toggle GST">
              <button
                type="button"
                className={`ionex-toggle-button${includeGst ? ' is-active' : ''}`}
                onClick={() => setIncludeGst(true)}
              >
                Inclusive (+5%)
              </button>
              <button
                type="button"
                className={`ionex-toggle-button${!includeGst ? ' is-active' : ''}`}
                onClick={() => setIncludeGst(false)}
              >
                Pre-GST
              </button>
            </div>
          </div>
        </div>
      </div>

      <ReportMethodologyCollapsible variant="profitability" />

      {/* Summary Cards — semantic palette mirrors EmployeeReports. */}
      <div className="ionex-summary-grid">
        {([
          { key: 'revenue', label: 'Total Revenue',  value: `$${fmt(totals.revenue)}`, accent: 'var(--primary-color)' },
          { key: 'cost',    label: 'Total Cost',     value: `$${fmt(totals.cost)}`,    accent: 'var(--warning-color)' },
          { key: 'profit',  label: 'Total Profit',   value: `$${fmt(totals.profit)}`,  accent: totals.profit >= 0 ? 'var(--success-color)' : 'var(--error-color)' },
          { key: 'margin',  label: 'Overall Margin', value: `${overallMargin.toFixed(1)}%`, accent: overallMargin >= 20 ? 'var(--success-color)' : overallMargin >= 0 ? 'var(--warning-color)' : 'var(--error-color)' },
          { key: 'hours',   label: 'Total Hours',    value: totals.hours.toFixed(1),   accent: 'var(--text-tertiary)' },
          { key: 'tickets', label: 'Service Tickets',value: String(totals.tickets),    accent: 'var(--text-tertiary)' },
        ]).map((card) => (
          <div
            key={card.key}
            className="ionex-summary-card"
            style={{ ['--summary-accent' as string]: card.accent } as React.CSSProperties}
          >
            <span className="ionex-summary-card-eyebrow">
              <span className="accent" />
              {card.label}
            </span>
            <span className="ionex-summary-card-value">{card.value}</span>
          </div>
        ))}
      </div>

      <div className="ionex-section-heading">
        <div className="ionex-section-heading-title-row">
          <h2>Projects</h2>
          <span className="ionex-section-heading-meta">
            <strong>{filtered.length}</strong> {filtered.length === 1 ? 'project' : 'projects'}
          </span>
        </div>
      </div>

      {/* Project List */}
      <div className="ionex-report-table-card">
        <table className="ionex-report-table has-row-action">
          <thead>
            <tr>
              <th className={`is-sortable${sortBy === 'project_number' ? ' is-sorted' : ''}`} onClick={() => handleSort('project_number')}>
                Project{sortBy === 'project_number' && <span className="ionex-sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>}
              </th>
              <th className="align-center">Budget Usage</th>
              <th className={`align-right is-sortable${sortBy === 'revenue' ? ' is-sorted' : ''}`} onClick={() => handleSort('revenue')}>
                Revenue{sortBy === 'revenue' && <span className="ionex-sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>}
              </th>
              <th className="align-right">Cost</th>
              <th className={`align-right is-sortable${sortBy === 'profit' ? ' is-sorted' : ''}`} onClick={() => handleSort('profit')}>
                Profit{sortBy === 'profit' && <span className="ionex-sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>}
              </th>
              <th className={`align-right is-sortable${sortBy === 'margin' ? ' is-sorted' : ''}`} onClick={() => handleSort('margin')}>
                Margin{sortBy === 'margin' && <span className="ionex-sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>}
              </th>
              <th className="align-right">Hours</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: '56px 32px' }}>
                  <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '32px', lineHeight: 1, opacity: 0.35 }}>◧</span>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)' }}>No projects match the filters</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                      {searchTerm
                        ? `Nothing matches "${searchTerm}". Clear the search or toggle "Include inactive".`
                        : 'Toggle "Include inactive" to see closed projects.'}
                    </div>
                  </div>
                </td>
              </tr>
            )}
            {filtered.map((p) => {
              const isExpanded = expandedProjectId === p.projectId;
              const budgetPct = p.budget ? Math.min((p.revenue / p.budget) * 100, 100) : null;
              const overBudget = p.budget ? p.revenue > p.budget : false;
              const closedRow = p.isCompleted;
              const marginTier = p.margin >= 20 ? 'is-good' : p.margin >= 0 ? 'is-warn' : 'is-bad';
              const rowCls = [
                isExpanded ? 'is-active' : '',
                closedRow ? 'is-muted' : '',
              ].filter(Boolean).join(' ');

              return (
                <tr
                  key={p.projectId}
                  onClick={() => setExpandedProjectId(isExpanded ? null : p.projectId)}
                  className={rowCls}
                >
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span
                        aria-hidden
                        style={{
                          width: '10px',
                          height: '10px',
                          borderRadius: '50%',
                          backgroundColor: p.color,
                          flexShrink: 0,
                          opacity: closedRow ? 0.6 : 1,
                          boxShadow: `0 0 0 2px color-mix(in srgb, ${p.color} 24%, transparent)`,
                        }}
                      />
                      <div style={{ minWidth: 0 }}>
                        <div className="row-primary" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', color: closedRow ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
                          <span>{p.projectNumber ? `${p.projectNumber} · ` : ''}{p.name}</span>
                          {closedRow && (
                            <span
                              className="ionex-tag"
                              style={{ ['--tag-color' as string]: 'var(--text-tertiary)', padding: '2px 8px', fontSize: '10px', letterSpacing: '0.12em', textTransform: 'uppercase' } as React.CSSProperties}
                            >
                              Closed
                            </span>
                          )}
                        </div>
                        <div className="row-secondary">{p.customerName}</div>
                      </div>
                    </div>
                  </td>
                  <td className="align-center" style={{ minWidth: '200px' }} onClick={(e) => e.stopPropagation()}>
                    {p.budget ? (
                      <BudgetBar
                        pct={budgetPct!}
                        overBudget={overBudget}
                        budget={p.budget}
                        revenue={p.revenue}
                        revenueApproved={p.revenueApproved}
                        revenueAllTickets={p.revenueAllTickets}
                      />
                    ) : editingBudgetProjectId === p.projectId ? (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>$</span>
                        <input
                          ref={budgetInputRef}
                          type="number"
                          min="0"
                          step="0.01"
                          value={budgetInputValue}
                          onChange={(e) => setBudgetInputValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const val = parseFloat(budgetInputValue);
                              if (!isNaN(val) && val > 0) {
                                budgetMutation.mutate({ projectId: p.projectId, budget: val });
                              } else {
                                setEditingBudgetProjectId(null);
                                setBudgetInputValue('');
                              }
                            } else if (e.key === 'Escape') {
                              setEditingBudgetProjectId(null);
                              setBudgetInputValue('');
                            }
                          }}
                          onBlur={() => {
                            const val = parseFloat(budgetInputValue);
                            if (!isNaN(val) && val > 0) {
                              budgetMutation.mutate({ projectId: p.projectId, budget: val });
                            } else {
                              setEditingBudgetProjectId(null);
                              setBudgetInputValue('');
                            }
                          }}
                          placeholder="0"
                          className="ionex-field-input"
                          style={{ width: '100px', padding: '4px 8px', fontSize: '12px', textAlign: 'right' }}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingBudgetProjectId(p.projectId);
                          setBudgetInputValue('');
                        }}
                        style={{
                          background: 'none',
                          border: '1px dashed var(--border-color)',
                          borderRadius: '6px',
                          padding: '3px 10px',
                          cursor: 'pointer',
                          fontSize: '11px',
                          color: 'var(--text-tertiary)',
                          fontFamily: 'inherit',
                        }}
                      >
                        + Add budget
                      </button>
                    )}
                  </td>
                  <td className="align-right is-mono">
                    <span className="ionex-money">${fmt(p.revenue)}</span>
                  </td>
                  <td className="align-right is-mono">
                    <span className="ionex-money is-muted">${fmt(p.totalCost)}</span>
                  </td>
                  <td className="align-right is-mono">
                    <span className={`ionex-money ${p.profit >= 0 ? 'is-good' : 'is-bad'}`}>${fmt(p.profit)}</span>
                  </td>
                  <td className="align-right">
                    <span className={`ionex-margin-chip ${marginTier}`}>{p.margin.toFixed(1)}%</span>
                  </td>
                  <td className="align-right is-mono" style={{ color: 'var(--text-secondary)' }}>
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
          className="ionex-modal-backdrop"
          style={{
            position: 'fixed',
            inset: 0,
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
            className="ionex-modal-card"
            style={{
              backgroundColor: 'var(--bg-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: '14px',
              maxWidth: '1040px',
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
              padding: '28px 32px 32px',
              boxShadow: 'var(--shadow-lg)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px', gap: '16px' }}>
              <div style={{ minWidth: 0 }}>
                {expandedProject.isCompleted ? (
                  <div
                    className="ionex-tag"
                    style={{
                      ['--tag-color' as string]: 'var(--text-tertiary)',
                      marginBottom: '10px',
                      padding: '6px 12px',
                      fontSize: '11px',
                      letterSpacing: '0.05em',
                    } as React.CSSProperties}
                  >
                    Closed on Projects page · totals unchanged
                  </div>
                ) : null}
                <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 800, letterSpacing: '-0.012em', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span
                    aria-hidden
                    style={{
                      display: 'inline-block',
                      width: '12px',
                      height: '12px',
                      borderRadius: '50%',
                      backgroundColor: expandedProject.color,
                      boxShadow: `0 0 0 3px color-mix(in srgb, ${expandedProject.color} 24%, transparent)`,
                      flexShrink: 0,
                    }}
                  />
                  {expandedProject.projectNumber ? `${expandedProject.projectNumber} · ` : ''}{expandedProject.name}
                </h2>
                <p style={{ margin: '4px 0 0 24px', fontSize: '13px', color: 'var(--text-tertiary)' }}>{expandedProject.customerName}</p>
              </div>
              <button
                onClick={() => setExpandedProjectId(null)}
                className="ionex-report-action"
                aria-label="Close"
              >
                {'\u2715'}
              </button>
            </div>

            {/* Headline P&L strip */}
            <div className="ionex-pl-strip">
              <div className="ionex-pl-cell is-primary">
                <span className="ionex-pl-cell-label">Revenue</span>
                <span className="ionex-pl-cell-value">${fmt(expandedProject.revenue)}</span>
                {expandedProject.expenseBilledPreGst > 0 && (
                  <span className="ionex-pl-cell-sub">
                    incl. ${fmt(includeGst ? expandedProject.expenseBilledPreGst * 1.05 : expandedProject.expenseBilledPreGst)} expense billout
                  </span>
                )}
              </div>
              <span className="ionex-pl-op">−</span>
              <div className="ionex-pl-cell is-warn">
                <span className="ionex-pl-cell-label">Cost</span>
                <span className="ionex-pl-cell-value">${fmt(expandedProject.totalCost)}</span>
                <span className="ionex-pl-cell-sub">
                  labour ${fmt(expandedProject.laborCost)}
                  {expandedProject.expenseCost > 0 ? ` · expenses $${fmt(expandedProject.expenseCost)}` : ''}
                </span>
              </div>
              <span className="ionex-pl-op">=</span>
              <div className={`ionex-pl-cell ${expandedProject.profit >= 0 ? 'is-positive' : 'is-negative'}`}>
                <span className="ionex-pl-cell-label">Net Profit</span>
                <span className="ionex-pl-cell-value">${fmt(expandedProject.profit)}</span>
                <span className="ionex-pl-cell-sub">{expandedProject.margin.toFixed(1)}% margin</span>
              </div>
              <span />
            </div>

            {/* Secondary stats */}
            <div className="ionex-kpi-mini-grid" style={{ marginBottom: '20px' }}>
              {expandedProject.budget && (
                <KpiCard label="Budget" value={`$${fmt(expandedProject.budget)}`} accent="var(--text-secondary)" />
              )}
              <KpiCard label="Hours" value={expandedProject.totalHours.toFixed(1)} accent="var(--text-tertiary)" />
              <KpiCard label="Tickets" value={String(expandedProject.ticketCount)} accent="var(--text-tertiary)" />
              {expandedProject.budget && (
                <KpiCard
                  label="Budget Used"
                  value={`${Math.min((expandedProject.revenue / expandedProject.budget) * 100, 999).toFixed(0)}%`}
                  accent={
                    expandedProject.revenue > expandedProject.budget
                      ? 'var(--error-color)'
                      : (expandedProject.revenue / expandedProject.budget) * 100 > 80
                        ? 'var(--warning-color)'
                        : 'var(--primary-color)'
                  }
                />
              )}
            </div>

            {/* Budget Bar (detail) */}
            {expandedProject.budget && (
              <div className="ionex-modal-section" style={{ borderTop: 'none', paddingTop: 0 }}>
                <div className="ionex-modal-section-head">
                  <span className="ionex-modal-section-title">Budget Usage</span>
                  <span className="ionex-modal-section-meta">
                    <strong>${fmt(expandedProject.revenue)}</strong> of ${fmt(expandedProject.budget)}
                  </span>
                </div>
                <BudgetBar
                  pct={Math.min((expandedProject.revenue / expandedProject.budget) * 100, 100)}
                  overBudget={expandedProject.revenue > expandedProject.budget}
                  budget={expandedProject.budget}
                  revenue={expandedProject.revenue}
                  revenueApproved={expandedProject.revenueApproved}
                  revenueAllTickets={expandedProject.revenueAllTickets}
                  large
                />
              </div>
            )}

            {/* Labour Breakdown \u2014 per-employee loaded cost */}
            <div className="ionex-modal-section">
              <div className="ionex-modal-section-head">
                <span className="ionex-modal-section-title">Labour breakdown</span>
                <span className="ionex-modal-section-meta">
                  {expandedLaborByEmployee.length} {expandedLaborByEmployee.length === 1 ? 'person' : 'people'} \u00b7 <strong>${fmt(expandedProject.laborCost)}</strong>
                </span>
              </div>
              {expandedLaborByEmployee.length === 0 ? (
                <div className="ionex-mini-empty">No labour recorded on this project.</div>
              ) : (
                <>
                  <table className="ionex-compact-table">
                    <thead>
                      <tr>
                        <th>Employee</th>
                        <th className="align-right">Hours</th>
                        <th className="align-right">Loaded Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {expandedLaborByEmployee.map((emp, i) => (
                        <tr key={i}>
                          <td>{emp.name}</td>
                          <td className="align-right">{emp.hours.toFixed(1)}</td>
                          <td className="align-right">
                            <span className="ionex-money is-warn">${fmt(emp.cost)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td>Total</td>
                        <td className="align-right">{expandedLaborByEmployee.reduce((s, e) => s + e.hours, 0).toFixed(1)}</td>
                        <td className="align-right">
                          <span className="ionex-money is-warn">${fmt(expandedProject.laborCost)}</span>
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                  <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontStyle: 'italic', marginTop: '8px', marginBottom: 0 }}>
                    Loaded cost includes burden from actual employee data (benefits, CPP, EI, allowances; 5% for contractors).
                  </p>
                </>
              )}
            </div>

            {/* Expense billout — billed vs cost */}
            <div className="ionex-modal-section">
              <div className="ionex-modal-section-head">
                <button
                  type="button"
                  className="ionex-disclosure"
                  aria-expanded={expenseMarkupExpanded}
                  onClick={() => setExpenseMarkupExpanded(v => !v)}
                >
                  <span className="ionex-disclosure-chevron">▶</span>
                  Expense billout
                  <span className="ionex-disclosure-sub">
                    net markup{' '}
                    <span className={expandedExpenseMarkupKnownTotal >= 0 ? 'ionex-money is-good' : 'ionex-money is-bad'}>
                      ${fmt(expandedExpenseMarkupKnownTotal)}
                    </span>
                  </span>
                </button>
              </div>
              {expenseMarkupExpanded && (
                <div>
                  {expandedExpenses.length === 0 ? (
                    <div className="ionex-mini-empty">No billout expenses on this project.</div>
                  ) : (
                    <>
                      <table className="ionex-compact-table">
                        <thead>
                          <tr>
                            <th>Description</th>
                            <th className="align-right">Qty</th>
                            <th className="align-right">Rate</th>
                            <th className="align-right">Billed</th>
                            <th className="align-right">Cost</th>
                            <th className="align-right">Markup</th>
                          </tr>
                        </thead>
                        <tbody>
                          {expandedExpenses.map((exp: any, i: number) => (
                            <tr key={i}>
                              <td>
                                <span style={{ fontWeight: 500 }}>{exp.description}</span>
                                {exp.type && (
                                  <span style={{ marginLeft: '8px', fontSize: '11px', color: 'var(--text-tertiary)' }}>
                                    ({exp.type})
                                  </span>
                                )}
                              </td>
                              <td className="align-right">{exp.quantity}</td>
                              <td className="align-right">${fmt(exp.rate)}</td>
                              <td className="align-right">
                                <span className="ionex-money">${fmt(exp.total)}</span>
                              </td>
                              <td className="align-right">
                                <span className={exp.cost > 0 ? 'ionex-money is-warn' : 'ionex-money is-muted'}>
                                  ${fmt(exp.cost)}
                                </span>
                              </td>
                              <td className="align-right">
                                <span className={`ionex-money ${exp.profit >= 0 ? 'is-good' : 'is-bad'}`}>
                                  ${fmt(exp.profit)}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '10px', marginBottom: 0 }}>
                        Company cost uses <strong>Actual Cost ($)</strong> on the ticket line when set; otherwise reimbursable
                        lines use reimbursement rules, and billed-only equipment/misc uses billed total as a pass-through COGS
                        estimate (0 markup until vendor cost is entered).
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Revenue (Tickets) Breakdown */}
            <div className="ionex-modal-section">
              <div className="ionex-modal-section-head">
                <span className="ionex-modal-section-title">Revenue by ticket</span>
                <span className="ionex-modal-section-meta">
                  <strong>{expandedTickets.length}</strong> {expandedTickets.length === 1 ? 'ticket' : 'tickets'}
                </span>
              </div>
              {expandedTickets.length === 0 ? (
                <div className="ionex-mini-empty">No tickets recorded for this project.</div>
              ) : (
                <>
                  <table className="ionex-compact-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Ticket</th>
                        <th className="align-right">Hours</th>
                        <th className="align-right">Revenue</th>
                        <th className="align-right">Payroll Cost</th>
                        <th className="align-right">Net Profit</th>
                        <th className="align-center">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {expandedTickets.map((t: any) => {
                        const rev = Number(t.total_amount) || 0;
                        const emp = empByUserId.get(t.user_id);
                        const empName = emp?.user ? [emp.user.first_name, emp.user.last_name].filter(Boolean).join(' ') : null;
                        const isDraft = t.workflow_status === 'draft' || t.workflow_status === 'submitted' || t.workflow_status === 'rejected';
                        const isInternal = rev === 0 && (t.payrollCost || 0) > 0 && !isDraft;
                        const hasTicketNumber = !!t.ticket_number;
                        const ticketDisplay = !hasTicketNumber
                          ? 'Pending Approval'
                          : (isInternal && empName ? `${empName} - internal` : t.ticket_number);
                        const draftTitle = 'Draft – not included in totals';
                        return (
                          <tr key={t.id} className={isDraft ? 'is-subtle' : undefined} style={isDraft ? { opacity: 0.78 } : undefined}>
                            <td style={{ whiteSpace: 'nowrap' }}>{t.date}</td>
                            <td>
                              <div>
                                <span
                                  style={{
                                    fontFamily: isInternal && hasTicketNumber ? 'inherit' : 'ui-monospace, monospace',
                                    color: hasTicketNumber ? 'var(--text-primary)' : 'var(--warning-color)',
                                    fontWeight: hasTicketNumber ? 500 : 600,
                                  }}
                                >
                                  {ticketDisplay}
                                </span>
                                {empName && !isInternal && (
                                  <div className="row-secondary">{empName}</div>
                                )}
                              </div>
                            </td>
                            <td className="align-right">{Number(t.total_hours || 0).toFixed(1)}</td>
                            <td className="align-right">
                              <span className={isDraft ? 'ionex-money is-warn' : 'ionex-money'} title={isDraft ? draftTitle : undefined} style={isDraft ? { fontStyle: 'italic' } : undefined}>
                                ${fmt(rev)}{isDraft ? ' *' : ''}
                              </span>
                            </td>
                            <td className="align-right">
                              <span className={isDraft ? 'ionex-money is-warn' : 'ionex-money is-muted'} title={isDraft ? draftTitle : undefined} style={isDraft ? { fontStyle: 'italic' } : undefined}>
                                ${fmt(t.payrollCost || 0)}{isDraft ? ' *' : ''}
                              </span>
                            </td>
                            <td className="align-right">
                              <span
                                className={isDraft ? 'ionex-money is-warn' : (t.profit || 0) >= 0 ? 'ionex-money is-good' : 'ionex-money is-bad'}
                                title={isDraft ? draftTitle : undefined}
                                style={isDraft ? { fontStyle: 'italic' } : undefined}
                              >
                                ${fmt(t.profit || 0)}{isDraft ? ' *' : ''}
                              </span>
                            </td>
                            <td className="align-center">
                              {!hasTicketNumber && (t.workflow_status === 'submitted' || t.workflow_status === 'draft') ? (
                                <span
                                  style={{
                                    padding: '2px 8px',
                                    borderRadius: '999px',
                                    fontSize: '11px',
                                    fontWeight: 700,
                                    color: 'var(--warning-color)',
                                    backgroundColor: 'color-mix(in srgb, var(--warning-color) 12%, transparent)',
                                    border: '1px solid color-mix(in srgb, var(--warning-color) 30%, transparent)',
                                  }}
                                >
                                  Pending
                                </span>
                              ) : (
                                <StatusBadge status={t.workflow_status} />
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {(() => {
                        const ticketHours = expandedTickets.reduce((sum: number, t: any) => sum + (Number(t.total_hours) || 0), 0);
                        const ticketCost = expandedTickets.reduce((sum: number, t: any) => sum + (t.payrollCost || 0), 0);
                        const totalProjectHours = expandedProject?.totalHours || 0;
                        const totalProjectCost = expandedProject?.laborCost || 0;
                        const unbilledHours = totalProjectHours - ticketHours;
                        const unbilledCost = totalProjectCost - ticketCost;
                        if (unbilledHours <= 0.05) return null;
                        return (
                          <tr className="is-warn">
                            <td />
                            <td>
                              <span style={{ color: 'var(--error-color)', fontStyle: 'italic', fontSize: '12px', fontWeight: 600 }}>
                                Unbilled labour
                              </span>
                            </td>
                            <td className="align-right">
                              <span className="ionex-money is-bad">{unbilledHours.toFixed(1)}</span>
                            </td>
                            <td className="align-right" style={{ color: 'var(--text-tertiary)' }}>—</td>
                            <td className="align-right">
                              <span className="ionex-money is-bad">${fmt(unbilledCost)}</span>
                            </td>
                            <td className="align-right">
                              <span className="ionex-money is-bad">-${fmt(unbilledCost)}</span>
                            </td>
                            <td className="align-center">
                              <span style={{ fontSize: '11px', color: 'var(--error-color)', fontStyle: 'italic' }}>No ticket</span>
                            </td>
                          </tr>
                        );
                      })()}
                    </tbody>
                  </table>
                  {expandedTickets.some((t: any) => t.workflow_status === 'draft' || t.workflow_status === 'submitted' || t.workflow_status === 'rejected') && (
                    <p style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--warning-color)', fontStyle: 'italic' }}>
                      * Draft / submitted / rejected amounts are shown for reference but not included in totals.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BudgetBar({
  pct,
  overBudget,
  budget,
  revenue,
  revenueApproved = revenue,
  revenueAllTickets = revenue,
  large,
}: {
  pct: number;
  overBudget: boolean;
  budget: number;
  revenue: number;
  revenueApproved?: number;
  revenueAllTickets?: number;
  large?: boolean;
}) {
  // Tiered accent: error when over, warning when ≥80%, brand red otherwise.
  const accentVar = overBudget ? 'var(--error-color)' : pct > 80 ? 'var(--warning-color)' : 'var(--primary-color)';

  const approvedPct = budget > 0 ? Math.min((revenueApproved / budget) * 100, 100) : 0;
  const pendingPct = budget > 0 ? Math.min(((revenueAllTickets - revenueApproved) / budget) * 100, Math.max(0, 100 - approvedPct)) : 0;

  return (
    <div>
      <div
        className={`ionex-progress${large ? ' is-large' : ''}`}
        style={{ ['--progress-color' as string]: accentVar } as React.CSSProperties}
      >
        {approvedPct > 0 && (
          <div
            title="Approved: revenue from approved/exported tickets"
            className="ionex-progress-segment is-primary"
            style={{ width: `${approvedPct}%` }}
          />
        )}
        {pendingPct > 0 && (
          <div
            title="Pending: revenue on draft, submitted, or rejected tickets (not yet contributing)"
            className="ionex-progress-segment is-pending"
            style={{ width: `${pendingPct}%` }}
          />
        )}
        {(large || overBudget) && (
          <div
            className="ionex-progress-label"
            style={{
              color: overBudget || pct > 50 ? '#fff' : 'var(--text-primary)',
              textShadow: overBudget || pct > 50 ? '0 1px 2px rgba(0,0,0,0.35)' : 'none',
            }}
          >
            {overBudget ? 'Over budget' : `${pct.toFixed(0)}%`}
          </div>
        )}
      </div>
      <div className="ionex-progress-caption">
        <span>${(revenue / 1000).toFixed(1)}k</span>
        <span>${(budget / 1000).toFixed(1)}k</span>
      </div>
    </div>
  );
}

function KpiCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div
      className="ionex-kpi-mini"
      style={accent ? ({ ['--kpi-accent' as string]: accent } as React.CSSProperties) : undefined}
    >
      <span className="ionex-kpi-mini-label">{label}</span>
      <span className="ionex-kpi-mini-value">{value}</span>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '24px' }}>
      <div className="ionex-section-heading">
        <div className="ionex-section-heading-title-row">
          <h3>{title}</h3>
        </div>
      </div>
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  // Normalise to the four lifecycle states. Legacy CNRL-pipeline rows
  // (pdf_exported / qbo_created / sent_to_cnrl / cnrl_approved /
  //  submitted_to_cnrl) collapse to "Approved" since they were all
  // post-approval steps.
  const raw = (status || '').toLowerCase();
  const normalised: 'draft' | 'submitted' | 'approved' | 'rejected' =
    raw === 'draft' || raw === 'submitted' || raw === 'rejected'
      ? raw
      : 'approved';
  const palette: Record<string, { color: string; label: string }> = {
    draft:     { color: 'var(--text-tertiary)',  label: 'Draft' },
    submitted: { color: 'var(--warning-color)',  label: 'Submitted' },
    approved:  { color: 'var(--success-color)',  label: 'Approved' },
    rejected:  { color: 'var(--error-color)',    label: 'Rejected' },
  };
  const { color, label } = palette[normalised];
  return (
    <span
      className="ionex-status-pill"
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
        color,
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
      }}
    >
      {label}
    </span>
  );
}

const detailThStyle: React.CSSProperties = {
  padding: '10px 12px',
  fontSize: '10px',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  color: 'var(--text-tertiary)',
  textAlign: 'left',
};

const detailTdStyle: React.CSSProperties = {
  padding: '10px 12px',
  fontSize: '13px',
  color: 'var(--text-primary)',
  fontVariantNumeric: 'tabular-nums',
};
