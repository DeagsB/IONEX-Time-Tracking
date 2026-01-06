import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { supabase } from '../lib/supabaseClient';
import { reportsService } from '../services/supabaseServices';

interface TimeEntry {
  id: string;
  user_id: string;
  date: string;
  hours: number;
  rate: number;
  rate_type?: string;
  billable: boolean;
  approved: boolean;
  project_id?: string;
  user?: {
    id: string;
    first_name: string;
    last_name: string;
    email: string;
  };
  project?: {
    id: string;
    customer?: {
      id: string;
    };
  };
}

interface EmployeeHours {
  userId: string;
  name: string;
  email: string;
  internalShopTime: number;
  internalShopOvertime: number;
  internalTravelTime: number;
  internalFieldTime: number;
  internalFieldOvertime: number;
  shopTime: number;
  shopOvertime: number;
  travelTime: number;
  fieldTime: number;
  fieldOvertime: number;
  totalHours: number;
  internalHours: number;
  entries: TimeEntry[];
}

// Round UP to nearest 0.10 hour (never round down)
const roundToQuarterHour = (hours: number): number => {
  return Math.ceil(hours * 10) / 10;
};

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
          user:users!time_entries_user_id_fkey(id, first_name, last_name, email),
          project:projects!time_entries_project_id_fkey(
            id,
            customer:customers!projects_customer_id_fkey(id)
          )
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

  // Fetch service ticket hours to adjust payroll hours dynamically
  const { data: serviceTicketHours } = useQuery({
    queryKey: ['serviceTicketHours', startDate, endDate, isDemoMode],
    queryFn: async () => {
      // Note: service_tickets table doesn't have is_demo, so we'll filter by user_id from time entries
      const data = await reportsService.getServiceTicketHours(startDate, endDate);
      return data || [];
    },
    enabled: !!timeEntries, // Only fetch if time entries are loaded
  });

  // Group entries by employee and calculate totals by rate type
  // Adjust hours based on service ticket edits (similar to employee reports)
  const employeeHours = useMemo(() => {
    if (!timeEntries) return [];

    const employeeMap = new Map<string, EmployeeHours>();

    // First pass: Calculate actual payroll hours from time entries
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
          internalShopTime: 0,
          internalShopOvertime: 0,
          internalTravelTime: 0,
          internalFieldTime: 0,
          internalFieldOvertime: 0,
          shopTime: 0,
          shopOvertime: 0,
          travelTime: 0,
          fieldTime: 0,
          fieldOvertime: 0,
          totalHours: 0,
          internalHours: 0,
          entries: [],
        });
      }

      const emp = employeeMap.get(userId)!;
      emp.entries.push(entry);
      // Sum actual hours first (don't round individual entries)
      const hours = Number(entry.hours) || 0;
      emp.totalHours += hours;
      if (!entry.billable) {
        emp.internalHours += hours;
      }

      const rateType = entry.rate_type || 'Shop Time';
      const isInternal = !entry.billable;
      
      switch (rateType) {
        case 'Shop Time':
          if (isInternal) {
            emp.internalShopTime += hours;
          } else {
            emp.shopTime += hours;
          }
          break;
        case 'Shop Overtime':
          if (isInternal) {
            emp.internalShopOvertime += hours;
          } else {
            emp.shopOvertime += hours;
          }
          break;
        case 'Travel Time':
          if (isInternal) {
            emp.internalTravelTime += hours;
          } else {
            emp.travelTime += hours;
          }
          break;
        case 'Field Time':
          if (isInternal) {
            emp.internalFieldTime += hours;
          } else {
            emp.fieldTime += hours;
          }
          break;
        case 'Field Overtime':
          if (isInternal) {
            emp.internalFieldOvertime += hours;
          } else {
            emp.fieldOvertime += hours;
          }
          break;
        default:
          if (isInternal) {
            emp.internalShopTime += hours;
          } else {
            emp.shopTime += hours;
          }
      }
    }

    // Second pass: Adjust hours based on service ticket edits
    if (serviceTicketHours && serviceTicketHours.length > 0) {
      // Group service ticket hours by user and rate type
      const serviceHoursByUser = new Map<string, {
        shopTime: number;
        fieldTime: number;
        travelTime: number;
        shopOvertime: number;
        fieldOvertime: number;
      }>();

      // Deduplicate service tickets by date + user_id + customer_id
      const uniqueTicketMap = new Map<string, typeof serviceTicketHours[0]>();
      serviceTicketHours.forEach(ticket => {
        const key = `${ticket.date}-${ticket.user_id}-${ticket.customer_id || 'unassigned'}`;
        const existing = uniqueTicketMap.get(key);
        if (!existing || (ticket.is_edited && !existing.is_edited)) {
          uniqueTicketMap.set(key, ticket);
        }
      });
      const dedupedTickets = Array.from(uniqueTicketMap.values());

      dedupedTickets.forEach(ticket => {
        const userId = ticket.user_id;
        if (!serviceHoursByUser.has(userId)) {
          serviceHoursByUser.set(userId, {
            shopTime: 0,
            fieldTime: 0,
            travelTime: 0,
            shopOvertime: 0,
            fieldOvertime: 0,
          });
        }

        const userServiceHours = serviceHoursByUser.get(userId)!;

        // If ticket has been edited, use edited_hours directly
        if (ticket.is_edited && ticket.edited_hours) {
          Object.entries(ticket.edited_hours).forEach(([rateTypeKey, hours]) => {
            let hoursForRate = 0;
            if (Array.isArray(hours)) {
              hoursForRate = hours.reduce((sum, h) => sum + (h || 0), 0);
            } else {
              hoursForRate = hours as number;
            }

            const rateType = rateTypeKey.toLowerCase();
            if (rateType.includes('shop') && rateType.includes('overtime')) {
              userServiceHours.shopOvertime += hoursForRate;
            } else if (rateType.includes('field') && rateType.includes('overtime')) {
              userServiceHours.fieldOvertime += hoursForRate;
            } else if (rateType.includes('field')) {
              userServiceHours.fieldTime += hoursForRate;
            } else if (rateType.includes('travel')) {
              userServiceHours.travelTime += hoursForRate;
            } else {
              userServiceHours.shopTime += hoursForRate;
            }
          });
        } else {
          // Ticket not edited - use total_hours and distribute by matching entries
          const ticketDate = ticket.date;
          const ticketHours = Number(ticket.total_hours) || 0;
          
          // Find matching billable time entries for this ticket
          const matchingEntries = timeEntries.filter(entry => {
            if (entry.date !== ticketDate) return false;
            if (!entry.billable) return false;
            if (entry.user_id !== ticket.user_id) return false;
            if (ticket.customer_id && entry.project?.customer?.id !== ticket.customer_id) return false;
            if (ticket.project_id && entry.project_id !== ticket.project_id) return false;
            return true;
          });

          if (matchingEntries.length > 0 && ticketHours > 0) {
            const totalEntryHours = matchingEntries.reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
            if (totalEntryHours > 0) {
              matchingEntries.forEach(entry => {
                const entryHours = Number(entry.hours) || 0;
                const proportion = entryHours / totalEntryHours;
                const ticketHoursForThisRate = ticketHours * proportion;
                const rateType = (entry.rate_type || 'Shop Time').toLowerCase();

                if (rateType.includes('shop') && rateType.includes('overtime')) {
                  userServiceHours.shopOvertime += ticketHoursForThisRate;
                } else if (rateType.includes('field') && rateType.includes('overtime')) {
                  userServiceHours.fieldOvertime += ticketHoursForThisRate;
                } else if (rateType.includes('field')) {
                  userServiceHours.fieldTime += ticketHoursForThisRate;
                } else if (rateType.includes('travel')) {
                  userServiceHours.travelTime += ticketHoursForThisRate;
                } else {
                  userServiceHours.shopTime += ticketHoursForThisRate;
                }
              });
            }
          } else if (ticketHours > 0) {
            // No matching entries but ticket has hours - default to shop time
            userServiceHours.shopTime += ticketHours;
          }
        }
      });

      // Adjust employee hours based on service ticket hours
      employeeMap.forEach((emp, userId) => {
        const serviceHours = serviceHoursByUser.get(userId);
        if (!serviceHours) return; // No service tickets for this employee

        // For each billable rate type, if payroll > service ticket, move difference to internal
        // If service ticket > payroll (minimums), don't deduct from internal
        const unbilledShopTime = Math.max(0, emp.shopTime - serviceHours.shopTime);
        const unbilledFieldTime = Math.max(0, emp.fieldTime - serviceHours.fieldTime);
        const unbilledTravelTime = Math.max(0, emp.travelTime - serviceHours.travelTime);
        const unbilledShopOT = Math.max(0, emp.shopOvertime - serviceHours.shopOvertime);
        const unbilledFieldOT = Math.max(0, emp.fieldOvertime - serviceHours.fieldOvertime);

        // Move unbilled work to internal
        emp.internalShopTime += unbilledShopTime;
        emp.internalFieldTime += unbilledFieldTime;
        emp.internalTravelTime += unbilledTravelTime;
        emp.internalShopOvertime += unbilledShopOT;
        emp.internalFieldOvertime += unbilledFieldOT;

        // Update billable hours to match service ticket hours (but don't go below 0)
        emp.shopTime = Math.max(0, serviceHours.shopTime);
        emp.fieldTime = Math.max(0, serviceHours.fieldTime);
        emp.travelTime = Math.max(0, serviceHours.travelTime);
        emp.shopOvertime = Math.max(0, serviceHours.shopOvertime);
        emp.fieldOvertime = Math.max(0, serviceHours.fieldOvertime);

        // Recalculate internal hours and total hours
        emp.internalHours = emp.internalShopTime + emp.internalShopOvertime + 
                           emp.internalTravelTime + emp.internalFieldTime + 
                           emp.internalFieldOvertime;
        emp.totalHours = emp.internalHours + emp.shopTime + emp.shopOvertime + 
                        emp.travelTime + emp.fieldTime + emp.fieldOvertime;
      });
    }

    // Round totals after summing all actual hours and adjustments
    const roundedEmployeeHours = Array.from(employeeMap.values()).map(emp => {
      return {
        ...emp,
        internalShopTime: roundToQuarterHour(emp.internalShopTime),
        internalShopOvertime: roundToQuarterHour(emp.internalShopOvertime),
        internalTravelTime: roundToQuarterHour(emp.internalTravelTime),
        internalFieldTime: roundToQuarterHour(emp.internalFieldTime),
        internalFieldOvertime: roundToQuarterHour(emp.internalFieldOvertime),
        shopTime: roundToQuarterHour(emp.shopTime),
        shopOvertime: roundToQuarterHour(emp.shopOvertime),
        travelTime: roundToQuarterHour(emp.travelTime),
        fieldTime: roundToQuarterHour(emp.fieldTime),
        fieldOvertime: roundToQuarterHour(emp.fieldOvertime),
        totalHours: roundToQuarterHour(emp.totalHours),
        internalHours: roundToQuarterHour(emp.internalHours),
      };
    });

    return roundedEmployeeHours.sort((a, b) => a.name.localeCompare(b.name));
  }, [timeEntries, serviceTicketHours]);

  // Calculate grand totals (already rounded from employeeHours)
  const grandTotals = useMemo(() => {
    return employeeHours.reduce(
      (totals, emp) => ({
        internalShopTime: totals.internalShopTime + emp.internalShopTime,
        internalShopOvertime: totals.internalShopOvertime + emp.internalShopOvertime,
        internalTravelTime: totals.internalTravelTime + emp.internalTravelTime,
        internalFieldTime: totals.internalFieldTime + emp.internalFieldTime,
        internalFieldOvertime: totals.internalFieldOvertime + emp.internalFieldOvertime,
        shopTime: totals.shopTime + emp.shopTime,
        shopOvertime: totals.shopOvertime + emp.shopOvertime,
        travelTime: totals.travelTime + emp.travelTime,
        fieldTime: totals.fieldTime + emp.fieldTime,
        fieldOvertime: totals.fieldOvertime + emp.fieldOvertime,
        totalHours: totals.totalHours + emp.totalHours,
        internalHours: totals.internalHours + emp.internalHours,
      }),
      { internalShopTime: 0, internalShopOvertime: 0, internalTravelTime: 0, internalFieldTime: 0, internalFieldOvertime: 0, shopTime: 0, shopOvertime: 0, travelTime: 0, fieldTime: 0, fieldOvertime: 0, totalHours: 0, internalHours: 0 }
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
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>Internal Time</div>
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
                  <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: '#dc3545', textTransform: 'uppercase' }}>
                    Internal Time
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
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '14px', color: emp.internalHours > 0 ? '#dc3545' : 'var(--text-secondary)' }}>
                      {emp.internalHours.toFixed(2)}
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
                  <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: '700', color: '#dc3545' }}>
                    {grandTotals.internalHours.toFixed(2)}
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
