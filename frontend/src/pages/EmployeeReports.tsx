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
} from '../utils/employeeReports';
import {
  exportEmployeeReportsToExcel,
  exportEmployeeReportsToPDF,
} from '../utils/exportEmployeeReports';

const formatHoursDecimal = (hours: number): string => hours.toFixed(2);

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
  const [otherPartsExpanded, setOtherPartsExpanded] = useState(false);
  useEffect(() => {
    if (expandedEmployee) {
      setExpensesSectionExpanded(true);
      setExpandedExpenseDateKeys(new Set());
      setExpandedExpenseTicketKeys(new Set());
      setExpenseBreakdownExpanded(false);
      setOtherPartsExpanded(false);
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
        netProfit: acc.netProfit + m.netProfit,
        serviceTicketCount: acc.serviceTicketCount + m.serviceTicketCount,
      }),
      { billableHours: 0, nonBillableHours: 0, totalRevenue: 0, totalCost: 0, netProfit: 0, serviceTicketCount: 0 }
    );
    return { ...result, totalHours: result.billableHours + result.nonBillableHours };
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
    <div style={{ padding: '30px', maxWidth: '1400px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <h1 style={{ fontSize: '28px', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>
            Employee Reports
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginTop: '4px' }}>
            Performance and profitability by employee
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button
            className="button button-secondary"
            style={{ padding: '8px 16px', fontSize: '13px' }}
            onClick={() => exportEmployeeReportsToPDF(sortedMetrics, totals, selectedPeriod, `employee-reports-${startDate}-${endDate}`)}
            disabled={isLoading || sortedMetrics.length === 0}
          >
            Export PDF
          </button>
          <button
            className="button button-secondary"
            style={{ padding: '8px 16px', fontSize: '13px' }}
            onClick={() => exportEmployeeReportsToExcel(sortedMetrics, totals, selectedPeriod, `employee-reports-${startDate}-${endDate}`)}
            disabled={isLoading || sortedMetrics.length === 0}
          >
            Export Excel
          </button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <label style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Period:</label>
          <select
            value={selectedPeriod}
            onChange={(e) => {
              setSelectedPeriod(e.target.value);
              if (e.target.value !== 'Custom Range') {
                setCustomStartDate('');
                setCustomEndDate('');
              }
            }}
            style={selectStyle}
          >
            {periodPresets.map(preset => (
              <option key={preset.label} value={preset.label}>{preset.label}</option>
            ))}
          </select>
          {selectedPeriod === 'Custom Range' && (
            <>
              <label style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>From:</label>
              <input type="date" value={customStartDate} onChange={(e) => setCustomStartDate(e.target.value)} style={selectStyle} />
              <label style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>To:</label>
              <input type="date" value={customEndDate} onChange={(e) => setCustomEndDate(e.target.value)} min={customStartDate} style={selectStyle} />
            </>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Dept:</label>
          <select value={selectedDepartment} onChange={(e) => setSelectedDepartment(e.target.value)} style={selectStyle}>
            <option value="all">All</option>
            {departments.map((dept) => <option key={dept} value={dept}>{dept}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Employee:</label>
          <select value={selectedEmployeeId} onChange={(e) => setSelectedEmployeeId(e.target.value)} style={selectStyle}>
            <option value="all">All Employees</option>
            {employees?.map((emp: any) => (
              <option key={emp.user_id} value={emp.user_id}>{emp.user?.first_name} {emp.user?.last_name}</option>
            ))}
          </select>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: 'var(--text-secondary)' }}>
          <input
            type="checkbox"
            checked={includeGst}
            onChange={(e) => setIncludeGst(e.target.checked)}
            style={{ width: '16px', height: '16px', accentColor: 'var(--primary-color)' }}
          />
          Include GST (5%) on billable amounts
        </label>
      </div>

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '28px' }}>
        {[
          { label: 'Total Hours', value: formatHoursDecimal(totals.totalHours), color: '#9c27b0' },
          { label: 'Billable Hours', value: formatHoursDecimal(totals.billableHours), color: '#2196F3' },
          { label: 'Avg Billable %', value: `${billablePct.toFixed(1)}%`, color: billablePct >= 80 ? '#4caf50' : billablePct >= 60 ? '#ff9800' : '#e53935' },
          { label: 'Revenue', value: `$${fmt(totals.totalRevenue)}`, color: '#4caf50' },
          { label: 'Total Cost', value: `$${fmt(totals.totalCost)}`, color: '#ff9800' },
          { label: 'Net Profit', value: `$${fmt(totals.netProfit)}`, color: totals.netProfit >= 0 ? '#4caf50' : '#e53935' },
          { label: 'Profit Margin', value: `${profitMargin.toFixed(1)}%`, color: profitMargin >= 20 ? '#4caf50' : profitMargin >= 0 ? '#ff9800' : '#e53935' },
          { label: 'Service Tickets', value: String(totals.serviceTicketCount), color: '#607d8b' },
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

      {/* Loading */}
      {isLoading && (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
          Loading employee data...
        </div>
      )}

      {/* Employee Table */}
      {!isLoading && (
        <div style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '12px', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
                <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => handleSort('employeeName')}>Employee{sortArrow('employeeName')}</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>Billable %</th>
                <th style={{ ...thStyle, textAlign: 'right', cursor: 'pointer' }} onClick={() => handleSort('totalRevenue')}>Revenue{sortArrow('totalRevenue')}</th>
                <th style={{ ...thStyle, textAlign: 'right', cursor: 'pointer' }} onClick={() => handleSort('totalCost')}>Cost{sortArrow('totalCost')}</th>
                <th style={{ ...thStyle, textAlign: 'right', cursor: 'pointer' }} onClick={() => handleSort('netProfit')}>Profit{sortArrow('netProfit')}</th>
                <th style={{ ...thStyle, textAlign: 'right', cursor: 'pointer' }} onClick={() => handleSort('profitMargin')}>Margin{sortArrow('profitMargin')}</th>
                <th style={{ ...thStyle, textAlign: 'right', cursor: 'pointer' }} onClick={() => handleSort('serviceTicketCount')}>Tickets{sortArrow('serviceTicketCount')}</th>
                <th style={{ ...thStyle, textAlign: 'right', cursor: 'pointer' }} onClick={() => handleSort('totalHours')}>Hours{sortArrow('totalHours')}</th>
              </tr>
            </thead>
            <tbody>
              {sortedMetrics.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: '40px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
                    No employee data for this period
                  </td>
                </tr>
              ) : (
                sortedMetrics.map((m) => {
                  const eff = m.efficiency;
                  return (
                    <tr
                      key={m.userId}
                      onClick={() => setExpandedEmployee(expandedEmployee === m.userId ? null : m.userId)}
                      style={{
                        borderBottom: '1px solid var(--border-color)',
                        cursor: 'pointer',
                        backgroundColor: expandedEmployee === m.userId ? 'var(--bg-secondary)' : 'transparent',
                        transition: 'background-color 0.15s',
                      }}
                      onMouseEnter={(e) => { if (expandedEmployee !== m.userId) e.currentTarget.style.backgroundColor = 'var(--bg-secondary)'; }}
                      onMouseLeave={(e) => { if (expandedEmployee !== m.userId) e.currentTarget.style.backgroundColor = 'transparent'; }}
                    >
                      <td style={tdStyle}>
                        <div style={{ fontWeight: '600', fontSize: '13px', color: 'var(--text-primary)' }}>
                          {m.employeeName}
                        </div>
                        {m.position && (
                          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{m.position}</div>
                        )}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'center', minWidth: '160px' }}>
                        <BillableBar
                          pct={eff}
                          billable={m.billableHours}
                          billableApproved={m.billableHoursApproved}
                          billableAllTickets={m.billableHoursAllTickets}
                          total={m.totalHours}
                        />
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: '600' }}>
                        ${fmt(m.totalRevenue)}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                        ${fmt(m.totalCost)}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: '600', color: m.netProfit >= 0 ? '#4caf50' : '#e53935' }}>
                        ${fmt(m.netProfit)}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        <span style={{
                          padding: '3px 8px',
                          borderRadius: '12px',
                          fontSize: '12px',
                          fontWeight: '600',
                          backgroundColor: m.profitMargin >= 20 ? 'rgba(76,175,80,0.12)' : m.profitMargin >= 0 ? 'rgba(255,152,0,0.12)' : 'rgba(229,57,53,0.12)',
                          color: m.profitMargin >= 20 ? '#4caf50' : m.profitMargin >= 0 ? '#ff9800' : '#e53935',
                        }}>
                          {m.profitMargin.toFixed(1)}%
                        </span>
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                        {m.serviceTicketCount}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
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
          onClick={() => setExpandedEmployee(null)}
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
            {/* Modal Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '28px' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '22px', color: 'var(--text-primary)' }}>
                  {expandedMetrics.employeeName}
                </h2>
                {expandedMetrics.position && (
                  <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--text-tertiary)' }}>{expandedMetrics.position}</p>
                )}
              </div>
              <button
                onClick={() => setExpandedEmployee(null)}
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
              <KpiCard label="Revenue" value={`$${fmt(expandedMetrics.totalRevenue)}`} color="#2196F3" />
              <KpiCard label="Labor Cost" value={`$${fmt(expandedMetrics.laborCost)}`} color="#ff9800" />
              {expandedMetrics.expenseCost > 0 && (
                <KpiCard label="Expenses" value={`$${fmt(expandedMetrics.expenseCost)}`} color="#e91e63" />
              )}
              <KpiCard label="Total Cost" value={`$${fmt(expandedMetrics.totalCost)}`} color="#ff9800" />
              <KpiCard label="Profit" value={`$${fmt(expandedMetrics.netProfit)}`} color={expandedMetrics.netProfit >= 0 ? '#4caf50' : '#e53935'} />
              <KpiCard label="Margin" value={`${expandedMetrics.profitMargin.toFixed(1)}%`} color={expandedMetrics.profitMargin >= 20 ? '#4caf50' : expandedMetrics.profitMargin >= 0 ? '#ff9800' : '#e53935'} />
              <KpiCard label="Billable %" value={formatPercentage(expandedMetrics.efficiency)} color={expandedMetrics.efficiency >= 80 ? '#4caf50' : expandedMetrics.efficiency >= 60 ? '#ff9800' : '#e53935'} />
              <KpiCard label="Hours" value={formatHoursDecimal(expandedMetrics.totalHours)} color="#9c27b0" />
            </div>

            {/* Billable Bar (large) */}
            <div style={{ marginBottom: '28px' }}>
              <div style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Billable Utilization
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

            {/* Hours by Rate Type */}
            <DetailSection title="Hours by Rate Type">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <th style={detailThStyle}>Type</th>
                    <th style={{ ...detailThStyle, textAlign: 'right' }}>Hours</th>
                    <th style={{ ...detailThStyle, textAlign: 'right' }}>Billed</th>
                    <th style={{ ...detailThStyle, textAlign: 'right' }}>Cost</th>
                    <th style={{ ...detailThStyle, textAlign: 'right' }}>Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: 'Non-Billable', data: expandedMetrics.rateTypeBreakdown.internalTime },
                    { label: 'Shop Time', data: expandedMetrics.rateTypeBreakdown.shopTime },
                    { label: 'Field Time', data: expandedMetrics.rateTypeBreakdown.fieldTime },
                    { label: 'Travel Time', data: expandedMetrics.rateTypeBreakdown.travelTime },
                    { label: 'Shop OT', data: expandedMetrics.rateTypeBreakdown.shopOvertime },
                    { label: 'Field OT', data: expandedMetrics.rateTypeBreakdown.fieldOvertime },
                  ]
                    .filter(row => row.data.hours > 0)
                    .map((row) => (
                      <tr key={row.label} style={{ borderBottom: '1px solid var(--border-color)' }}>
                        <td style={detailTdStyle}>{row.label}</td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace' }}>{formatHoursDecimal(row.data.hours)}</td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', color: row.label === 'Non-Billable' ? '#e53935' : undefined }}>
                          {formatCurrency(row.data.revenue)}
                        </td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace' }}>{formatCurrency(row.data.cost)}</td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', color: row.data.profit >= 0 ? '#4caf50' : '#e53935' }}>
                          {formatCurrency(row.data.profit)}
                        </td>
                      </tr>
                    ))}
                </tbody>
                <tfoot>
                  {(() => {
                    const bd = expandedMetrics.rateTypeBreakdown;
                    const visibleRows = [bd.internalTime, bd.shopTime, bd.fieldTime, bd.travelTime, bd.shopOvertime, bd.fieldOvertime].filter(r => r.hours > 0);
                    const sumHours = visibleRows.reduce((s, r) => s + r.hours, 0);
                    const sumLaborRevenue = visibleRows.reduce((s, r) => s + r.revenue, 0);
                    const sumCost = visibleRows.reduce((s, r) => s + r.cost, 0) + expandedMetrics.expenseCost;
                    const sumRevenueTotal = sumLaborRevenue + (expandedMetrics.expenseBilled || 0);
                    const sumProfit = sumRevenueTotal - sumCost;
                    const expenseMargin = (expandedMetrics.expenseBilled || 0) - expandedMetrics.expenseCost;
                    const hasExpenses = (expandedMetrics.expenseBilled || 0) > 0 || expandedMetrics.expenseCost > 0;
                    return (
                      <>
                        {hasExpenses && (
                          <>
                            <tr style={{ borderTop: '1px solid var(--border-color)' }}>
                              <td style={{ ...detailTdStyle, fontWeight: '600', color: '#e91e63', verticalAlign: 'top' }}>
                                <button
                                  type="button"
                                  onClick={() => setExpenseBreakdownExpanded(v => !v)}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    padding: 0,
                                    fontSize: 'inherit',
                                    fontWeight: 'inherit',
                                    color: 'inherit',
                                  }}
                                >
                                  <span style={{
                                    display: 'inline-block',
                                    fontSize: '10px',
                                    color: 'var(--text-tertiary)',
                                    transition: 'transform 0.2s ease',
                                    transform: expenseBreakdownExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                                  }}>&#9654;</span>
                                  Expenses
                                </button>
                              </td>
                              <td style={detailTdStyle} />
                              <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: '600' }}>
                                {formatCurrency(expandedMetrics.expenseBilled || 0)}
                              </td>
                              <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: '600', color: '#e91e63' }}>
                                {formatCurrency(expandedMetrics.expenseCost)}
                              </td>
                              <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', color: expenseMargin >= 0 ? '#4caf50' : '#e53935' }}>
                                {formatCurrency(expenseMargin)}
                              </td>
                            </tr>
                            {expenseBreakdownExpanded && (expandedMetrics.expenseBreakdown || []).length > 0 && (
                              (expandedMetrics.expenseBreakdown || []).map((row) => {
                                const isOtherParts = row.category === 'Other/Parts';
                                const otherPartsItems = isOtherParts ? (ticketExpenses as any[]).filter((exp: any) => {
                                  const uid = exp.service_tickets?.user_id ?? exp.service_ticket?.user_id;
                                  if (uid !== expandedMetrics.userId) return false;
                                  const expType = (exp.expense_type || '').toLowerCase();
                                  const desc = (exp.description || '').toLowerCase();
                                  if (expType === 'subsistence' && desc.includes('per diem')) return false;
                                  if (expType === 'travel') return false;
                                  if (expType === 'hotel' || desc.includes('hotel')) return false;
                                  if (!exp.needs_reimbursement) return false;
                                  return true;
                                }) : [];
                                const hasOtherPartsItems = otherPartsItems.length > 0;
                                return (
                                  <Fragment key={row.category}>
                                    <tr style={{ borderTop: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
                                      <td style={{ ...detailTdStyle, paddingLeft: '28px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                                        {isOtherParts && hasOtherPartsItems ? (
                                          <button
                                            type="button"
                                            onClick={() => setOtherPartsExpanded(v => !v)}
                                            style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 'inherit', color: 'inherit' }}
                                          >
                                            <span style={{
                                              display: 'inline-block',
                                              fontSize: '10px',
                                              color: 'var(--text-tertiary)',
                                              transition: 'transform 0.2s ease',
                                              transform: otherPartsExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                                            }}>&#9654;</span>
                                            {row.category}
                                          </button>
                                        ) : (
                                          row.category
                                        )}
                                      </td>
                                      <td style={detailTdStyle} />
                                      <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', fontSize: '13px' }}>{formatCurrency(row.billed)}</td>
                                      <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', fontSize: '13px', color: row.cost > 0 ? '#e91e63' : undefined }}>{formatCurrency(row.cost)}</td>
                                      <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', fontSize: '13px', color: (row.billed - row.cost) >= 0 ? '#4caf50' : '#e53935' }}>{formatCurrency(row.billed - row.cost)}</td>
                                    </tr>
                                    {isOtherParts && hasOtherPartsItems && otherPartsExpanded && otherPartsItems.map((exp: any) => {
                                      const amt = (Number(exp.quantity) || 0) * (Number(exp.rate) || 0);
                                      const ticket = exp.service_tickets ?? exp.service_ticket;
                                      const lineCost = exp.needs_reimbursement ? amt : 0;
                                      const ticketLabel = ticket?.ticket_number ? `#${ticket.ticket_number}` : '—';
                                      return (
                                        <tr key={exp.id} style={{ borderTop: '1px solid var(--border-color)', backgroundColor: 'var(--bg-tertiary)' }}>
                                          <td style={{ ...detailTdStyle, paddingLeft: '44px', fontSize: '12px', color: 'var(--text-tertiary)' }}>
                                            {exp.description || exp.expense_type || 'Expense'}
                                            {ticketLabel !== '—' && <span style={{ marginLeft: '6px', color: 'var(--text-tertiary)', fontSize: '11px' }}>({ticketLabel})</span>}
                                          </td>
                                          <td style={detailTdStyle} />
                                          <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', fontSize: '12px' }}>{formatCurrency(amt)}</td>
                                          <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', fontSize: '12px', color: lineCost > 0 ? '#e91e63' : undefined }}>{formatCurrency(lineCost)}</td>
                                          <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', fontSize: '12px', color: (amt - lineCost) >= 0 ? '#4caf50' : '#e53935' }}>{formatCurrency(amt - lineCost)}</td>
                                        </tr>
                                      );
                                    })}
                                  </Fragment>
                                );
                              })
                            )}
                          </>
                        )}
                        <tr style={{ borderTop: '2px solid var(--border-color)' }}>
                          <td style={{ ...detailTdStyle, fontWeight: '700' }}>Total</td>
                          <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: '700' }}>
                            {formatHoursDecimal(sumHours)}
                          </td>
                          <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: '700' }}>
                            {formatCurrency(sumRevenueTotal)}
                          </td>
                          <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: '700' }}>
                            {formatCurrency(sumCost)}
                          </td>
                          <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: '700', color: sumProfit >= 0 ? '#4caf50' : '#e53935' }}>
                            {formatCurrency(sumProfit)}
                          </td>
                        </tr>
                      </>
                    );
                  })()}
                </tfoot>
              </table>
            </DetailSection>

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
                const styles: Record<string, { bg: string; color: string; label: string }> = {
                  paid: { bg: 'rgba(76,175,80,0.12)', color: '#4caf50', label: 'Paid' },
                  approved: { bg: 'rgba(33,150,243,0.12)', color: '#2196F3', label: 'Approved' },
                  rejected: { bg: 'rgba(229,57,53,0.12)', color: '#e53935', label: 'Rejected' },
                  pending: { bg: 'rgba(255,152,0,0.12)', color: '#ff9800', label: 'Pending' },
                };
                const st = styles[s] || styles.pending;
                return (
                  <span style={{ padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: '600', backgroundColor: st.bg, color: st.color }}>{st.label}</span>
                );
              };

              return (
                <div style={{ marginBottom: '24px' }}>
                  <button
                    type="button"
                    onClick={() => setExpensesSectionExpanded((v) => !v)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      width: '100%',
                      padding: '0 0 12px 0',
                      background: 'none',
                      border: 'none',
                      borderBottom: '1px solid var(--border-color)',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{
                      display: 'inline-block',
                      fontSize: '10px',
                      color: 'var(--text-tertiary)',
                      transition: 'transform 0.2s ease',
                      transform: expensesSectionExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                    }}>&#9654;</span>
                    <h3 style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-primary)', margin: 0 }}>
                      Expenses & Reimbursements — ${fmt(totalExpAmt)}
                    </h3>
                  </button>
                  {expensesSectionExpanded && (
                    <div style={{ marginTop: '12px' }}>
                      {empExpenses.length === 0 ? (
                        <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>No expenses recorded</p>
                      ) : (
                        <>
                          <div style={{ display: 'flex', gap: '16px', marginBottom: '12px', flexWrap: 'wrap', fontSize: '12px', color: 'var(--text-secondary)' }}>
                            {billedTotal > 0 && (
                              <span>Billed to customer: <strong style={{ color: 'var(--text-primary)' }}>${fmt(billedTotal)}</strong></span>
                            )}
                            {reimbTotal > 0 && (
                              <>
                                <span>Reimbursed to employee: <strong style={{ color: '#e91e63' }}>${fmt(reimbTotal)}</strong></span>
                                {reimbPaid > 0 && <span style={{ color: '#4caf50' }}>Paid: ${fmt(reimbPaid)}</span>}
                                {reimbApproved > 0 && <span style={{ color: '#2196F3' }}>Approved: ${fmt(reimbApproved)}</span>}
                                {reimbPending > 0 && <span style={{ color: '#ff9800' }}>Pending: ${fmt(reimbPending)}</span>}
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

            {/* Top Projects */}
            <DetailSection title={`Top Projects \u2014 ${expandedMetrics.projectBreakdown.length}`}>
              {expandedMetrics.projectBreakdown.length === 0 ? (
                <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>No project data</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <th style={detailThStyle}>Project</th>
                      <th style={{ ...detailThStyle, textAlign: 'right' }}>Hours</th>
                      <th style={{ ...detailThStyle, textAlign: 'right' }}>Revenue</th>
                      <th style={{ ...detailThStyle, textAlign: 'right' }}>Expenses Billed</th>
                      <th style={{ ...detailThStyle, textAlign: 'right' }}>Expense Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expandedMetrics.projectBreakdown.slice(0, 10).map((proj: any) => (
                      <tr key={proj.projectId} style={{ borderBottom: '1px solid var(--border-color)' }}>
                        <td style={detailTdStyle}>{proj.projectName}</td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace' }}>{formatHoursDecimal(proj.hours)}</td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace' }}>{formatCurrency(proj.revenue)}</td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace' }}>{formatCurrency(proj.expenseBilled ?? 0)}</td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace', color: (proj.expenseCost ?? 0) > 0 ? '#e91e63' : undefined }}>{formatCurrency(proj.expenseCost ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </DetailSection>

            {/* Top Customers */}
            <DetailSection title={`Top Customers \u2014 ${expandedMetrics.customerBreakdown.length}`}>
              {expandedMetrics.customerBreakdown.length === 0 ? (
                <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>No customer data</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <th style={detailThStyle}>Customer</th>
                      <th style={{ ...detailThStyle, textAlign: 'right' }}>Hours</th>
                      <th style={{ ...detailThStyle, textAlign: 'right' }}>Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expandedMetrics.customerBreakdown.slice(0, 10).map((cust: any) => (
                      <tr key={cust.customerId} style={{ borderBottom: '1px solid var(--border-color)' }}>
                        <td style={detailTdStyle}>{cust.customerName}</td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace' }}>{formatHoursDecimal(cust.hours)}</td>
                        <td style={{ ...detailTdStyle, textAlign: 'right', fontFamily: 'monospace' }}>{formatCurrency(cust.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </DetailSection>
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
  const height = large ? 24 : 16;
  const clampedPct = Math.min(Math.max(pct, 0), 100);
  const barColor = pct >= 80 ? '#4caf50' : pct >= 60 ? '#ff9800' : '#e53935';

  // Three segments: approved (colored), pending draft/submitted/rejected (greyed), non-billable (light grey)
  const approvedPct = total > 0 ? (billableApproved / total) * 100 : 0;
  const pendingPct = total > 0 ? (Math.max(0, billableAllTickets - billableApproved) / total) * 100 : 0;
  const nonBillablePct = total > 0 ? ((total - billableAllTickets) / total) * 100 : 0;

  return (
    <div>
      <div
        style={{
          position: 'relative',
          height,
          borderRadius: height / 2,
          backgroundColor: 'rgba(158,158,158,0.15)',
          overflow: 'hidden',
          display: 'flex',
        }}
      >
        {/* Approved (revenue-contributing) */}
        {approvedPct > 0 && (
          <div
            title="Approved: hours from approved/exported tickets (contributing to revenue)"
            style={{
              width: `${approvedPct}%`,
              height: '100%',
              borderTopLeftRadius: height / 2,
              borderBottomLeftRadius: height / 2,
              borderTopRightRadius: pendingPct <= 0 ? height / 2 : 0,
              borderBottomRightRadius: pendingPct <= 0 ? height / 2 : 0,
              background: `repeating-linear-gradient(
                -45deg,
                ${barColor},
                ${barColor} 6px,
                ${adjustAlpha(barColor, 0.6)} 6px,
                ${adjustAlpha(barColor, 0.6)} 12px
              )`,
              transition: 'width 0.4s ease',
              flexShrink: 0,
            }}
          />
        )}
        {/* Pending (draft/submitted/rejected) */}
        {pendingPct > 0 && (
          <div
            title="Pending: hours on draft, submitted, or rejected tickets (not yet contributing to revenue)"
            style={{
              width: `${pendingPct}%`,
              height: '100%',
              background: `repeating-linear-gradient(
                -45deg,
                rgba(158,158,158,0.5),
                rgba(158,158,158,0.5) 6px,
                rgba(158,158,158,0.3) 6px,
                rgba(158,158,158,0.3) 12px
              )`,
              flexShrink: 0,
              borderTopRightRadius: nonBillablePct <= 0 ? height / 2 : 0,
              borderBottomRightRadius: nonBillablePct <= 0 ? height / 2 : 0,
            }}
          />
        )}
        {/* Non-billable (remaining) */}
        {nonBillablePct > 0 && (
          <div
            title="Non-billable: internal time and unbilled work"
            style={{
              width: `${nonBillablePct}%`,
              height: '100%',
              backgroundColor: 'rgba(158,158,158,0.15)',
              flexShrink: 0,
              borderTopRightRadius: height / 2,
              borderBottomRightRadius: height / 2,
            }}
          />
        )}
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
              color: clampedPct > 50 ? '#fff' : 'var(--text-primary)',
              textShadow: clampedPct > 50 ? '0 1px 2px rgba(0,0,0,0.3)' : 'none',
              pointerEvents: 'none',
            }}
          >
            {clampedPct.toFixed(0)}%
          </div>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '3px' }}>
        <span style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>
          {billable.toFixed(1)}h billable
        </span>
        <span style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>
          {total.toFixed(1)}h total
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

const selectStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: '8px',
  border: '1px solid var(--border-color)',
  backgroundColor: 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  fontSize: '13px',
  cursor: 'pointer',
};

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
