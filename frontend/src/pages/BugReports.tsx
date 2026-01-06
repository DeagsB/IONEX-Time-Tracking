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
  const [typeFilter, setTypeFilter] = useState<string>('all'); // all, bug, suggestion
  const [sortBy, setSortBy] = useState<string>('date'); // date, priority, status, type
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [selectedReport, setSelectedReport] = useState<any>(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [notes, setNotes] = useState('');
  const [modalMouseDownPos, setModalMouseDownPos] = useState<{ x: number; y: number } | null>(null);

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

  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: any }) => {
      return await bugReportsService.update(id, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bugReports'] });
      setShowDetailsModal(false);
      setSelectedReport(null);
      setNotes('');
    },
  });

  const handleMarkResolved = (report: any) => {
    const updates: any = {
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      resolved_by: user?.id,
    };
    if (notes.trim()) {
      updates.notes = notes.trim();
    }
    updateMutation.mutate({ id: report.id, updates });
  };

  const handleMarkClosed = (report: any) => {
    const updates: any = {
      status: 'closed',
      resolved_at: report.resolved_at || new Date().toISOString(),
      resolved_by: report.resolved_by || user?.id,
    };
    if (notes.trim()) {
      updates.notes = notes.trim();
    }
    updateMutation.mutate({ id: report.id, updates });
  };

  // Helper function to determine if a report is a suggestion
  const isSuggestion = (report: any) => {
    return report.title?.startsWith('[Suggestion]');
  };

  // Helper function to get report type
  const getReportType = (report: any) => {
    return isSuggestion(report) ? 'suggestion' : 'bug';
  };

  // Helper function to get type color
  const getTypeColor = (report: any) => {
    return isSuggestion(report) ? '#10b981' : '#ef4444'; // Green for suggestions, red for bugs
  };

  const filteredReports = bugReports?.filter((report: any) => {
    const matchesSearch = 
      report.title?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      report.description?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      report.user_email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      report.user_name?.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesStatus = statusFilter === 'all' || report.status === statusFilter;
    const matchesPriority = priorityFilter === 'all' || report.priority === priorityFilter;
    const matchesType = typeFilter === 'all' || getReportType(report) === typeFilter;

    return matchesSearch && matchesStatus && matchesPriority && matchesType;
  });

  // Sort filtered reports
  const sortedReports = [...(filteredReports || [])].sort((a: any, b: any) => {
    let comparison = 0;
    
    switch (sortBy) {
      case 'date':
        comparison = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        break;
      case 'priority':
        const priorityOrder: { [key: string]: number } = { critical: 4, high: 3, medium: 2, low: 1 };
        comparison = (priorityOrder[a.priority] || 0) - (priorityOrder[b.priority] || 0);
        break;
      case 'status':
        const statusOrder: { [key: string]: number } = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
        comparison = (statusOrder[a.status] || 0) - (statusOrder[b.status] || 0);
        break;
      case 'type':
        comparison = getReportType(a).localeCompare(getReportType(b));
        break;
      default:
        comparison = 0;
    }
    
    return sortOrder === 'asc' ? comparison : -comparison;
  });

  const handleStatusChange = (id: string, newStatus: string) => {
    const updates: any = { status: newStatus };
    if (newStatus === 'resolved' || newStatus === 'closed') {
      updates.resolved_at = new Date().toISOString();
      updates.resolved_by = user?.id;
    }
    updateMutation.mutate({ id, updates });
  };

  const handleViewDetails = (report: any) => {
    setSelectedReport(report);
    setNotes(report.notes || '');
    setShowDetailsModal(true);
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
        <h1>Feedback & Issues</h1>
      </div>

      <div className="card" style={{ marginBottom: '20px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: '15px', marginBottom: '20px' }}>
          <input
            type="text"
            className="input"
            placeholder="Search by title, description, or user..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <select
            className="input"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="all">All Types</option>
            <option value="bug">Bugs</option>
            <option value="suggestion">Suggestions</option>
          </select>
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

        <div style={{ display: 'flex', gap: '15px', marginBottom: '20px', alignItems: 'center' }}>
          <label style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>Sort by:</label>
          <select
            className="input"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            style={{ width: '150px' }}
          >
            <option value="date">Date</option>
            <option value="priority">Priority</option>
            <option value="status">Status</option>
            <option value="type">Type</option>
          </select>
          <button
            className="button button-secondary"
            onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
            style={{ padding: '8px 12px', fontSize: '14px' }}
          >
            {sortOrder === 'asc' ? '↑ Ascending' : '↓ Descending'}
          </button>
        </div>

        {isLoading ? (
          <div style={{ textAlign: 'center', padding: '40px' }}>Loading feedback...</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Title</th>
                <th>User</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Created</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedReports && sortedReports.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '20px' }}>
                    No feedback found.
                  </td>
                </tr>
              )}
              {sortedReports?.map((report: any) => {
                const reportType = getReportType(report);
                const typeColor = getTypeColor(report);
                const displayTitle = report.title?.replace(/^\[Suggestion\]\s*/, '') || report.title;
                
                return (
                <tr 
                  key={report.id}
                  style={{
                    borderLeft: `4px solid ${typeColor}`,
                  }}
                >
                  <td>
                    <span style={{
                      backgroundColor: typeColor,
                      color: 'white',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 'bold',
                      textTransform: 'uppercase',
                    }}>
                      {reportType === 'suggestion' ? '💡' : '🐛'} {reportType}
                    </span>
                  </td>
                  <td>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>{displayTitle}</div>
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
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      <button
                        className="button button-secondary"
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                        onClick={() => handleViewDetails(report)}
                      >
                        View Details
                      </button>
                      {report.status !== 'resolved' && report.status !== 'closed' && (
                        <button
                          className="button"
                          style={{ 
                            padding: '4px 8px', 
                            fontSize: '12px',
                            backgroundColor: 'var(--success-color)',
                            color: 'white',
                            border: 'none'
                          }}
                          onClick={() => {
                            if (window.confirm('Mark this bug as resolved?')) {
                              handleMarkResolved(report);
                            }
                          }}
                        >
                          Mark Resolved
                        </button>
                      )}
                      {report.status === 'resolved' && (
                        <button
                          className="button"
                          style={{ 
                            padding: '4px 8px', 
                            fontSize: '12px',
                            backgroundColor: 'var(--text-tertiary)',
                            color: 'white',
                            border: 'none'
                          }}
                          onClick={() => {
                            if (window.confirm('Close this bug report?')) {
                              handleMarkClosed(report);
                            }
                          }}
                        >
                          Close
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Details Modal */}
      {showDetailsModal && selectedReport && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '20px',
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setModalMouseDownPos({ x: e.clientX, y: e.clientY });
            }
          }}
          onMouseUp={(e) => {
            if (e.target === e.currentTarget && modalMouseDownPos) {
              const moved = Math.abs(e.clientX - modalMouseDownPos.x) > 5 || Math.abs(e.clientY - modalMouseDownPos.y) > 5;
              if (!moved) {
                setShowDetailsModal(false);
                setSelectedReport(null);
                setNotes('');
              }
              setModalMouseDownPos(null);
            }
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div
            className="card"
            style={{
              maxWidth: '700px',
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
              position: 'relative',
              backgroundColor: 'var(--bg-primary)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <h2>Feedback Details</h2>
                {selectedReport && (
                  <span style={{
                    backgroundColor: getTypeColor(selectedReport),
                    color: 'white',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    textTransform: 'uppercase',
                  }}>
                    {isSuggestion(selectedReport) ? '💡 Suggestion' : '🐛 Bug'}
                  </span>
                )}
              </div>
              <button
                className="button button-secondary"
                onClick={() => {
                  setShowDetailsModal(false);
                  setSelectedReport(null);
                  setNotes('');
                }}
                style={{ padding: '5px 10px', fontSize: '14px' }}
              >
                ✕
              </button>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <div style={{ marginBottom: '15px' }}>
                <label className="label">Title</label>
                <div style={{ 
                  padding: '10px', 
                  backgroundColor: 'var(--bg-secondary)', 
                  borderRadius: '4px',
                  fontWeight: '500',
                  borderLeft: `4px solid ${getTypeColor(selectedReport)}`
                }}>
                  {selectedReport.title?.replace(/^\[Suggestion\]\s*/, '') || selectedReport.title}
                </div>
              </div>

              <div style={{ marginBottom: '15px' }}>
                <label className="label">Description</label>
                <div style={{ 
                  padding: '10px', 
                  backgroundColor: 'var(--bg-secondary)', 
                  borderRadius: '4px',
                  whiteSpace: 'pre-wrap',
                  maxHeight: '200px',
                  overflowY: 'auto'
                }}>
                  {selectedReport.description}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                <div>
                  <label className="label">Priority</label>
                  <div>
                    <span style={{
                      backgroundColor: getPriorityColor(selectedReport.priority),
                      color: 'white',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '12px',
                      fontWeight: 'bold',
                      textTransform: 'uppercase',
                    }}>
                      {selectedReport.priority}
                    </span>
                  </div>
                </div>
                <div>
                  <label className="label">Status</label>
                  <div>
                    <span style={{
                      backgroundColor: getStatusColor(selectedReport.status),
                      color: 'white',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '12px',
                      fontWeight: 'bold',
                      textTransform: 'uppercase',
                    }}>
                      {selectedReport.status}
                    </span>
                  </div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                <div>
                  <label className="label">Reported By</label>
                  <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                    {selectedReport.user_name || 'Anonymous'}
                    {selectedReport.user_email && (
                      <div style={{ fontSize: '12px', marginTop: '4px' }}>
                        {selectedReport.user_email}
                      </div>
                    )}
                  </div>
                </div>
                <div>
                  <label className="label">Created</label>
                  <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                    {new Date(selectedReport.created_at).toLocaleString()}
                  </div>
                </div>
              </div>

              {selectedReport.resolved_at && (
                <div style={{ marginBottom: '15px' }}>
                  <label className="label">Resolved</label>
                  <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                    {new Date(selectedReport.resolved_at).toLocaleString()}
                  </div>
                </div>
              )}

              <div style={{ marginBottom: '15px' }}>
                <label className="label">Admin Notes</label>
                <textarea
                  className="input"
                  rows={4}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Add notes about this feedback..."
                  style={{ width: '100%', resize: 'none' }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                className="button button-secondary"
                onClick={() => {
                  setShowDetailsModal(false);
                  setSelectedReport(null);
                  setNotes('');
                }}
              >
                Cancel
              </button>
              {selectedReport.status !== 'resolved' && selectedReport.status !== 'closed' && (
                <button
                  className="button"
                  style={{ 
                    backgroundColor: 'var(--success-color)',
                    color: 'white',
                    border: 'none'
                  }}
                  onClick={() => handleMarkResolved(selectedReport)}
                  disabled={updateMutation.isPending}
                >
                  {updateMutation.isPending ? 'Saving...' : 'Mark as Resolved'}
                </button>
              )}
              {selectedReport.status === 'resolved' && (
                <button
                  className="button"
                  style={{ 
                    backgroundColor: 'var(--text-tertiary)',
                    color: 'white',
                    border: 'none'
                  }}
                  onClick={() => handleMarkClosed(selectedReport)}
                  disabled={updateMutation.isPending}
                >
                  {updateMutation.isPending ? 'Saving...' : 'Close'}
                </button>
              )}
              <button
                className="button button-primary"
                onClick={() => {
                  if (notes.trim() !== (selectedReport.notes || '')) {
                    updateMutation.mutate({ 
                      id: selectedReport.id, 
                      updates: { notes: notes.trim() } 
                    });
                  } else {
                    setShowDetailsModal(false);
                    setSelectedReport(null);
                    setNotes('');
                  }
                }}
                disabled={updateMutation.isPending}
              >
                {updateMutation.isPending ? 'Saving...' : 'Save Notes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

