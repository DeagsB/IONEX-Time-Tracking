import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { bugReportsService } from '../services/supabaseServices';

export default function BugReports() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');

  // Redirect if not global admin
  if (!user?.global_admin) {
    return (
      <div style={{ padding: '40px', textAlign: 'center' }}>
        <h2>Access Denied</h2>
        <p>You must be a global admin to access this page.</p>
      </div>
    );
  }

  const { data: bugReports, isLoading } = useQuery({
    queryKey: ['bugReports', 'all'],
    queryFn: () => bugReportsService.getAll(),
  });

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { data, error } = await bugReportsService.updateStatus(id, status);
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bugReports'] });
    },
  });

  const filteredReports = bugReports?.filter((report: any) => {
    const matchesSearch = 
      report.title?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      report.description?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      report.user_email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      report.user_name?.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesStatus = statusFilter === 'all' || report.status === statusFilter;
    const matchesPriority = priorityFilter === 'all' || report.priority === priorityFilter;

    return matchesSearch && matchesStatus && matchesPriority;
  });

  const handleStatusChange = (id: string, newStatus: string) => {
    updateStatusMutation.mutate({ id, status: newStatus });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'open': return 'var(--error-color)';
      case 'in_progress': return 'var(--warning-color)';
      case 'resolved': return 'var(--success-color)';
      case 'closed': return 'var(--text-tertiary)';
      default: return 'var(--text-secondary)';
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'critical': return 'var(--error-color)';
      case 'high': return '#ff6b6b';
      case 'medium': return 'var(--warning-color)';
      case 'low': return 'var(--info-color)';
      default: return 'var(--text-secondary)';
    }
  };

  return (
    <div style={{ padding: '40px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <h1>Bug Reports</h1>
      </div>

      <div className="card" style={{ marginBottom: '20px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '15px', marginBottom: '20px' }}>
          <input
            type="text"
            className="input"
            placeholder="Search by title, description, or user..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <select
            className="input"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All Statuses</option>
            <option value="open">Open</option>
            <option value="in_progress">In Progress</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
          <select
            className="input"
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
          >
            <option value="all">All Priorities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>

        {isLoading ? (
          <div style={{ textAlign: 'center', padding: '40px' }}>Loading bug reports...</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Title</th>
                <th>User</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredReports && filteredReports.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '20px' }}>
                    No bug reports found.
                  </td>
                </tr>
              )}
              {filteredReports?.map((report: any) => (
                <tr key={report.id}>
                  <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                    {report.id.substring(0, 8)}...
                  </td>
                  <td>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>{report.title}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {report.description}
                    </div>
                  </td>
                  <td>
                    <div>{report.user_name || 'Anonymous'}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      {report.user_email || '-'}
                    </div>
                  </td>
                  <td>
                    <span style={{
                      backgroundColor: getPriorityColor(report.priority),
                      color: 'white',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 'bold',
                      textTransform: 'uppercase',
                    }}>
                      {report.priority}
                    </span>
                  </td>
                  <td>
                    <select
                      className="input"
                      value={report.status || 'open'}
                      onChange={(e) => handleStatusChange(report.id, e.target.value)}
                      style={{
                        padding: '4px 8px',
                        fontSize: '12px',
                        borderColor: getStatusColor(report.status || 'open'),
                        minWidth: '120px',
                      }}
                    >
                      <option value="open">Open</option>
                      <option value="in_progress">In Progress</option>
                      <option value="resolved">Resolved</option>
                      <option value="closed">Closed</option>
                    </select>
                  </td>
                  <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    {new Date(report.created_at).toLocaleDateString()}
                  </td>
                  <td>
                    <button
                      className="button button-secondary"
                      style={{ padding: '4px 8px', fontSize: '12px' }}
                      onClick={() => {
                        const fullDescription = `Title: ${report.title}\n\nDescription:\n${report.description}\n\nPriority: ${report.priority}\nStatus: ${report.status}\nReported by: ${report.user_name} (${report.user_email})\nCreated: ${new Date(report.created_at).toLocaleString()}`;
                        alert(fullDescription);
                      }}
                    >
                      View Details
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

