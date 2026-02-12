import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { reportsService } from '../services/supabaseServices';
import {
  aggregateAllEmployees,
  aggregateEmployeeMetrics,
  getTimePeriodPresets,
  formatCurrency,
  formatHours,
  formatPercentage,
  EmployeeMetrics,
} from '../utils/employeeReports';
import {
  exportEmployeeReportsToExcel,
  exportEmployeeReportsToPDF,
} from '../utils/exportEmployeeReports';

type ViewMode = 'table' | 'cards';

// Format hours as decimal (e.g., 8.25 instead of 8:15)
const formatHoursDecimal = (hours: number): string => {
  return hours.toFixed(2);
};

export default function EmployeeReports() {
  const { user, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [selectedPeriod, setSelectedPeriod] = useState('All-Time');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('all');
  const [selectedDepartment, setSelectedDepartment] = useState<string>('all');
  const [expandedEmployee, setExpandedEmployee] = useState<string | null>(null);
  const [sortField, setSortField] = useState<keyof EmployeeMetrics>('totalHours');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');

  // Get time period dates
  const periodPresets = getTimePeriodPresets();
  const currentPeriod = periodPresets.find(p => p.label === selectedPeriod) || periodPresets[0];
  
  // Use custom dates if Custom Range is selected, otherwise use preset
  const getDateRange = () => {
    if (selectedPeriod === 'Custom Range') {
      if (customStartDate && customEndDate) {
        return { startDate: customStartDate, endDate: customEndDate };
      }
      // Default to current month if custom dates not set
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

  // Fetch employees with rates
  const { data: employees, isLoading: loadingEmployees, error: employeesError } = useQuery({
    queryKey: ['employeesWithRates'],
    queryFn: () => reportsService.getEmployeesWithRates(),
    enabled: isAdmin,
  });

  // Fetch time entries for the period
  const { data: timeEntries, isLoading: loadingEntries, error: entriesError } = useQuery({
    queryKey: ['employeeAnalytics', startDate, endDate, selectedEmployeeId],
    queryFn: async () => {
      console.log('Query function called for time entries:', { startDate, endDate, selectedEmployeeId });
      try {
        const result = await reportsService.getEmployeeAnalytics(
          startDate,
          endDate,
          selectedEmployeeId !== 'all' ? selectedEmployeeId : undefined
        );
        console.log('Query function result:', result);
        return result;
      } catch (error) {
        console.error('Query function error:', error);
        throw error;
      }
    },
    enabled: isAdmin && !!startDate && !!endDate,
    retry: 1,
  });

  // Fetch service ticket hours for revenue calculation
  const { data: serviceTicketHours, isLoading: loadingTicketHours } = useQuery({
    queryKey: ['serviceTicketHours', startDate, endDate, selectedEmployeeId],
    queryFn: async () => {
      console.log('Query function called for service ticket hours:', { startDate, endDate, selectedEmployeeId });
      try {
        const result = await reportsService.getServiceTicketHours(
          startDate,
          endDate,
          selectedEmployeeId !== 'all' ? selectedEmployeeId : undefined
        );
        console.log('Service ticket hours result:', result);
        return result;
      } catch (error) {
        console.error('Query function error for service tickets:', error);
        throw error;
      }
    },
    enabled: isAdmin && !!startDate && !!endDate,
    retry: 1,
  });

  // Debug logging
  useMemo(() => {
    console.log('=== Employee Reports Debug ===');
    console.log('Date Range:', { startDate, endDate });
    console.log('Employees:', {
      data: employees,
      count: employees?.length || 0,
      loading: loadingEmployees,
      error: employeesError
    });
    console.log('Time Entries:', {
      data: timeEntries,
      count: timeEntries?.length || 0,
      loading: loadingEntries,
      error: entriesError
    });
    if (employees && employees.length > 0) {
      console.log('Sample Employee:', employees[0]);
      console.log('Employee user_ids:', employees.map((e: any) => e.user_id));
      console.log('Employee user object:', employees[0]?.user);
    }
    if (timeEntries && timeEntries.length > 0) {
      console.log('Sample Time Entry:', timeEntries[0]);
      console.log('Time Entry user_ids:', timeEntries.map((e: any) => e.user_id));
      console.log('Time Entry user object:', timeEntries[0]?.user);
      console.log('Time Entry dates:', timeEntries.map((e: any) => e.date));
    } else if (!loadingEntries && timeEntries !== undefined) {
      console.log('No time entries found for date range:', { startDate, endDate });
    }
  }, [employees, timeEntries, loadingEmployees, loadingEntries, employeesError, entriesError, startDate, endDate]);

  // Aggregate employee metrics
  const employeeMetrics = useMemo(() => {
    // Show employees even if time entries are still loading or empty
    if (!employees) {
      console.log('No employees data');
      return [];
    }
    
    // If time entries are still loading, show employees with zero metrics
    if (loadingEntries || !timeEntries || loadingTicketHours) {
      console.log('Time entries or service tickets still loading, showing employees with zero metrics');
      return employees.map((emp: any) => aggregateEmployeeMetrics([], emp, []));
    }
    
    console.log('Aggregating metrics:', { 
      timeEntriesCount: timeEntries.length, 
      employeesCount: employees.length,
      serviceTicketHoursCount: serviceTicketHours?.length || 0
    });
    const metrics = aggregateAllEmployees(timeEntries, employees, serviceTicketHours || []);
    console.log('Aggregated metrics:', metrics);
    return metrics;
  }, [timeEntries, employees, loadingEntries, serviceTicketHours, loadingTicketHours]);

  // Get unique departments from employees, always include "Automation"
  const departments = useMemo(() => {
    const depts = new Set<string>();
    // Always include "Automation"
    depts.add('Automation');
    
    if (employees) {
      employees.forEach((emp: any) => {
        if (emp.department) {
          depts.add(emp.department);
        }
      });
    }
    return Array.from(depts).sort();
  }, [employees]);

  // Filter by selected employee and department
  const filteredMetrics = useMemo(() => {
    let filtered = employeeMetrics;
    
    // Filter by employee
    if (selectedEmployeeId !== 'all') {
      filtered = filtered.filter(m => m.userId === selectedEmployeeId);
    }
    
    // Filter by department
    if (selectedDepartment !== 'all') {
      filtered = filtered.filter(m => {
        const employee = employees?.find((emp: any) => emp.user_id === m.userId);
        return employee?.department === selectedDepartment;
      });
    }
    
    return filtered;
  }, [employeeMetrics, selectedEmployeeId, selectedDepartment, employees]);

  // Sort metrics
  const sortedMetrics = useMemo(() => {
    return [...filteredMetrics].sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
      }
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc' 
          ? aVal.localeCompare(bVal) 
          : bVal.localeCompare(aVal);
      }
      return 0;
    });
  }, [filteredMetrics, sortField, sortDirection]);

  // Calculate totals
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
    // Total hours = billable + non-billable (for consistency)
    return {
      ...result,
      totalHours: result.billableHours + result.nonBillableHours,
    };
  }, [sortedMetrics]);

  const handleSort = (field: keyof EmployeeMetrics) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const isLoading = loadingEmployees || loadingEntries;

  // Restrict to admins only
  if (!isAdmin) {
    return (
      <div style={{ padding: '40px', textAlign: 'center' }}>
        <h2>Access Denied</h2>
        <p>You must be an administrator to view employee reports.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px', maxWidth: '1400px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        marginBottom: '24px',
        flexWrap: 'wrap',
        gap: '16px'
      }}>
        <h1 style={{ margin: 0, fontSize: '24px', fontWeight: '600' }}>Employee Reports</h1>
        
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          {/* Export buttons */}
          <button
            className="button button-secondary"
            style={{ padding: '8px 16px', fontSize: '13px' }}
            onClick={() => {
              exportEmployeeReportsToPDF(
                sortedMetrics,
                totals,
                selectedPeriod,
                `employee-reports-${startDate}-${endDate}`
              );
            }}
            disabled={isLoading || sortedMetrics.length === 0}
          >
            Export PDF
          </button>
          <button
            className="button button-secondary"
            style={{ padding: '8px 16px', fontSize: '13px' }}
            onClick={() => {
              exportEmployeeReportsToExcel(
                sortedMetrics,
                totals,
                selectedPeriod,
                `employee-reports-${startDate}-${endDate}`
              );
            }}
            disabled={isLoading || sortedMetrics.length === 0}
          >
            Export Excel
          </button>
        </div>
      </div>

      {/* Filters */}
      <div style={{
        display: 'flex',
        gap: '16px',
        marginBottom: '24px',
        flexWrap: 'wrap',
        alignItems: 'center'
      }}>
        {/* Time Period Selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <label style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Period:</label>
          <select
            value={selectedPeriod}
            onChange={(e) => {
              setSelectedPeriod(e.target.value);
              // Reset custom dates when switching away from Custom Range
              if (e.target.value !== 'Custom Range') {
                setCustomStartDate('');
                setCustomEndDate('');
              }
            }}
            style={{
              padding: '8px 12px',
              borderRadius: '6px',
              border: '1px solid var(--border-color)',
              backgroundColor: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              fontSize: '13px',
              cursor: 'pointer'
            }}
          >
            {periodPresets.map(preset => (
              <option key={preset.label} value={preset.label}>{preset.label}</option>
            ))}
          </select>
          
          {/* Custom Date Range Inputs */}
          {selectedPeriod === 'Custom Range' && (
            <>
              <label style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>From:</label>
              <input
                type="date"
                value={customStartDate}
                onChange={(e) => setCustomStartDate(e.target.value)}
                style={{
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: '1px solid var(--border-color)',
                  backgroundColor: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
                  fontSize: '13px'
                }}
              />
              <label style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>To:</label>
              <input
                type="date"
                value={customEndDate}
                onChange={(e) => setCustomEndDate(e.target.value)}
                min={customStartDate}
                style={{
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: '1px solid var(--border-color)',
                  backgroundColor: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
                  fontSize: '13px'
                }}
              />
            </>
          )}
        </div>

        {/* Department Filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Department:</label>
          <select
            value={selectedDepartment}
            onChange={(e) => setSelectedDepartment(e.target.value)}
            style={{
              padding: '8px 12px',
              borderRadius: '6px',
              border: '1px solid var(--border-color)',
              backgroundColor: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              fontSize: '13px',
              cursor: 'pointer'
            }}
          >
            <option value="all">All Departments</option>
            {departments.map((dept) => (
              <option key={dept} value={dept}>
                {dept}
              </option>
            ))}
          </select>
        </div>

        {/* Employee Filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Employee:</label>
          <select
            value={selectedEmployeeId}
            onChange={(e) => setSelectedEmployeeId(e.target.value)}
            style={{
              padding: '8px 12px',
              borderRadius: '6px',
              border: '1px solid var(--border-color)',
              backgroundColor: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              fontSize: '13px',
              cursor: 'pointer'
            }}
          >
            <option value="all">All Employees</option>
            {employees?.map((emp: any) => (
              <option key={emp.user_id} value={emp.user_id}>
                {emp.user?.first_name} {emp.user?.last_name}
              </option>
            ))}
          </select>
          {selectedEmployeeId !== 'all' && (
            <button
              onClick={() => navigate(`/calendar?viewUserId=${selectedEmployeeId}`)}
              style={{
                padding: '8px 16px',
                borderRadius: '6px',
                border: '1px solid var(--primary-color)',
                backgroundColor: 'var(--primary-color)',
                color: 'white',
                fontSize: '13px',
                cursor: 'pointer',
                fontWeight: '500'
              }}
            >
              View Calendar
            </button>
          )}
        </div>

        {/* View Toggle */}
        <div style={{ display: 'flex', gap: '4px', marginLeft: 'auto' }}>
          <button
            onClick={() => setViewMode('table')}
            style={{
              padding: '8px 16px',
              fontSize: '13px',
              border: '1px solid var(--border-color)',
              borderRadius: '6px 0 0 6px',
              backgroundColor: viewMode === 'table' ? 'var(--primary-color)' : 'var(--bg-primary)',
              color: viewMode === 'table' ? 'white' : 'var(--text-primary)',
              cursor: 'pointer'
            }}
          >
            Table
          </button>
          <button
            onClick={() => setViewMode('cards')}
            style={{
              padding: '8px 16px',
              fontSize: '13px',
              border: '1px solid var(--border-color)',
              borderRadius: '0 6px 6px 0',
              backgroundColor: viewMode === 'cards' ? 'var(--primary-color)' : 'var(--bg-primary)',
              color: viewMode === 'cards' ? 'white' : 'var(--text-primary)',
              cursor: 'pointer'
            }}
          >
            Cards
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '16px',
        marginBottom: '24px'
      }}>
        <div className="card" style={{ padding: '16px' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '8px' }}>
            Total Hours
          </div>
          <div style={{ fontSize: '24px', fontWeight: '600' }}>
            {formatHoursDecimal(totals.totalHours)}
          </div>
        </div>
        <div className="card" style={{ padding: '16px' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '8px' }}>
            Billable Hours
          </div>
          <div style={{ fontSize: '24px', fontWeight: '600' }}>
            {formatHoursDecimal(totals.billableHours)}
          </div>
        </div>
        <div className="card" style={{ padding: '16px' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '8px' }}>
            Non-Billable Hours
          </div>
          <div style={{ fontSize: '24px', fontWeight: '600' }}>
            {formatHoursDecimal(totals.nonBillableHours)}
          </div>
        </div>
        <div className="card" style={{ padding: '16px' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '8px' }}>
            Total Revenue
          </div>
          <div style={{ fontSize: '24px', fontWeight: '600', color: '#28a745' }}>
            {formatCurrency(totals.totalRevenue)}
          </div>
        </div>
        <div className="card" style={{ padding: '16px' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '8px' }}>
            Service Tickets
          </div>
          <div style={{ fontSize: '24px', fontWeight: '600' }}>
            {totals.serviceTicketCount}
          </div>
        </div>
        <div className="card" style={{ padding: '16px' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '8px' }}>
            Total Cost
          </div>
          <div style={{ fontSize: '24px', fontWeight: '600', color: '#dc3545' }}>
            {formatCurrency(totals.totalCost)}
          </div>
        </div>
        <div className="card" style={{ padding: '16px' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '8px' }}>
            Net Profit
          </div>
          <div style={{ fontSize: '24px', fontWeight: '600', color: totals.netProfit >= 0 ? '#28a745' : '#dc3545' }}>
            {formatCurrency(totals.netProfit)}
          </div>
        </div>
        <div className="card" style={{ padding: '16px' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '8px' }}>
            Profit Margin
          </div>
          <div style={{ fontSize: '24px', fontWeight: '600', color: totals.totalRevenue > 0 && (totals.netProfit / totals.totalRevenue) >= 0 ? '#28a745' : '#dc3545' }}>
            {totals.totalRevenue > 0 
              ? formatPercentage((totals.netProfit / totals.totalRevenue) * 100)
              : '0%'
            }
          </div>
        </div>
        <div className="card" style={{ padding: '16px' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '8px' }}>
            Avg Billable %
          </div>
          <div style={{ fontSize: '24px', fontWeight: '600' }}>
            {totals.totalHours > 0 
              ? formatPercentage((totals.billableHours / totals.totalHours) * 100)
              : '0%'
            }
          </div>
        </div>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
          Loading employee data...
        </div>
      )}

      {/* Table View */}
      {!isLoading && viewMode === 'table' && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="table" style={{ margin: 0 }}>
            <thead>
              <tr>
                <th 
                  onClick={() => handleSort('employeeName')}
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                >
                  Employee {sortField === 'employeeName' && (sortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('totalHours')}
                  style={{ cursor: 'pointer', userSelect: 'none', textAlign: 'right' }}
                >
                  Total Hours {sortField === 'totalHours' && (sortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('billableHours')}
                  style={{ cursor: 'pointer', userSelect: 'none', textAlign: 'right' }}
                >
                  Billable {sortField === 'billableHours' && (sortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('nonBillableHours')}
                  style={{ cursor: 'pointer', userSelect: 'none', textAlign: 'right' }}
                >
                  Non-Billable {sortField === 'nonBillableHours' && (sortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('efficiency')}
                  style={{ cursor: 'pointer', userSelect: 'none', textAlign: 'right' }}
                >
                  Billable % {sortField === 'efficiency' && (sortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('totalRevenue')}
                  style={{ cursor: 'pointer', userSelect: 'none', textAlign: 'right' }}
                >
                  Revenue {sortField === 'totalRevenue' && (sortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('totalCost')}
                  style={{ cursor: 'pointer', userSelect: 'none', textAlign: 'right' }}
                >
                  Cost {sortField === 'totalCost' && (sortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('netProfit')}
                  style={{ cursor: 'pointer', userSelect: 'none', textAlign: 'right' }}
                >
                  Net Profit {sortField === 'netProfit' && (sortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('profitMargin')}
                  style={{ cursor: 'pointer', userSelect: 'none', textAlign: 'right' }}
                >
                  Profit Margin {sortField === 'profitMargin' && (sortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('averageRate')}
                  style={{ cursor: 'pointer', userSelect: 'none', textAlign: 'right' }}
                >
                  Avg Rate {sortField === 'averageRate' && (sortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('serviceTicketCount')}
                  style={{ cursor: 'pointer', userSelect: 'none', textAlign: 'right' }}
                >
                  Tickets {sortField === 'serviceTicketCount' && (sortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th style={{ width: '40px' }}></th>
              </tr>
            </thead>
            <tbody>
              {sortedMetrics.length === 0 ? (
                <tr>
                  <td colSpan={12} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
                    No employee data for this period
                  </td>
                </tr>
              ) : (
                sortedMetrics.map((metrics) => (
                  <>
                    <tr 
                      key={metrics.userId}
                      onClick={() => setExpandedEmployee(
                        expandedEmployee === metrics.userId ? null : metrics.userId
                      )}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <div style={{ fontWeight: '500' }}>{metrics.employeeName}</div>
                        {metrics.position && (
                          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            {metrics.position}
                          </div>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>{formatHoursDecimal(metrics.totalHours)}</td>
                      <td style={{ textAlign: 'right' }}>{formatHoursDecimal(metrics.billableHours)}</td>
                      <td style={{ textAlign: 'right' }}>{formatHoursDecimal(metrics.nonBillableHours)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span style={{
                          padding: '4px 8px',
                          borderRadius: '12px',
                          fontSize: '12px',
                          backgroundColor: metrics.efficiency >= 80 ? '#28a74520' :
                                          metrics.efficiency >= 60 ? '#ffc10720' : '#dc354520',
                          color: metrics.efficiency >= 80 ? '#28a745' :
                                 metrics.efficiency >= 60 ? '#ffc107' : '#dc3545'
                        }}>
                          {formatPercentage(metrics.efficiency)}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right', color: '#28a745' }}>
                        {formatCurrency(metrics.totalRevenue)}
                      </td>
                      <td style={{ textAlign: 'right', color: '#dc3545' }}>
                        {formatCurrency(metrics.totalCost)}
                      </td>
                      <td style={{ textAlign: 'right', color: metrics.netProfit >= 0 ? '#28a745' : '#dc3545' }}>
                        {formatCurrency(metrics.netProfit)}
                      </td>
                      <td style={{ textAlign: 'right', color: metrics.profitMargin >= 0 ? '#28a745' : '#dc3545' }}>
                        {formatPercentage(metrics.profitMargin)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {formatCurrency(metrics.averageRate)}
                      </td>
                      <td style={{ textAlign: 'right' }}>{metrics.serviceTicketCount}</td>
                      <td style={{ textAlign: 'center' }}>
                        <span style={{ 
                          display: 'inline-block',
                          transform: expandedEmployee === metrics.userId ? 'rotate(180deg)' : 'rotate(0deg)',
                          transition: 'transform 0.2s'
                        }}>
                          ▼
                        </span>
                      </td>
                    </tr>
                    {/* Expanded Details */}
                    {expandedEmployee === metrics.userId && (
                      <tr>
                        <td colSpan={12} style={{ backgroundColor: 'var(--bg-secondary)', padding: '20px' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '20px' }}>
                            {/* Rate Type Breakdown */}
                            <div>
                              <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: '600' }}>
                                Hours by Rate Type
                              </h4>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                                  <span>Non-Billable Hours</span>
                                  <span>{formatHoursDecimal(metrics.rateTypeBreakdown.internalTime.hours)} ({formatCurrency(metrics.rateTypeBreakdown.internalTime.revenue)})</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                                  <span>Shop Time</span>
                                  <span>{formatHoursDecimal(metrics.rateTypeBreakdown.shopTime.hours)} ({formatCurrency(metrics.rateTypeBreakdown.shopTime.revenue)})</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                                  <span>Field Time</span>
                                  <span>{formatHoursDecimal(metrics.rateTypeBreakdown.fieldTime.hours)} ({formatCurrency(metrics.rateTypeBreakdown.fieldTime.revenue)})</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                                  <span>Travel Time</span>
                                  <span>{formatHoursDecimal(metrics.rateTypeBreakdown.travelTime.hours)} ({formatCurrency(metrics.rateTypeBreakdown.travelTime.revenue)})</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                                  <span>Shop Overtime</span>
                                  <span>{formatHoursDecimal(metrics.rateTypeBreakdown.shopOvertime.hours)} ({formatCurrency(metrics.rateTypeBreakdown.shopOvertime.revenue)})</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                                  <span>Field Overtime</span>
                                  <span>{formatHoursDecimal(metrics.rateTypeBreakdown.fieldOvertime.hours)} ({formatCurrency(metrics.rateTypeBreakdown.fieldOvertime.revenue)})</span>
                                </div>
                              </div>
                            </div>

                            {/* Project Breakdown */}
                            <div>
                              <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: '600' }}>
                                Top Projects
                              </h4>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                {metrics.projectBreakdown.slice(0, 5).map((proj: any) => (
                                  <div key={proj.projectId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '150px' }}>
                                      {proj.projectName}
                                    </span>
                                    <span>{formatHoursDecimal(proj.hours)} ({formatCurrency(proj.revenue)})</span>
                                  </div>
                                ))}
                                {metrics.projectBreakdown.length === 0 && (
                                  <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>No projects</div>
                                )}
                              </div>
                            </div>

                            {/* Customer Breakdown */}
                            <div>
                              <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: '600' }}>
                                Top Customers
                              </h4>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                {metrics.customerBreakdown.slice(0, 5).map((cust: any) => (
                                  <div key={cust.customerId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '150px' }}>
                                      {cust.customerName}
                                    </span>
                                    <span>{formatHoursDecimal(cust.hours)} ({formatCurrency(cust.revenue)})</span>
                                  </div>
                                ))}
                                {metrics.customerBreakdown.length === 0 && (
                                  <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>No customers</div>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Card View */}
      {!isLoading && viewMode === 'cards' && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))',
          gap: '20px'
        }}>
          {sortedMetrics.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)', gridColumn: '1 / -1' }}>
              No employee data for this period
            </div>
          ) : (
            sortedMetrics.map((metrics) => (
              <div 
                key={metrics.userId} 
                className="card"
                style={{ padding: '20px' }}
              >
                {/* Employee Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
                  <div>
                    <div style={{ fontSize: '16px', fontWeight: '600' }}>{metrics.employeeName}</div>
                    {metrics.position && (
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{metrics.position}</div>
                    )}
                  </div>
                  <span style={{
                    padding: '4px 10px',
                    borderRadius: '12px',
                    fontSize: '12px',
                    fontWeight: '500',
                    backgroundColor: metrics.efficiency >= 80 ? '#28a74520' :
                                    metrics.efficiency >= 60 ? '#ffc10720' : '#dc354520',
                    color: metrics.efficiency >= 80 ? '#28a745' :
                           metrics.efficiency >= 60 ? '#ffc107' : '#dc3545'
                  }}>
                    {formatPercentage(metrics.efficiency)} Billable %
                  </span>
                </div>

                {/* Key Metrics */}
                <div style={{ 
                  display: 'grid', 
                  gridTemplateColumns: 'repeat(2, 1fr)', 
                  gap: '12px',
                  marginBottom: '16px'
                }}>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Total Hours</div>
                    <div style={{ fontSize: '18px', fontWeight: '600' }}>{formatHoursDecimal(metrics.totalHours)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Billable</div>
                    <div style={{ fontSize: '18px', fontWeight: '600' }}>{formatHoursDecimal(metrics.billableHours)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Non-Billable</div>
                    <div style={{ fontSize: '18px', fontWeight: '600' }}>{formatHoursDecimal(metrics.nonBillableHours)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Revenue</div>
                    <div style={{ fontSize: '18px', fontWeight: '600', color: '#28a745' }}>{formatCurrency(metrics.totalRevenue)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Cost</div>
                    <div style={{ fontSize: '18px', fontWeight: '600', color: '#dc3545' }}>{formatCurrency(metrics.totalCost)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Net Profit</div>
                    <div style={{ fontSize: '18px', fontWeight: '600', color: metrics.netProfit >= 0 ? '#28a745' : '#dc3545' }}>
                      {formatCurrency(metrics.netProfit)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Profit Margin</div>
                    <div style={{ fontSize: '18px', fontWeight: '600', color: metrics.profitMargin >= 0 ? '#28a745' : '#dc3545' }}>
                      {formatPercentage(metrics.profitMargin)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Revenue/Hour</div>
                    <div style={{ fontSize: '18px', fontWeight: '600' }}>{formatCurrency(metrics.revenuePerHour)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Profit/Hour</div>
                    <div style={{ fontSize: '18px', fontWeight: '600', color: metrics.profitPerHour >= 0 ? '#28a745' : '#dc3545' }}>
                      {formatCurrency(metrics.profitPerHour)}
                    </div>
                  </div>
                </div>

                {/* Expandable Details */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const currentUserId = metrics.userId;
                    setExpandedEmployee((prev) => 
                      prev === currentUserId ? null : currentUserId
                    );
                  }}
                  style={{
                    width: '100%',
                    padding: '8px',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    backgroundColor: 'transparent',
                    color: 'var(--text-secondary)',
                    fontSize: '12px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px'
                  }}
                >
                  {expandedEmployee === metrics.userId ? 'Hide Details' : 'Show Details'}
                  <span style={{ 
                    transform: expandedEmployee === metrics.userId ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s'
                  }}>
                    ▼
                  </span>
                </button>

                {/* Expanded Content */}
                {expandedEmployee === metrics.userId && (
                  <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border-color)' }}>
                    {/* Rate Type Breakdown - Table Grid */}
                    <div style={{ marginBottom: '16px' }}>
                      <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', fontWeight: '600' }}>Hours by Rate Type</h4>
                      <table style={{ 
                        width: '100%', 
                        borderCollapse: 'collapse', 
                        fontSize: '11px',
                        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace'
                      }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                            <th style={{ textAlign: 'left', padding: '4px 8px 4px 0', fontWeight: '600', color: 'var(--text-secondary)' }}>Type</th>
                            <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: '600', color: 'var(--text-secondary)' }}>Hours</th>
                            <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: '600', color: 'var(--text-secondary)' }}>Billed</th>
                            <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: '600', color: 'var(--text-secondary)' }}>Cost</th>
                            <th style={{ textAlign: 'right', padding: '4px 0 4px 8px', fontWeight: '600', color: 'var(--text-secondary)' }}>Margin</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[
                            { label: 'Non-Billable', data: metrics.rateTypeBreakdown.internalTime },
                            { label: 'Shop Time', data: metrics.rateTypeBreakdown.shopTime },
                            { label: 'Field Time', data: metrics.rateTypeBreakdown.fieldTime },
                            { label: 'Travel Time', data: metrics.rateTypeBreakdown.travelTime },
                            { label: 'Shop OT', data: metrics.rateTypeBreakdown.shopOvertime },
                            { label: 'Field OT', data: metrics.rateTypeBreakdown.fieldOvertime },
                          ].filter(row => row.data.hours > 0).map((row, idx) => {
                            const isNonBillable = row.label === 'Non-Billable';
                            return (
                              <tr key={row.label} style={{ 
                                backgroundColor: idx % 2 === 1 ? 'var(--bg-secondary)' : 'transparent'
                              }}>
                                <td style={{ padding: '4px 8px 4px 0' }}>{row.label}</td>
                                <td style={{ textAlign: 'right', padding: '4px 8px' }}>{formatHoursDecimal(row.data.hours)}</td>
                                <td style={{ textAlign: 'right', padding: '4px 8px', color: isNonBillable ? '#ef4444' : undefined }}>
                                  {formatCurrency(row.data.revenue)}
                                </td>
                                <td style={{ textAlign: 'right', padding: '4px 8px' }}>{formatCurrency(row.data.cost)}</td>
                                <td style={{ 
                                  textAlign: 'right', 
                                  padding: '4px 0 4px 8px',
                                  color: row.data.profit >= 0 ? '#10b981' : '#ef4444'
                                }}>
                                  {formatCurrency(row.data.profit)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr style={{ borderTop: '1px solid var(--border-color)', fontWeight: '600' }}>
                            <td style={{ padding: '4px 8px 4px 0' }}>Total</td>
                            <td style={{ textAlign: 'right', padding: '4px 8px' }}>
                              {formatHoursDecimal(
                                metrics.rateTypeBreakdown.internalTime.hours +
                                metrics.rateTypeBreakdown.shopTime.hours +
                                metrics.rateTypeBreakdown.fieldTime.hours +
                                metrics.rateTypeBreakdown.travelTime.hours +
                                metrics.rateTypeBreakdown.shopOvertime.hours +
                                metrics.rateTypeBreakdown.fieldOvertime.hours
                              )}
                            </td>
                            <td style={{ textAlign: 'right', padding: '4px 8px' }}>
                              {formatCurrency(
                                // Non-billable hours are never billed, so exclude internalTime.revenue
                                metrics.rateTypeBreakdown.shopTime.revenue +
                                metrics.rateTypeBreakdown.fieldTime.revenue +
                                metrics.rateTypeBreakdown.travelTime.revenue +
                                metrics.rateTypeBreakdown.shopOvertime.revenue +
                                metrics.rateTypeBreakdown.fieldOvertime.revenue
                              )}
                            </td>
                            <td style={{ textAlign: 'right', padding: '4px 8px' }}>
                              {formatCurrency(
                                metrics.rateTypeBreakdown.internalTime.cost +
                                metrics.rateTypeBreakdown.shopTime.cost +
                                metrics.rateTypeBreakdown.fieldTime.cost +
                                metrics.rateTypeBreakdown.travelTime.cost +
                                metrics.rateTypeBreakdown.shopOvertime.cost +
                                metrics.rateTypeBreakdown.fieldOvertime.cost
                              )}
                            </td>
                            <td style={{ 
                              textAlign: 'right', 
                              padding: '4px 0 4px 8px',
                              color: (
                                metrics.rateTypeBreakdown.internalTime.profit +
                                metrics.rateTypeBreakdown.shopTime.profit +
                                metrics.rateTypeBreakdown.fieldTime.profit +
                                metrics.rateTypeBreakdown.travelTime.profit +
                                metrics.rateTypeBreakdown.shopOvertime.profit +
                                metrics.rateTypeBreakdown.fieldOvertime.profit
                              ) >= 0 ? '#10b981' : '#ef4444'
                            }}>
                              {formatCurrency(
                                metrics.rateTypeBreakdown.internalTime.profit +
                                metrics.rateTypeBreakdown.shopTime.profit +
                                metrics.rateTypeBreakdown.fieldTime.profit +
                                metrics.rateTypeBreakdown.travelTime.profit +
                                metrics.rateTypeBreakdown.shopOvertime.profit +
                                metrics.rateTypeBreakdown.fieldOvertime.profit
                              )}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>

                    {/* Top Projects */}
                    {metrics.projectBreakdown.length > 0 && (
                      <div style={{ marginBottom: '16px' }}>
                        <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', fontWeight: '600' }}>Top Projects</h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {metrics.projectBreakdown.slice(0, 3).map((proj: any) => (
                            <div key={proj.projectId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '200px' }}>
                                {proj.projectName}
                              </span>
                              <span>{formatHoursDecimal(proj.hours)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Top Customers */}
                    {metrics.customerBreakdown.length > 0 && (
                      <div>
                        <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', fontWeight: '600' }}>Top Customers</h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {metrics.customerBreakdown.slice(0, 3).map((cust: any) => (
                            <div key={cust.customerId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '200px' }}>
                                {cust.customerName}
                              </span>
                              <span>{formatCurrency(cust.revenue)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

