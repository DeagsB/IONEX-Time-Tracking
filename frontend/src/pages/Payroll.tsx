import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { supabase } from '../lib/supabaseClient';

interface TimeEntry {
  id: string;
  user_id: string;
  date: string;
  hours: number;
  rate: number;
  rate_type?: string;
  billable: boolean;
  approved: boolean;
  user?: {
    id: string;
    first_name: string;
    last_name: string;
    email: string;
  };
}

interface EmployeeHours {
  userId: string;
  name: string;
  email: string;
  shopTime: number;
  shopOvertime: number;
  travelTime: number;
  fieldTime: number;
  fieldOvertime: number;
  totalHours: number;
  billableHours: number;
  internalHours: number;
  entries: TimeEntry[];
}

export default function Payroll() {
  const { user } = useAuth();
  const { isDemoMode } = useDemoMode();
  
  // Default to current pay period (bi-weekly or monthly)
  const [startDate, setStartDate] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 14); // Last 2 weeks
    return date.toISOString().split('T')[0];
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [approvedOnly, setApprovedOnly] = useState(false);

  // Fetch all time entries for the date range (filtered by demo mode)
  const { data: timeEntries, isLoading, error } = useQuery({
    queryKey: ['payrollReport', startDate, endDate, approvedOnly, isDemoMode],
    queryFn: async () => {
      let query = supabase
        .from('time_entries')
        .select(`
          *,
          user:users!time_entries_user_id_fkey(id, first_name, last_name, email)
        `)
        .gte('date', startDate)
        .lte('date', endDate)
        .eq('is_demo', isDemoMode) // Only show demo entries in demo mode
        .order('date', { ascending: true });

      if (approvedOnly) {
        query = query.eq('approved', true);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as TimeEntry[];
    },
  });

  // Group entries by employee and calculate totals by rate type
  const employeeHours = useMemo(() => {
    if (!timeEntries) return [];

    const employeeMap = new Map<string, EmployeeHours>();

    for (const entry of timeEntries) {
      const userId = entry.user_id;
      const userName = entry.user
        ? `${entry.user.first_name || ''} ${entry.user.last_name || ''}`.trim() || entry.user.email
        : 'Unknown';

      if (!employeeMap.has(userId)) {
        employeeMap.set(userId, {
          userId,
          name: userName,
          email: entry.user?.email || '',
          shopTime: 0,
          shopOvertime: 0,
          travelTime: 0,
          fieldTime: 0,
          fieldOvertime: 0,
          totalHours: 0,
          billableHours: 0,
          internalHours: 0,
          entries: [],
        });
      }

      const emp = employeeMap.get(userId)!;
      emp.entries.push(entry);
      const hours = Number(entry.hours) || 0;
      emp.totalHours += hours;
      if (entry.billable) {
        emp.billableHours += hours;
      } else {
        emp.internalHours += hours;
      }

      const rateType = entry.rate_type || 'Shop Time';
      switch (rateType) {
        case 'Shop Time':
          emp.shopTime += Number(entry.hours) || 0;
          break;
        case 'Shop Overtime':
          emp.shopOvertime += Number(entry.hours) || 0;
          break;
        case 'Travel Time':
          emp.travelTime += Number(entry.hours) || 0;
          break;
        case 'Field Time':
          emp.fieldTime += Number(entry.hours) || 0;
          break;
        case 'Field Overtime':
          emp.fieldOvertime += Number(entry.hours) || 0;
          break;
        default:
          emp.shopTime += Number(entry.hours) || 0;
      }
    }

    return Array.from(employeeMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [timeEntries]);

  // Calculate grand totals
  const grandTotals = useMemo(() => {
    return employeeHours.reduce(
      (totals, emp) => ({
        shopTime: totals.shopTime + emp.shopTime,
        shopOvertime: totals.shopOvertime + emp.shopOvertime,
        travelTime: totals.travelTime + emp.travelTime,
        fieldTime: totals.fieldTime + emp.fieldTime,
        fieldOvertime: totals.fieldOvertime + emp.fieldOvertime,
        totalHours: totals.totalHours + emp.totalHours,
        billableHours: totals.billableHours + emp.billableHours,
        internalHours: totals.internalHours + emp.internalHours,
      }),
      { shopTime: 0, shopOvertime: 0, travelTime: 0, fieldTime: 0, fieldOvertime: 0, totalHours: 0, billableHours: 0, internalHours: 0 }
    );
  }, [employeeHours]);

  // Quick date range presets
  const setDatePreset = (preset: string) => {
    const today = new Date();
    let start: Date;
    let end: Date = today;

    switch (preset) {
      case 'thisWeek':
        start = new Date(today);
        start.setDate(today.getDate() - today.getDay()); // Start of week (Sunday)
        break;
      case 'lastWeek':
        start = new Date(today);
        start.setDate(today.getDate() - today.getDay() - 7);
        end = new Date(start);
        end.setDate(start.getDate() + 6);
        break;
      case 'last2Weeks':
        start = new Date(today);
        start.setDate(today.getDate() - 14);
        break;
      case 'thisMonth':
        start = new Date(today.getFullYear(), today.getMonth(), 1);
        end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        break;
      case 'lastMonth':
        start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        end = new Date(today.getFullYear(), today.getMonth(), 0);
        break;
      default:
        return;
    }

    setStartDate(start.toISOString().split('T')[0]);
    setEndDate(end.toISOString().split('T')[0]);
  };

  if (user?.role !== 'ADMIN') {
    return (
      <div>
        <h2>Reports</h2>
        <div className="card">
          <p>You don't have permission to view this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>
          Payroll Report
        </h2>
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: '24px', padding: '20px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'flex-end' }}>
          {/* Date Range */}
          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase' }}>
              Start Date
            </label>
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
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase' }}>
              End Date
            </label>
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
              }}
            />
          </div>

          {/* Quick Presets */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="button button-secondary" style={{ padding: '8px 12px', fontSize: '12px' }} onClick={() => setDatePreset('thisWeek')}>This Week</button>
            <button className="button button-secondary" style={{ padding: '8px 12px', fontSize: '12px' }} onClick={() => setDatePreset('lastWeek')}>Last Week</button>
            <button className="button button-secondary" style={{ padding: '8px 12px', fontSize: '12px' }} onClick={() => setDatePreset('last2Weeks')}>Last 2 Weeks</button>
            <button className="button button-secondary" style={{ padding: '8px 12px', fontSize: '12px' }} onClick={() => setDatePreset('thisMonth')}>This Month</button>
            <button className="button button-secondary" style={{ padding: '8px 12px', fontSize: '12px' }} onClick={() => setDatePreset('lastMonth')}>Last Month</button>
          </div>

          {/* Approved Only Filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="checkbox"
              id="approvedOnly"
              checked={approvedOnly}
              onChange={(e) => setApprovedOnly(e.target.checked)}
              style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: '#c770f0' }}
            />
            <label htmlFor="approvedOnly" style={{ fontSize: '14px', color: 'var(--text-primary)', cursor: 'pointer' }}>
              Approved Only
            </label>
          </div>
        </div>
      </div>

      {/* Loading / Error States */}
      {error ? (
        <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: '#ef5350' }}>Error loading report data</p>
        </div>
      ) : isLoading ? (
        <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-secondary)' }}>Loading payroll data...</p>
        </div>
      ) : employeeHours.length === 0 ? (
        <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-secondary)' }}>No time entries found for the selected period.</p>
        </div>
      ) : (
        <>
          {/* Summary Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '16px', marginBottom: '24px' }}>
            <div className="card" style={{ padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>Total Hours</div>
              <div style={{ fontSize: '28px', fontWeight: '700', color: 'var(--text-primary)' }}>{grandTotals.totalHours.toFixed(2)}</div>
            </div>
            <div className="card" style={{ padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>Billable Hours</div>
              <div style={{ fontSize: '28px', fontWeight: '700', color: '#28a745' }}>{grandTotals.billableHours.toFixed(2)}</div>
            </div>
            <div className="card" style={{ padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>Internal Hours</div>
              <div style={{ fontSize: '28px', fontWeight: '700', color: '#dc3545' }}>{grandTotals.internalHours.toFixed(2)}</div>
            </div>
            <div className="card" style={{ padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>Shop Time</div>
              <div style={{ fontSize: '28px', fontWeight: '700', color: '#4caf50' }}>{grandTotals.shopTime.toFixed(2)}</div>
            </div>
            <div className="card" style={{ padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>Shop OT</div>
              <div style={{ fontSize: '28px', fontWeight: '700', color: '#ff9800' }}>{grandTotals.shopOvertime.toFixed(2)}</div>
            </div>
            <div className="card" style={{ padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>Travel Time</div>
              <div style={{ fontSize: '28px', fontWeight: '700', color: '#2196f3' }}>{grandTotals.travelTime.toFixed(2)}</div>
            </div>
            <div className="card" style={{ padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>Field Time</div>
              <div style={{ fontSize: '28px', fontWeight: '700', color: '#9c27b0' }}>{grandTotals.fieldTime.toFixed(2)}</div>
            </div>
            <div className="card" style={{ padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>Field OT</div>
              <div style={{ fontSize: '28px', fontWeight: '700', color: '#e91e63' }}>{grandTotals.fieldOvertime.toFixed(2)}</div>
            </div>
          </div>

          {/* Employee Hours Table */}
          <div className="card" style={{ overflow: 'hidden' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600', color: 'var(--text-primary)' }}>
                Employee Hours by Rate Type
              </h3>
              <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: 'var(--text-secondary)' }}>
                {startDate} to {endDate} • {employeeHours.length} employee{employeeHours.length !== 1 ? 's' : ''}
              </p>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
                  <th style={{ padding: '14px 16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                    Employee
                  </th>
                  <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: '#4caf50', textTransform: 'uppercase' }}>
                    Shop Time
                  </th>
                  <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: '#ff9800', textTransform: 'uppercase' }}>
                    Shop OT
                  </th>
                  <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: '#2196f3', textTransform: 'uppercase' }}>
                    Travel
                  </th>
                  <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: '#9c27b0', textTransform: 'uppercase' }}>
                    Field
                  </th>
                  <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: '#e91e63', textTransform: 'uppercase' }}>
                    Field OT
                  </th>
                  <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-primary)', textTransform: 'uppercase' }}>
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {employeeHours.map((emp) => (
                  <tr key={emp.userId} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '14px 16px' }}>
                      <div style={{ fontWeight: '500', color: 'var(--text-primary)' }}>{emp.name}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{emp.email}</div>
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '14px', color: emp.shopTime > 0 ? '#4caf50' : 'var(--text-secondary)' }}>
                      {emp.shopTime.toFixed(2)}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '14px', color: emp.shopOvertime > 0 ? '#ff9800' : 'var(--text-secondary)' }}>
                      {emp.shopOvertime.toFixed(2)}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '14px', color: emp.travelTime > 0 ? '#2196f3' : 'var(--text-secondary)' }}>
                      {emp.travelTime.toFixed(2)}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '14px', color: emp.fieldTime > 0 ? '#9c27b0' : 'var(--text-secondary)' }}>
                      {emp.fieldTime.toFixed(2)}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '14px', color: emp.fieldOvertime > 0 ? '#e91e63' : 'var(--text-secondary)' }}>
                      {emp.fieldOvertime.toFixed(2)}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: 'var(--text-primary)' }}>
                      {emp.totalHours.toFixed(2)}
                    </td>
                  </tr>
                ))}
                {/* Totals Row */}
                <tr style={{ backgroundColor: 'var(--bg-secondary)', borderTop: '2px solid var(--border-color)' }}>
                  <td style={{ padding: '14px 16px', fontWeight: '700', color: 'var(--text-primary)' }}>
                    TOTALS
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#4caf50' }}>
                    {grandTotals.shopTime.toFixed(2)}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#ff9800' }}>
                    {grandTotals.shopOvertime.toFixed(2)}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#2196f3' }}>
                    {grandTotals.travelTime.toFixed(2)}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#9c27b0' }}>
                    {grandTotals.fieldTime.toFixed(2)}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#e91e63' }}>
                    {grandTotals.fieldOvertime.toFixed(2)}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)' }}>
                    {grandTotals.totalHours.toFixed(2)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
