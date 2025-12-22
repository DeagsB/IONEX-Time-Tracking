import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { reportsService } from '../services/supabaseServices';

interface TimeEntry {
  id: string;
  user_id: string;
  project_id?: string;
  date: string;
  hours: number;
  rate: number;
  billable: boolean;
  project?: {
    name: string;
    customer?: {
      name: string;
    };
  };
  user?: {
    first_name: string;
    last_name: string;
  };
}

export default function Reports() {
  const { user } = useAuth();
  const [dateRange, setDateRange] = useState({
    startDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    endDate: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().split('T')[0],
  });

  const { data: timeEntries } = useQuery({
    queryKey: ['reports', dateRange.startDate, dateRange.endDate],
    queryFn: () => reportsService.getEmployeeReport(dateRange.startDate, dateRange.endDate),
  });

  const calculateTotalHours = () => {
    return timeEntries?.reduce((acc: number, entry: TimeEntry) => acc + Number(entry.hours), 0) || 0;
  };

  const calculateBillableAmount = () => {
    return timeEntries?.reduce((acc: number, entry: TimeEntry) => {
      if (entry.billable) {
        return acc + (Number(entry.hours) * Number(entry.rate));
      }
      return acc;
    }, 0) || 0;
  };

  // Group by Project
  const projectSummary = timeEntries?.reduce((acc: any, entry: TimeEntry) => {
    const projectName = entry.project?.name || 'No Project';
    if (!acc[projectName]) {
      acc[projectName] = { hours: 0, amount: 0 };
    }
    acc[projectName].hours += Number(entry.hours);
    if (entry.billable) {
      acc[projectName].amount += Number(entry.hours) * Number(entry.rate);
    }
    return acc;
  }, {});

  // Group by Employee (for Admin)
  const employeeSummary = timeEntries?.reduce((acc: any, entry: TimeEntry) => {
    const name = entry.user ? `${entry.user.first_name} ${entry.user.last_name}` : 'Unknown';
    if (!acc[name]) {
      acc[name] = { hours: 0, amount: 0 };
    }
    acc[name].hours += Number(entry.hours);
    if (entry.billable) {
      acc[name].amount += Number(entry.hours) * Number(entry.rate);
    }
    return acc;
  }, {});

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2>Reports</h2>
        <div style={{ display: 'flex', gap: '10px' }}>
          <input
            type="date"
            className="input"
            value={dateRange.startDate}
            onChange={(e) => setDateRange({ ...dateRange, startDate: e.target.value })}
          />
          <span style={{ alignSelf: 'center' }}>to</span>
          <input
            type="date"
            className="input"
            value={dateRange.endDate}
            onChange={(e) => setDateRange({ ...dateRange, endDate: e.target.value })}
          />
        </div>
      </div>

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '20px' }}>
        <div className="card">
          <h3 style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '5px' }}>Total Hours</h3>
          <div style={{ fontSize: '24px', fontWeight: 'bold' }}>{calculateTotalHours().toFixed(2)}</div>
        </div>
        <div className="card">
          <h3 style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '5px' }}>Billable Amount</h3>
          <div style={{ fontSize: '24px', fontWeight: 'bold' }}>${calculateBillableAmount().toFixed(2)}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        {/* Project Summary */}
        <div className="card">
          <h3>Hours by Project</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Hours</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {projectSummary && Object.entries(projectSummary).map(([name, data]: [string, any]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td>{data.hours.toFixed(2)}</td>
                  <td>${data.amount.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Employee Summary (Admin Only) */}
        {user?.role === 'ADMIN' && (
          <div className="card">
            <h3>Hours by Employee</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Hours</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {employeeSummary && Object.entries(employeeSummary).map(([name, data]: [string, any]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>{data.hours.toFixed(2)}</td>
                    <td>${data.amount.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
