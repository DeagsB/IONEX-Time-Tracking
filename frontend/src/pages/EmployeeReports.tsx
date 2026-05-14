import { useState, useMemo, useEffect, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { reportsService, payRateHistoryService, serviceTicketExpensesService } from '../services/supabaseServices';
import {
  aggregateAllEmployees,
  aggregateEmployeeMetrics,
  getTimePeriodPresets,
  formatCurrency,
  formatPercentage,
  EmployeeMetrics,
  maybeApplyGst,
  ticketExpenseCategoryForEmployeeReport,
  EMPLOYEE_REPORT_EXPENSE_CATEGORY_ORDER,
  reimbRateForEmployeeReportExpense,
} from '../utils/employeeReports';
import {
  exportEmployeeReportsToExcel,
  exportEmployeeReportsToPDF,
} from '../utils/exportEmployeeReports';
import { ticketExpenseCostForMargin } from '../utils/ticketExpenseReimbursement';
import { ReportMethodologyCollapsible } from '../components/ReportMethodologyCollapsible';

const formatHoursDecimal = (hours: number): string => hours.toFixed(2);

/** First letter of first + last word in the name, uppercase. */
const initialsFor = (name: string): string => {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '–';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
};

/** Stable color from a userId via FNV-ish hash → small curated palette
 *  using theme tokens so dark mode adapts. */
const AVATAR_PALETTE = [
  'var(--primary-color)',
  'var(--success-color)',
  'var(--warning-color)',
  'var(--text-secondary)',
  '#0ea5e9',
  '#8b5cf6',
  '#14b8a6',
];
const avatarColorFor = (id: string): string => {
  let h = 2166136261;
  for (let i = 0; i < (id || '').length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length]!;
};

/** Laptop + misc: expandable line-item lists under the expense breakdown */
const EXPENSE_BREAKDOWN_DRILLDOWN_CATEGORIES = new Set<string>(
  EMPLOYEE_REPORT_EXPENSE_CATEGORY_ORDER.slice(3) as unknown as string[]
);

export default function EmployeeReports() {
  const { user, isAdmin } = useAuth();
  const [selectedPeriod, setSelectedPeriod] = useState('All-Time');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('all');
  const [selectedDepartment, setSelectedDepartment] = useState<string>('all');
  const [expandedEmployee, setExpandedEmployee] = useState<string | null>(null);
  const [expensesSectionExpanded, setExpensesSectionExpanded] = useState(false);
  const [expandedExpenseDateKeys, setExpandedExpenseDateKeys] = useState<Set<string>>(new Set());
  const [expandedExpenseTicketKeys, setExpandedExpenseTicketKeys] = useState<Set<string>>(new Set());
  const [expenseBreakdownExpanded, setExpenseBreakdownExpanded] = useState(false);
  const [expandedExpenseDrilldownKeys, setExpandedExpenseDrilldownKeys] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (expandedEmployee) {
      setExpensesSectionExpanded(true);
      setExpandedExpenseDateKeys(new Set());
      setExpandedExpenseTicketKeys(new Set());
      setExpenseBreakdownExpanded(false);
      setExpandedExpenseDrilldownKeys(new Set());
    }
  }, [expandedEmployee]);
  const [sortField, setSortField] = useState<keyof EmployeeMetrics>('totalHours');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');
  const [includeGst, setIncludeGst] = useState(true);

  const periodPresets = getTimePeriodPresets();
  const currentPeriod = periodPresets.find(p => p.label === selectedPeriod) || periodPresets[0];

  const getDateRange = () => {
    if (selectedPeriod === 'Custom Range') {
      if (customStartDate && customEndDate) {
        return { startDate: customStartDate, endDate: customEndDate };
      }
      const today = new Date();
      const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
      const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return {
        startDate: firstDay.toISOString().split('T')[0],
        endDate: lastDay.toISOString().split('T')[0],
      };
    }
    return currentPeriod.getValue();
  };

  const { startDate, endDate } = getDateRange();

  const { data: employees, isLoading: loadingEmployees } = useQuery({
    queryKey: ['employeesWithRates'],
    queryFn: () => reportsService.getEmployeesWithRates(),
    enabled: isAdmin,
  });

  const { data: timeEntries, isLoading: loadingEntries } = useQuery({
    queryKey: ['employeeAnalytics', startDate, endDate, selectedEmployeeId],
    queryFn: () =>
      reportsService.getEmployeeAnalytics(
        startDate,
        endDate,
        selectedEmployeeId !== 'all' ? selectedEmployeeId : undefined
      ),
    enabled: isAdmin && !!startDate && !!endDate,
    retry: 1,
  });

  const { data: serviceTicketHours, isLoading: loadingTicketHours } = useQuery({
    queryKey: ['serviceTicketHours', startDate, endDate, selectedEmployeeId],
    queryFn: () =>
      reportsService.getServiceTicketHours(
        startDate,
        endDate,
        selectedEmployeeId !== 'all' ? selectedEmployeeId : undefined
      ),
    enabled: isAdmin && !!startDate && !!endDate,
    retry: 1,
  });

  const { data: rateHistory } = useQuery({
    queryKey: ['payRateHistory'],
    queryFn: () => payRateHistoryService.getAll(),
    enabled: isAdmin,
  });

  const { data: ticketExpenses = [] } = useQuery({
    queryKey: ['employee-report-expenses', startDate, endDate],
    queryFn: () => serviceTicketExpensesService.getReimbursableByDateRange(startDate, endDate),
    enabled: isAdmin && !!startDate && !!endDate,
  });

  const employeeMetrics = useMemo(() => {
    if (!employees) return [];
    if (loadingEntries || !timeEntries || loadingTicketHours) {
      return employees.map((emp: any) => aggregateEmployeeMetrics([], emp, [], undefined, undefined, includeGst));
    }
    return aggregateAllEmployees(timeEntries, employees, serviceTicketHours || [], rateHistory || [], ticketExpenses as any, includeGst);
  }, [timeEntries, employees, loadingEntries, serviceTicketHours, loadingTicketHours, rateHistory, ticketExpenses, includeGst]);

  const departments = useMemo(() => {
    const depts = new Set<string>();
    depts.add('Automation');
    if (employees) {
      employees.forEach((emp: any) => {
        if (emp.department) depts.add(emp.department);
      });
    }
    return Array.from(depts).sort();
  }, [employees]);

  const filteredMetrics = useMemo(() => {
    let filtered = employeeMetrics;
    if (selectedEmployeeId !== 'all') {
      filtered = filtered.filter(m => m.userId === selectedEmployeeId);
    }
    if (selectedDepartment !== 'all') {
      filtered = filtered.filter(m => {
        const employee = employees?.find((emp: any) => emp.user_id === m.userId);
        return employee?.department === selectedDepartment;
      });
    }
    return filtered;
  }, [employeeMetrics, selectedEmployeeId, selectedDepartment, employees]);

  const sortedMetrics = useMemo(() => {
    return [...filteredMetrics].sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
      }
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return 0;
    });
  }, [filteredMetrics, sortField, sortDirection]);

  const totals = useMemo(() => {
    const result = sortedMetrics.reduce(
      (acc, m) => ({
        billableHours: acc.billableHours + m.billableHours,
        nonBillableHours: acc.nonBillableHours + m.nonBillableHours,
        totalRevenue: acc.totalRevenue + m.totalRevenue,
        totalCost: acc.totalCost + m.totalCost,
        serviceTicketCount: acc.serviceTicketCount + m.serviceTicketCount,
      }),
      { billableHours: 0, nonBillableHours: 0, totalRevenue: 0, totalCost: 0, serviceTicketCount: 0 }
    );
    // Match Revenue − Cost (not Σ per-employee netProfit) so KPIs reconcile and float noise stays sub-cent after rounding
    const netProfit = Math.round((result.totalRevenue - result.totalCost) * 100) / 100;
    return { ...result, totalHours: result.billableHours + result.nonBillableHours, netProfit };
  }, [sortedMetrics]);

  const handleSort = (field: keyof EmployeeMetrics) => {
    if (sortField === field) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const sortArrow = (field: keyof EmployeeMetrics) =>
    sortField === field ? (sortDirection === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  const isLoading = loadingEmployees || loadingEntries;

  const expandedMetrics = useMemo(() => {
    if (!expandedEmployee) return null;
    return sortedMetrics.find(m => m.userId === expandedEmployee) || null;
  }, [expandedEmployee, sortedMetrics]);

  const expandedEmpRecord = useMemo(() => {
    if (!expandedEmployee || !employees) return undefined;
    return (employees as any[]).find((e: any) => e.user_id === expandedEmployee);
  }, [expandedEmployee, employees]);

  const fmt = (n: number) => n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  if (!isAdmin) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>
        <h2>Access Denied</h2>
        <p>You must be an administrator to view employee reports.</p>
      </div>
    );
  }

  const billablePct = totals.totalHours > 0 ? (totals.billableHours / totals.totalHours) * 100 : 0;
  const profitMargin = totals.totalRevenue > 0 ? (totals.netProfit / totals.totalRevenue) * 100 : 0;

  return (
    <div style={{ padding: '28px 30px 60px', maxWidth: '1400px', margin: '0 auto' }}>
      {/* Page title */}
      <h1 className="ionex-page-title">
        Employee Reports
        <span className="ionex-page-title-actions">
          <button
            type="button"
            className="ionex-report-action"
            onClick={() => exportEmployeeReportsToPDF(sortedMetrics, totals, selectedPeriod, `employee-reports-${startDate}-${endDate}`)}
            disabled={isLoading || sortedMetrics.length === 0}
          >
            Export PDF
          </button>
          <button
            type="button"
            className="ionex-report-action"
            onClick={() => exportEmployeeReportsToExcel(sortedMetrics, totals, selectedPeriod, `employee-reports-${startDate}-${endDate}`)}
            disabled={isLoading || sortedMetrics.length === 0}
          >
            Export Excel
          </button>
        </span>
      </h1>
      <p className="ionex-page-subtitle">Performance and profitability per employee · {selectedPeriod}{selectedPeriod === 'Custom Range' && customStartDate && customEndDate ? ` · ${customStartDate} → ${customEndDate}` : ''}</p>

      {/* Filters */}
      <div className="ionex-filter-card">
        <div className="ionex-filter-card-row">
          <label className="ionex-field">
            <span className="ionex-field-label">Period</span>
            <select
              value={selectedPeriod}
              onChange={(e) => {
                setSelectedPeriod(e.target.value);
                if (e.target.value !== 'Custom Range') {
                  setCustomStartDate('');
                  setCustomEndDate('');
                }
              }}
              className="ionex-field-input"
            >
              {periodPresets.map(preset => (
                <option key={preset.label} value={preset.label}>{preset.label}</option>
              ))}
            </select>
          </label>
          {selectedPeriod === 'Custom Range' && (
            <>
              <label className="ionex-field">
                <span className="ionex-field-label">From</span>
                <input type="date" value={customStartDate} onChange={(e) => setCustomStartDate(e.target.value)} className="ionex-field-input" />
              </label>
              <label className="ionex-field">
                <span className="ionex-field-label">To</span>
                <input type="date" value={customEndDate} onChange={(e) => setCustomEndDate(e.target.value)} min={customStartDate} className="ionex-field-input" />
              </label>
            </>
          )}
          <label className="ionex-field">
            <span className="ionex-field-label">Department</span>
            <select value={selectedDepartment} onChange={(e) => setSelectedDepartment(e.target.value)} className="ionex-field-input">
              <option value="all">All departments</option>
              {departments.map((dept) => <option key={dept} value={dept}>{dept}</option>)}
            </select>
          </label>
          <label className="ionex-field" style={{ minWidth: '200px' }}>
            <span className="ionex-field-label">Employee</span>
            <select value={selectedEmployeeId} onChange={(e) => setSelectedEmployeeId(e.target.value)} className="ionex-field-input">
              <option value="all">All employees</option>
              {employees?.map((emp: any) => (
                <option key={emp.user_id} value={emp.user_id}>{emp.user?.first_name} {emp.user?.last_name}</option>
              ))}
            </select>
          </label>
          <div className="ionex-field" style={{ alignSelf: 'flex-end' }}>
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

      <ReportMethodologyCollapsible variant="employee" />

      {/* Summary cards — coherent semantic palette:
          neutral for counts, brand red for money in, warning for money out,
          tiered success/warn/error for derived signals (margin, billable%, profit). */}
      <div className="ionex-summary-grid">
        {([
          { key: 'hours',    label: 'Total Hours',     value: formatHoursDecimal(totals.totalHours),     accent: 'var(--text-tertiary)' },
          { key: 'billable', label: 'Billable Hours',  value: formatHoursDecimal(totals.billableHours),  accent: 'var(--text-secondary)' },
          { key: 'billpct',  label: 'Avg Billable %',  value: `${billablePct.toFixed(1)}%`,              accent: billablePct >= 80 ? 'var(--success-color)' : billablePct >= 60 ? 'var(--warning-color)' : 'var(--error-color)' },
          { key: 'revenue',  label: 'Revenue',         value: `$${fmt(totals.totalRevenue)}`,            accent: 'var(--primary-color)' },
          { key: 'cost',     label: 'Total Cost',      value: `$${fmt(totals.totalCost)}`,               accent: 'var(--warning-color)' },
          { key: 'profit',   label: 'Net Profit',      value: `$${fmt(totals.netProfit)}`,               accent: totals.netProfit >= 0 ? 'var(--success-color)' : 'var(--error-color)' },
          { key: 'margin',   label: 'Profit Margin',   value: `${profitMargin.toFixed(1)}%`,             accent: profitMargin >= 20 ? 'var(--success-color)' : profitMargin >= 0 ? 'var(--warning-color)' : 'var(--error-color)' },
          { key: 'tickets',  label: 'Service Tickets', value: String(totals.serviceTicketCount),         accent: 'var(--text-tertiary)' },
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
          <h2>By Employee</h2>
          <span className="ionex-section-heading-meta">
            <strong>{sortedMetrics.length}</strong> {sortedMetrics.length === 1 ? 'employee' : 'employees'}
          </span>
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="ionex-status-card">
          <div className="glyph">∴</div>
          <div className="title">Loading employee data…</div>
        </div>
      )}

      {/* Employee Table */}
      {!isLoading && (
        <div className="ionex-report-table-card">
          <table className="ionex-report-table has-row-action">
            <thead>
              <tr>
                <th className={`is-sortable${sortField === 'employeeName' ? ' is-sorted' : ''}`} onClick={() => handleSort('employeeName')}>Employee{sortField === 'employeeName' && <span className="ionex-sort-arrow">{sortDirection === 'asc' ? '▲' : '▼'}</span>}</th>
                <th className="align-center">Billable %</th>
                <th className={`align-right is-sortable${sortField === 'totalRevenue' ? ' is-sorted' : ''}`} onClick={() => handleSort('totalRevenue')}>Revenue{sortField === 'totalRevenue' && <span className="ionex-sort-arrow">{sortDirection === 'asc' ? '▲' : '▼'}</span>}</th>
                <th className={`align-right is-sortable${sortField === 'totalCost' ? ' is-sorted' : ''}`} onClick={() => handleSort('totalCost')}>Cost{sortField === 'totalCost' && <span className="ionex-sort-arrow">{sortDirection === 'asc' ? '▲' : '▼'}</span>}</th>
                <th className={`align-right is-sortable${sortField === 'netProfit' ? ' is-sorted' : ''}`} onClick={() => handleSort('netProfit')}>Profit{sortField === 'netProfit' && <span className="ionex-sort-arrow">{sortDirection === 'asc' ? '▲' : '▼'}</span>}</th>
                <th className={`align-right is-sortable${sortField === 'profitMargin' ? ' is-sorted' : ''}`} onClick={() => handleSort('profitMargin')}>Margin{sortField === 'profitMargin' && <span className="ionex-sort-arrow">{sortDirection === 'asc' ? '▲' : '▼'}</span>}</th>
                <th className={`align-right is-sortable${sortField === 'serviceTicketCount' ? ' is-sorted' : ''}`} onClick={() => handleSort('serviceTicketCount')}>Tickets{sortField === 'serviceTicketCount' && <span className="ionex-sort-arrow">{sortDirection === 'asc' ? '▲' : '▼'}</span>}</th>
                <th className={`align-right is-sortable${sortField === 'totalHours' ? ' is-sorted' : ''}`} onClick={() => handleSort('totalHours')}>Hours{sortField === 'totalHours' && <span className="ionex-sort-arrow">{sortDirection === 'asc' ? '▲' : '▼'}</span>}</th>
              </tr>
            </thead>
            <tbody>
              {sortedMetrics.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: '56px 32px' }}>
                    <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '32px', lineHeight: 1, opacity: 0.35 }}>⌶</span>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)' }}>No employee data for this period</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>Try a wider period or remove the department/employee filters.</div>
                    </div>
                  </td>
                </tr>
              ) : (
                sortedMetrics.map((m) => {
                  const eff = m.efficiency;
                  const marginTier = m.profitMargin >= 20 ? 'is-good' : m.profitMargin >= 0 ? 'is-warn' : 'is-bad';
                  return (
                    <tr
                      key={m.userId}
                      onClick={() => setExpandedEmployee(expandedEmployee === m.userId ? null : m.userId)}
                      className={expandedEmployee === m.userId ? 'is-active' : ''}
                    >
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <span
                            className="ionex-avatar"
                            aria-hidden
                            style={{
                              ['--avatar-color' as string]: avatarColorFor(m.userId),
                            } as React.CSSProperties}
                          >
                            {initialsFor(m.employeeName)}
                          </span>
                          <div style={{ minWidth: 0 }}>
                            <div className="row-primary">{m.employeeName}</div>
                            {m.position && <div className="row-secondary">{m.position}</div>}
                          </div>
                        </div>
                      </td>
                      <td className="align-center" style={{ minWidth: '180px' }}>
                        <BillableBar
                          pct={eff}
                          billable={m.billableHours}
                          billableApproved={m.billableHoursApproved}
                          billableAllTickets={m.billableHoursAllTickets}
                          total={m.totalHours}
                        />
                      </td>
                      <td className="align-right is-mono">
                        <span className="ionex-money">${fmt(m.totalRevenue)}</span>
                      </td>
                      <td className="align-right is-mono">
                        <span className="ionex-money is-muted">${fmt(m.totalCost)}</span>
                      </td>
                      <td className="align-right is-mono">
                        <span className={`ionex-money ${m.netProfit >= 0 ? 'is-good' : 'is-bad'}`}>${fmt(m.netProfit)}</span>
                      </td>
                      <td className="align-right">
                        <span className={`ionex-margin-chip ${marginTier}`}>{m.profitMargin.toFixed(1)}%</span>
                      </td>
                      <td className="align-right is-mono" style={{ color: 'var(--text-secondary)' }}>
                        {m.serviceTicketCount}
                      </td>
                      <td className="align-right is-mono" style={{ color: 'var(--text-secondary)' }}>
                        {formatHoursDecimal(m.totalHours)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail Modal */}
      {expandedMetrics && (
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
          onClick={() => setExpandedEmployee(null)}
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
            {/* Modal Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 800, letterSpacing: '-0.012em', color: 'var(--text-primary)' }}>
                  {expandedMetrics.employeeName}
                </h2>
                {expandedMetrics.position && (
                  <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--text-tertiary)' }}>{expandedMetrics.position}</p>
                )}
              </div>
              <button
                onClick={() => setExpandedEmployee(null)}
                className="ionex-report-action"
                aria-label="Close"
              >
                \u2715 Close
              </button>
            </div>

            {/* Headline P&L strip — the arithmetic story of this employee */}
            <div className="ionex-pl-strip">
              <div className="ionex-pl-cell is-primary">
                <span className="ionex-pl-cell-label">Revenue</span>
                <span className="ionex-pl-cell-value">${fmt(expandedMetrics.totalRevenue)}</span>
                {expandedMetrics.expenseBilled > 0 && (
                  <span className="ionex-pl-cell-sub">
                    incl. ${fmt(expandedMetrics.expenseBilled)} expense billout
                  </span>
                )}
              </div>
              <span className="ionex-pl-op">−</span>
              <div className="ionex-pl-cell is-warn">
                <span className="ionex-pl-cell-label">Cost</span>
                <span className="ionex-pl-cell-value">${fmt(expandedMetrics.totalCost)}</span>
                <span className="ionex-pl-cell-sub">
                  labour ${fmt(expandedMetrics.laborCost)}
                  {expandedMetrics.expenseCost > 0 ? ` · expenses $${fmt(expandedMetrics.expenseCost)}` : ''}
                </span>
              </div>
              <span className="ionex-pl-op">=</span>
              <div className={`ionex-pl-cell ${expandedMetrics.netProfit >= 0 ? 'is-positive' : 'is-negative'}`}>
                <span className="ionex-pl-cell-label">Net Profit</span>
                <span className="ionex-pl-cell-value">${fmt(expandedMetrics.netProfit)}</span>
                <span className="ionex-pl-cell-sub">{expandedMetrics.profitMargin.toFixed(1)}% margin</span>
              </div>
              <span />
            </div>

            {/* Secondary stats: utilisation + counts */}
            <div className="ionex-kpi-mini-grid" style={{ marginBottom: '20px' }}>
              <KpiCard
                label="Billable %"
                value={formatPercentage(expandedMetrics.efficiency)}
                accent={expandedMetrics.efficiency >= 80 ? 'var(--success-color)' : expandedMetrics.efficiency >= 60 ? 'var(--warning-color)' : 'var(--error-color)'}
              />
              <KpiCard label="Total Hours" value={formatHoursDecimal(expandedMetrics.totalHours)} accent="var(--text-tertiary)" />
              <KpiCard label="Billable Hours" value={formatHoursDecimal(expandedMetrics.billableHours)} accent="var(--text-secondary)" />
              <KpiCard label="Service Tickets" value={String(expandedMetrics.serviceTicketCount)} accent="var(--text-tertiary)" />
            </div>

            {/* Billable Bar (large) */}
            <div className="ionex-modal-section" style={{ borderTop: 'none', paddingTop: 0 }}>
              <div className="ionex-modal-section-head">
                <span className="ionex-modal-section-title">Billable Utilization</span>
                <span className="ionex-modal-section-meta">
                  <strong>{expandedMetrics.efficiency.toFixed(0)}%</strong> of {formatHoursDecimal(expandedMetrics.totalHours)}h
                </span>
              </div>
              <BillableBar
                pct={expandedMetrics.efficiency}
                billable={expandedMetrics.billableHours}
                billableApproved={expandedMetrics.billableHoursApproved}
                billableAllTickets={expandedMetrics.billableHoursAllTickets}
                total={expandedMetrics.totalHours}
                large
              />
            </div>

            {/* Hours by Rate Type — labour only. Expense margin lives in its own section below
                so this table reads as a clean "where did the hours go" answer. */}
            {(() => {
              const bd = expandedMetrics.rateTypeBreakdown;
              const rows = [
                { label: 'Non-Billable', data: bd.internalTime },
                { label: 'Shop Time',    data: bd.shopTime },
                { label: 'Field Time',   data: bd.fieldTime },
                { label: 'Travel Time',  data: bd.travelTime },
                { label: 'Shop OT',      data: bd.shopOvertime },
                { label: 'Field OT',     data: bd.fieldOvertime },
              ].filter(r => r.data.hours > 0);
              const sumHours        = rows.reduce((s, r) => s + r.data.hours, 0);
              const sumLaborRevenue = rows.reduce((s, r) => s + r.data.revenue, 0);
              const sumLaborCost    = rows.reduce((s, r) => s + r.data.cost, 0);
              const sumLaborProfit  = sumLaborRevenue - sumLaborCost;
              return (
                <div className="ionex-modal-section">
                  <div className="ionex-modal-section-head">
                    <span className="ionex-modal-section-title">Labour breakdown</span>
                    <span className="ionex-modal-section-meta">
                      <strong>{formatHoursDecimal(sumHours)}h</strong> · {formatCurrency(sumLaborRevenue)} billed · {formatCurrency(sumLaborCost)} cost
                    </span>
                  </div>
                  {rows.length === 0 ? (
                    <div className="ionex-mini-empty">No hours logged for this period.</div>
                  ) : (
                    <table className="ionex-compact-table">
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th className="align-right">Hours</th>
                          <th className="align-right">Billed</th>
                          <th className="align-right">Cost</th>
                          <th className="align-right">Margin</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.label} className={row.label === 'Non-Billable' ? 'is-subtle' : undefined}>
                            <td>{row.label}</td>
                            <td className="align-right">{formatHoursDecimal(row.data.hours)}</td>
                            <td className="align-right">
                              <span className={row.label === 'Non-Billable' ? 'ionex-money is-bad' : 'ionex-money'}>
                                {formatCurrency(row.data.revenue)}
                              </span>
                            </td>
                            <td className="align-right">
                              <span className="ionex-money is-muted">{formatCurrency(row.data.cost)}</span>
                            </td>
                            <td className="align-right">
                              <span className={`ionex-money ${row.data.profit >= 0 ? 'is-good' : 'is-bad'}`}>
                                {formatCurrency(row.data.profit)}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td>Labour total</td>
                          <td className="align-right">{formatHoursDecimal(sumHours)}</td>
                          <td className="align-right">{formatCurrency(sumLaborRevenue)}</td>
                          <td className="align-right">{formatCurrency(sumLaborCost)}</td>
                          <td className="align-right">
                            <span className={`ionex-money ${sumLaborProfit >= 0 ? 'is-good' : 'is-bad'}`}>
                              {formatCurrency(sumLaborProfit)}
                            </span>
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  )}
                </div>
              );
            })()}

            {/* Expense Margin — billed vs cost by category, with line-item drilldown. */}
            {((expandedMetrics.expenseBilled || 0) > 0 || expandedMetrics.expenseCost > 0) && (() => {
              const expBilled = expandedMetrics.expenseBilled || 0;
              const expCost   = expandedMetrics.expenseCost;
              const expMargin = expBilled - expCost;
              return (
                <div className="ionex-modal-section">
                  <div className="ionex-modal-section-head">
                    <button
                      type="button"
                      className="ionex-disclosure"
                      aria-expanded={expenseBreakdownExpanded}
                      onClick={() => setExpenseBreakdownExpanded(v => !v)}
                    >
                      <span className="ionex-disclosure-chevron">▶</span>
                      Expense margin
                      <span className="ionex-disclosure-sub">
                        {formatCurrency(expBilled)} billed · {formatCurrency(expCost)} cost ·{' '}
                        <span className={expMargin >= 0 ? 'ionex-money is-good' : 'ionex-money is-bad'}>
                          {formatCurrency(expMargin)} markup
                        </span>
                      </span>
                    </button>
                  </div>
                  {expenseBreakdownExpanded && (expandedMetrics.expenseBreakdown || []).length > 0 && (
                    <table className="ionex-compact-table">
                      <thead>
                        <tr>
                          <th>Category</th>
                          <th className="align-right">Billed</th>
                          <th className="align-right">Cost</th>
                          <th className="align-right">Markup</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(expandedMetrics.expenseBreakdown || []).map((row) => {
                          const hasDrilldown = EXPENSE_BREAKDOWN_DRILLDOWN_CATEGORIES.has(row.category);
                          const drilldownItems = hasDrilldown
                            ? (ticketExpenses as any[]).filter((exp: any) => {
                                const uid = exp.service_tickets?.user_id ?? exp.service_ticket?.user_id;
                                if (uid !== expandedMetrics.userId) return false;
                                return ticketExpenseCategoryForEmployeeReport(exp) === row.category;
                              })
                            : [];
                          const hasItems = drilldownItems.length > 0;
                          const open = expandedExpenseDrilldownKeys.has(row.category);
                          const toggle = () => setExpandedExpenseDrilldownKeys(prev => {
                            const next = new Set(prev);
                            if (next.has(row.category)) next.delete(row.category);
                            else next.add(row.category);
                            return next;
                          });
                          const markup = row.billed - row.cost;
                          return (
                            <Fragment key={row.category}>
                              <tr>
                                <td>
                                  {hasDrilldown && hasItems ? (
                                    <button
                                      type="button"
                                      className="ionex-disclosure"
                                      aria-expanded={open}
                                      onClick={toggle}
                                      style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)' }}
                                    >
                                      <span className="ionex-disclosure-chevron">▶</span>
                                      {row.category}
                                    </button>
                                  ) : (
                                    row.category
                                  )}
                                </td>
                                <td className="align-right">{formatCurrency(row.billed)}</td>
                                <td className="align-right">
                                  <span className={row.cost > 0 ? 'ionex-money is-warn' : 'ionex-money is-muted'}>
                                    {formatCurrency(row.cost)}
                                  </span>
                                </td>
                                <td className="align-right">
                                  <span className={`ionex-money ${markup >= 0 ? 'is-good' : 'is-bad'}`}>
                                    {formatCurrency(markup)}
                                  </span>
                                </td>
                              </tr>
                              {hasDrilldown && hasItems && open && drilldownItems.map((exp: any) => {
                                const amt = (Number(exp.quantity) || 0) * (Number(exp.rate) || 0);
                                const billedShown = maybeApplyGst(amt, includeGst);
                                const ticket = exp.service_tickets ?? exp.service_ticket;
                                const lineCost = ticketExpenseCostForMargin(exp, reimbRateForEmployeeReportExpense(exp, expandedEmpRecord));
                                const ticketLabel = ticket?.ticket_number ? `#${ticket.ticket_number}` : '—';
                                const lineMargin = billedShown - lineCost;
                                return (
                                  <tr key={exp.id} className="is-subtle">
                                    <td style={{ paddingLeft: '34px', fontSize: '12px', color: 'var(--text-tertiary)' }}>
                                      {exp.description || exp.expense_type || 'Expense'}
                                      {ticketLabel !== '—' && (
                                        <span style={{ marginLeft: '6px', fontSize: '11px' }}>({ticketLabel})</span>
                                      )}
                                    </td>
                                    <td className="align-right" style={{ fontSize: '12px' }}>{formatCurrency(billedShown)}</td>
                                    <td className="align-right" style={{ fontSize: '12px' }}>
                                      <span className={lineCost > 0 ? 'ionex-money is-warn' : 'ionex-money is-muted'}>
                                        {formatCurrency(lineCost)}
                                      </span>
                                    </td>
                                    <td className="align-right" style={{ fontSize: '12px' }}>
                                      <span className={`ionex-money ${lineMargin >= 0 ? 'is-good' : 'is-bad'}`}>
                                        {formatCurrency(lineMargin)}
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })()}

            {/* Expenses & Reimbursements — collapsible dropdown, shows ALL expenses (billed + reimbursed) */}
            {(() => {
              const empExpenses = (ticketExpenses as any[]).filter((exp: any) => {
                const uid = exp.service_tickets?.user_id ?? exp.service_ticket?.user_id;
                return uid === expandedMetrics.userId;
              });
              const totalExpAmt = empExpenses.reduce((s: number, e: any) => s + (Number(e.quantity) || 0) * (Number(e.rate) || 0), 0);
              const billed = empExpenses.filter((e: any) => !e.needs_reimbursement);
              const reimbursable = empExpenses.filter((e: any) => e.needs_reimbursement);
              const billedTotal = billed.reduce((s: number, e: any) => s + (Number(e.quantity) || 0) * (Number(e.rate) || 0), 0);
              const reimbTotal = reimbursable.reduce((s: number, e: any) => s + (Number(e.quantity) || 0) * (Number(e.rate) || 0), 0);
              const reimbPaid = reimbursable.filter((e: any) => e.reimbursement_status === 'paid').reduce((s: number, e: any) => s + (Number(e.quantity) || 0) * (Number(e.rate) || 0), 0);
              const reimbApproved = reimbursable.filter((e: any) => e.reimbursement_status === 'approved').reduce((s: number, e: any) => s + (Number(e.quantity) || 0) * (Number(e.rate) || 0), 0);
              const reimbPending = reimbTotal - reimbPaid - reimbApproved;

              const statusBadge = (status: string | null) => {
                const s = (status || 'pending').toLowerCase();
                // Theme-token-driven palette so dark mode adapts.
                const map: Record<string, { color: string; label: string }> = {
                  paid:     { color: 'var(--success-color)', label: 'Paid' },
                  approved: { color: 'var(--primary-color)', label: 'Approved' },
                  rejected: { color: 'var(--error-color)',   label: 'Rejected' },
                  pending:  { color: 'var(--warning-color)', label: 'Pending' },
                };
                const st = map[s] || map.pending;
                return (
                  <span
                    style={{
                      padding: '2px 8px',
                      borderRadius: '999px',
                      fontSize: '11px',
                      fontWeight: 700,
                      backgroundColor: `color-mix(in srgb, ${st.color} 12%, transparent)`,
                      border: `1px solid color-mix(in srgb, ${st.color} 30%, transparent)`,
                      color: st.color,
                    }}
                  >
                    {st.label}
                  </span>
                );
              };

              return (
                <div className="ionex-modal-section">
                  <div className="ionex-modal-section-head">
                    <button
                      type="button"
                      className="ionex-disclosure"
                      aria-expanded={expensesSectionExpanded}
                      onClick={() => setExpensesSectionExpanded(v => !v)}
                    >
                      <span className="ionex-disclosure-chevron">▶</span>
                      Expenses &amp; reimbursements
                      <span className="ionex-disclosure-sub">{empExpenses.length} {empExpenses.length === 1 ? 'line' : 'lines'} · ${fmt(totalExpAmt)}</span>
                    </button>
                  </div>
                  {expensesSectionExpanded && (
                    <div>
                      {empExpenses.length === 0 ? (
                        <div className="ionex-mini-empty">No expenses recorded for this period.</div>
                      ) : (
                        <>
                          <div style={{ display: 'flex', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
                            {billedTotal > 0 && (
                              <span
                                className="ionex-tag"
                                style={{ ['--tag-color' as string]: 'var(--primary-color)' } as React.CSSProperties}
                              >
                                <span className="label">Billed to customer</span>
                                ${fmt(billedTotal)}
                              </span>
                            )}
                            {reimbTotal > 0 && (
                              <>
                                <span
                                  className="ionex-tag"
                                  style={{ ['--tag-color' as string]: 'var(--warning-color)' } as React.CSSProperties}
                                >
                                  <span className="label">Reimbursed to employee</span>
                                  ${fmt(reimbTotal)}
                                </span>
                                {reimbPaid > 0 && (
                                  <span className="ionex-tag" style={{ ['--tag-color' as string]: 'var(--success-color)' } as React.CSSProperties}>
                                    <span className="label">Paid</span>
                                    ${fmt(reimbPaid)}
                                  </span>
                                )}
                                {reimbApproved > 0 && (
                                  <span className="ionex-tag" style={{ ['--tag-color' as string]: 'var(--primary-color)' } as React.CSSProperties}>
                                    <span className="label">Approved</span>
                                    ${fmt(reimbApproved)}
                                  </span>
                                )}
                                {reimbPending > 0 && (
                                  <span className="ionex-tag" style={{ ['--tag-color' as string]: 'var(--warning-color)' } as React.CSSProperties}>
                                    <span className="label">Pending</span>
                                    ${fmt(reimbPending)}
                                  </span>
                                )}
                              </>
                            )}
                          </div>
                          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                              <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                <th style={{ ...detailThStyle, width: '32px' }} />
                                <th style={detailThStyle}>Date</th>
                                <th style={detailThStyle}>Description</th>
                                <th style={detailThStyle}>Ticket</th>
                                <th style={{ ...detailThStyle, textAlign: 'right' }}>Amount</th>
                                <th style={{ ...detailThStyle, textAlign: 'center' }}>Type</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(() => {
                                const sorted = [...empExpenses].sort((a: any, b: any) => {
                                  const da = a.service_tickets?.date || a.service_ticket?.date || '';
                                  const db = b.service_tickets?.date || b.service_ticket?.date || '';
                                  if (da !== db) return db.localeCompare(da);
                                  const ta = (a.service_tickets ?? a.service_ticket)?.ticket_number || '';
                                  const tb = (b.service_tickets ?? b.service_ticket)?.ticket_number || '';
                                  return tb.localeCompare(ta);
                                });
                                // Group by date first
                                const byDate = new Map<string, any[]>();
                                for (const exp of sorted) {
                                  const ticket = exp.service_tickets ?? exp.service_ticket;
                                  const date = ticket?.date || '';
                                  if (!byDate.has(date)) byDate.set(date, []);
                                  byDate.get(date)!.push(exp);
                                }
                                const dateEntries = Array.from(byDate.entries()).sort(([da], [db]) => db.localeCompare(da));

                                const renderExpenseRows = (items: any[], ticketLabel: string, ticket: any, indent = 0) =>
                                  items.map((exp: any) => {
                                    const amt = (Number(exp.quantity) || 0) * (Number(exp.rate) || 0);
                                    return (
                                      <tr key={exp.id} style={{ borderTop: '1px solid var(--border-color)' }}>
                                        <td style={{ width: '32px' }} />
                                        <td style={{ ...detailTdStyle, fontFamily: 'monospace', whiteSpace: 'nowrap', fontSize: '12px', paddingLeft: `${12 + indent}px` }}>{ticket?.date || '—'}</td>
                                        <td style={{ ...detailTdStyle, maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: `${12 + indent}px` }}>
                                          {exp.description || exp.expense_type || 'Expense'}
                                        </td>
                                        <td style={{ ...detailTdStyle, fontSize: '12px', color: 'var(--text-secondary)' }}>{ticketLabel}</td>
                                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: '600' }}>{formatCurrency(amt)}</td>
                                        <td style={{ ...detailTdStyle, textAlign: 'center' }}>
                                          {exp.needs_reimbursement ? statusBadge(exp.reimbursement_status) : <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>Billed</span>}
                                        </td>
                                      </tr>
                                    );
                                  });

                                return dateEntries.map(([date, dateItems]) => {
                                  // Within date, group by ticket
                                  const byTicket = new Map<string, any[]>();
                                  for (const exp of dateItems) {
                                    const ticket = exp.service_tickets ?? exp.service_ticket;
                                    const ticketId = ticket?.id || exp.service_ticket_id || '';
                                    const key = ticketId || 'unknown';
                                    if (!byTicket.has(key)) byTicket.set(key, []);
                                    byTicket.get(key)!.push(exp);
                                  }
                                  const ticketEntries = Array.from(byTicket.entries());
                                  const hasMultipleTickets = ticketEntries.length > 1;
                                  const dateTotal = dateItems.reduce((s, e) => s + (Number(e.quantity) || 0) * (Number(e.rate) || 0), 0);
                                  // Expanded keys: empty set = all collapsed by default
                                  const isDateExpanded = expandedExpenseDateKeys.has(date);

                                  const toggleDate = () => setExpandedExpenseDateKeys(prev => {
                                    const next = new Set(prev);
                                    if (next.has(date)) next.delete(date);
                                    else next.add(date);
                                    return next;
                                  });

                                  const toggleTicket = (ticketKey: string) => setExpandedExpenseTicketKeys(prev => {
                                    const next = new Set(prev);
                                    if (next.has(ticketKey)) next.delete(ticketKey);
                                    else next.add(ticketKey);
                                    return next;
                                  });

                                  return (
                                    <tr key={date}>
                                      <td colSpan={6} style={{ padding: 0, borderBottom: '1px solid var(--border-color)', verticalAlign: 'top' }}>
                                        <div>
                                          <button
                                            type="button"
                                            onClick={toggleDate}
                                            style={{
                                              display: 'flex',
                                              alignItems: 'center',
                                              gap: '8px',
                                              width: '100%',
                                              padding: '10px 12px',
                                              background: 'none',
                                              border: 'none',
                                              cursor: 'pointer',
                                              textAlign: 'left',
                                              fontSize: '13px',
                                              color: 'var(--text-primary)',
                                            }}
                                          >
                                            <span style={{
                                              display: 'inline-block',
                                              fontSize: '10px',
                                              color: 'var(--text-tertiary)',
                                              transition: 'transform 0.2s ease',
                                              transform: isDateExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                                            }}>&#9654;</span>
                                            <span style={{ fontFamily: 'monospace', whiteSpace: 'nowrap', minWidth: '100px' }}>{date || '—'}</span>
                                            <span style={{ color: 'var(--text-secondary)', flex: 1 }}>
                                              {ticketEntries.map(([, items]) => {
                                                const t = items[0]?.service_tickets ?? items[0]?.service_ticket;
                                                return t?.ticket_number || t?.projects?.project_number || t?.projects?.name || '—';
                                              }).join(', ')}
                                            </span>
                                            <span style={{ fontFamily: 'monospace', fontWeight: '600' }}>{formatCurrency(dateTotal)}</span>
                                          </button>
                                          {isDateExpanded && (
                                            <table style={{ width: '100%', borderCollapse: 'collapse', backgroundColor: 'var(--bg-secondary)' }}>
                                              <tbody>
                                                {hasMultipleTickets ? (
                                                  ticketEntries.map(([ticketId, items]) => {
                                                    const first = items[0];
                                                    const ticket = first.service_tickets ?? first.service_ticket;
                                                    const projLabel = ticket?.projects?.project_number ? `${ticket.projects.project_number}` : (ticket?.projects?.name || '');
                                                    const ticketLabel = ticket?.ticket_number || projLabel || '—';
                                                    const ticketKey = `${date}-${ticketId}`;
                                                    const ticketTotal = items.reduce((s, e) => s + (Number(e.quantity) || 0) * (Number(e.rate) || 0), 0);
                                                    const isTicketExpanded = expandedExpenseTicketKeys.has(ticketKey);
                                                    return (
                                                      <tr key={ticketKey}>
                                                        <td colSpan={6} style={{ padding: 0, borderTop: '1px solid var(--border-color)', verticalAlign: 'top' }}>
                                                          <button
                                                            type="button"
                                                            onClick={(e) => { e.stopPropagation(); toggleTicket(ticketKey); }}
                                                            style={{
                                                              display: 'flex',
                                                              alignItems: 'center',
                                                              gap: '8px',
                                                              width: '100%',
                                                              padding: '8px 12px 8px 24px',
                                                              background: 'none',
                                                              border: 'none',
                                                              cursor: 'pointer',
                                                              textAlign: 'left',
                                                              fontSize: '12px',
                                                              color: 'var(--text-secondary)',
                                                            }}
                                                          >
                                                            <span style={{
                                                              display: 'inline-block',
                                                              fontSize: '10px',
                                                              color: 'var(--text-tertiary)',
                                                              transition: 'transform 0.2s ease',
                                                              transform: isTicketExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                                                            }}>&#9654;</span>
                                                            <span style={{ color: 'var(--text-primary)', fontWeight: '500' }}>{ticketLabel}</span>
                                                            <span style={{ fontFamily: 'monospace', fontWeight: '600', marginLeft: 'auto' }}>{formatCurrency(ticketTotal)}</span>
                                                            <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{items.length} item{items.length !== 1 ? 's' : ''}</span>
                                                          </button>
                                                          {isTicketExpanded && (
                                                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                                              <tbody>
                                                                {renderExpenseRows(items, ticketLabel, ticket, 24)}
                                                              </tbody>
                                                            </table>
                                                          )}
                                                        </td>
                                                      </tr>
                                                    );
                                                  })
                                                ) : (
                                                  (() => {
                                                    const firstItem = ticketEntries[0]?.[1]?.[0];
                                                    const t = firstItem?.service_tickets ?? firstItem?.service_ticket;
                                                    const label = t?.ticket_number || t?.projects?.project_number || t?.projects?.name || '—';
                                                    return renderExpenseRows(dateItems, label, t);
                                                  })()
                                                )}
                                              </tbody>
                                            </table>
                                          )}
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                });
                              })()}
                            </tbody>
                            <tfoot>
                              <tr style={{ borderTop: '2px solid var(--border-color)' }}>
                                <td style={{ ...detailTdStyle, fontWeight: '700' }} colSpan={4}>Total</td>
                                <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: '700' }}>{formatCurrency(totalExpAmt)}</td>
                                <td style={detailTdStyle} />
                              </tr>
                            </tfoot>
                          </table>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Top Projects + Top Customers in a 2-col grid when both have data,
                so they share screen real estate instead of stacking forever. */}
            <div className="ionex-flow-two-col" style={{ marginTop: '4px' }}>
              <div className="ionex-modal-section" style={{ borderTop: 'none', paddingTop: 14 }}>
                <div className="ionex-modal-section-head">
                  <span className="ionex-modal-section-title">Top projects</span>
                  <span className="ionex-modal-section-meta">
                    <strong>{expandedMetrics.projectBreakdown.length}</strong>
                    {expandedMetrics.projectBreakdown.length > 10 ? ' \u00b7 top 10 shown' : ''}
                  </span>
                </div>
                {expandedMetrics.projectBreakdown.length === 0 ? (
                  <div className="ionex-mini-empty">No project data.</div>
                ) : (
                  <table className="ionex-compact-table">
                    <thead>
                      <tr>
                        <th>Project</th>
                        <th className="align-right">Hours</th>
                        <th className="align-right">Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {expandedMetrics.projectBreakdown.slice(0, 10).map((proj: any) => (
                        <tr key={proj.projectId}>
                          <td>{proj.projectName}</td>
                          <td className="align-right">{formatHoursDecimal(proj.hours)}</td>
                          <td className="align-right">
                            <span className="ionex-money">{formatCurrency(proj.revenue)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="ionex-modal-section" style={{ borderTop: 'none', paddingTop: 14 }}>
                <div className="ionex-modal-section-head">
                  <span className="ionex-modal-section-title">Top customers</span>
                  <span className="ionex-modal-section-meta">
                    <strong>{expandedMetrics.customerBreakdown.length}</strong>
                    {expandedMetrics.customerBreakdown.length > 10 ? ' \u00b7 top 10 shown' : ''}
                  </span>
                </div>
                {expandedMetrics.customerBreakdown.length === 0 ? (
                  <div className="ionex-mini-empty">No customer data.</div>
                ) : (
                  <table className="ionex-compact-table">
                    <thead>
                      <tr>
                        <th>Customer</th>
                        <th className="align-right">Hours</th>
                        <th className="align-right">Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {expandedMetrics.customerBreakdown.slice(0, 10).map((cust: any) => (
                        <tr key={cust.customerId}>
                          <td>{cust.customerName}</td>
                          <td className="align-right">{formatHoursDecimal(cust.hours)}</td>
                          <td className="align-right">
                            <span className="ionex-money">{formatCurrency(cust.revenue)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BillableBar({
  pct,
  billable,
  billableApproved = billable,
  billableAllTickets = billable,
  total,
  large,
}: {
  pct: number;
  billable: number;
  billableApproved?: number;
  billableAllTickets?: number;
  total: number;
  large?: boolean;
}) {
  const clampedPct = Math.min(Math.max(pct, 0), 100);
  // Tiered semantic color picks up the CSS variable so it themes correctly in dark mode.
  const accentVar = pct >= 80 ? 'var(--success-color)' : pct >= 60 ? 'var(--warning-color)' : 'var(--error-color)';

  const approvedPct = total > 0 ? (billableApproved / total) * 100 : 0;
  const pendingPct = total > 0 ? (Math.max(0, billableAllTickets - billableApproved) / total) * 100 : 0;

  return (
    <div>
      <div
        className={`ionex-progress${large ? ' is-large' : ''}`}
        style={{ ['--progress-color' as string]: accentVar } as React.CSSProperties}
      >
        {approvedPct > 0 && (
          <div
            title="Approved: hours from approved/exported tickets (contributing to revenue)"
            className="ionex-progress-segment is-primary"
            style={{ width: `${approvedPct}%` }}
          />
        )}
        {pendingPct > 0 && (
          <div
            title="Pending: hours on draft, submitted, or rejected tickets (not yet contributing to revenue)"
            className="ionex-progress-segment is-pending"
            style={{ width: `${pendingPct}%` }}
          />
        )}
        {large && (
          <div
            className="ionex-progress-label"
            style={{
              color: clampedPct > 50 ? '#fff' : 'var(--text-primary)',
              textShadow: clampedPct > 50 ? '0 1px 2px rgba(0,0,0,0.3)' : 'none',
            }}
          >
            {clampedPct.toFixed(0)}%
          </div>
        )}
      </div>
      <div className="ionex-progress-caption">
        <span>{billable.toFixed(1)}h billable</span>
        <span>{total.toFixed(1)}h total</span>
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
