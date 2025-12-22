import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';

interface TimeEntry {
  id: string;
  projectId?: string;
  startTime?: string;
  endTime?: string;
  hours: number;
  rate: number;
  billable: boolean;
  description?: string;
  project?: any;
}

export default function DayDetail() {
  const { date } = useParams<{ date: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  
  const [selectedDate] = useState(date ? new Date(date) : new Date());
  
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null);
  const [showEntryForm, setShowEntryForm] = useState(false);
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const [formData, setFormData] = useState({
    projectId: '',
    startTime: '',
    endTime: '',
    hours: '',
    rate: '',
    billable: true,
    description: '',
  });

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: async () => {
      const response = await axios.get('/api/projects');
      return response.data;
    },
  });

  const { data: timeEntries } = useQuery({
    queryKey: ['timeEntries', 'day', date],
    queryFn: async () => {
      const startOfDay = new Date(selectedDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(selectedDate);
      endOfDay.setHours(23, 59, 59, 999);
      
      const response = await axios.get(
        `/api/time-entries?startDate=${startOfDay.toISOString()}&endDate=${endOfDay.toISOString()}`
      );
      return response.data || [];
    },
  });

  // Handle timer data from URL params
  useEffect(() => {
    const timerElapsed = searchParams.get('timer');
    const timerProjectId = searchParams.get('projectId');
    
    if (timerElapsed && timerProjectId && projects) {
      const hours = parseFloat(timerElapsed) / (1000 * 60 * 60);
      const project = projects.find((p: any) => p.id === timerProjectId);
      
      setFormData({
        projectId: timerProjectId,
        startTime: `${selectedDate.toISOString().split('T')[0]}T09:00`,
        endTime: `${selectedDate.toISOString().split('T')[0]}T${(9 + Math.ceil(hours)).toString().padStart(2, '0')}:00`,
        hours: hours.toFixed(2),
        rate: project?.rate?.toString() || '',
        billable: true,
        description: '',
      });
      
      setShowEntryForm(true);
      
      // Clean URL params
      navigate(`/calendar/${date}`, { replace: true });
    }
  }, [searchParams, date, navigate, projects, selectedDate]);

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const response = await axios.post('/api/time-entries', data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const response = await axios.put(`/api/time-entries/${id}`, data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
      resetForm();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await axios.delete(`/api/time-entries/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
    },
  });

  const resetForm = () => {
    setFormData({
      projectId: '',
      startTime: '',
      endTime: '',
      hours: '',
      rate: '',
      billable: true,
      description: '',
    });
    setEditingEntry(null);
    setShowEntryForm(false);
    setSelectedHour(null);
  };

  const handleHourClick = (hour: number) => {
    setSelectedHour(hour);
    const startTime = `${hour.toString().padStart(2, '0')}:00`;
    const endTime = `${(hour + 1).toString().padStart(2, '0')}:00`;
    
    setFormData({
      projectId: '',
      startTime: `${selectedDate.toISOString().split('T')[0]}T${startTime}`,
      endTime: `${selectedDate.toISOString().split('T')[0]}T${endTime}`,
      hours: '1',
      rate: '',
      billable: true,
      description: '',
    });
    setShowEntryForm(true);
  };

  const handleEditEntry = (entry: TimeEntry) => {
    setEditingEntry(entry);
    setFormData({
      projectId: entry.projectId || '',
      startTime: entry.startTime ? new Date(entry.startTime).toISOString().slice(0, 16) : '',
      endTime: entry.endTime ? new Date(entry.endTime).toISOString().slice(0, 16) : '',
      hours: entry.hours.toString(),
      rate: entry.rate.toString(),
      billable: entry.billable,
      description: entry.description || '',
    });
    setShowEntryForm(true);
  };

  const handleDeleteEntry = (id: string) => {
    if (window.confirm('Are you sure you want to delete this time entry?')) {
      deleteMutation.mutate(id);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    const entryDate = selectedDate.toISOString().split('T')[0];
    const data = {
      ...formData,
      date: entryDate,
      hours: parseFloat(formData.hours) || 0,
      rate: parseFloat(formData.rate) || 0,
      startTime: formData.startTime || null,
      endTime: formData.endTime || null,
    };

    if (editingEntry) {
      updateMutation.mutate({ id: editingEntry.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const getEntryForHour = (hour: number): TimeEntry[] => {
    if (!timeEntries) return [];
    
    return timeEntries.filter((entry: TimeEntry) => {
      if (!entry.startTime) return false;
      const entryHour = new Date(entry.startTime).getHours();
      const entryEndHour = entry.endTime ? new Date(entry.endTime).getHours() : entryHour + Math.ceil(entry.hours);
      return hour >= entryHour && hour < entryEndHour;
    });
  };

  const formatTime = (timeString: string) => {
    if (!timeString) return '';
    const date = new Date(timeString);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  };

  const getHourLabel = (hour: number) => {
    const period = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
    return `${displayHour}:00 ${period}`;
  };

  const hours = Array.from({ length: 24 }, (_, i) => i);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <button className="button button-secondary" onClick={() => navigate('/calendar')} style={{ marginRight: '10px' }}>
            ← Back to Calendar
          </button>
          <h2>{selectedDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</h2>
        </div>
        <button className="button button-primary" onClick={() => {
          resetForm();
          setShowEntryForm(true);
        }}>
          + Add Time Entry
        </button>
      </div>

      {/* 24-Hour Timeline */}
      <div className="card">
        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '10px' }}>
          {/* Hour labels */}
          <div></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 10px', marginBottom: '10px', fontWeight: 'bold' }}>
            <span>Time Slots</span>
            <span>Total: {timeEntries?.reduce((sum: number, e: TimeEntry) => sum + e.hours, 0).toFixed(2) || '0'} hours</span>
          </div>

          {hours.map((hour) => {
            const entries = getEntryForHour(hour);
            const hourEntries = entries.filter((e: TimeEntry) => {
              if (!e.startTime) return false;
              const entryHour = new Date(e.startTime).getHours();
              return entryHour === hour;
            });

            return (
              <div key={hour} style={{ display: 'contents' }}>
                {/* Hour label */}
                <div
                  style={{
                    padding: '10px',
                    borderRight: '1px solid var(--border-color)',
                    fontWeight: '500',
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                  }}
                >
                  {getHourLabel(hour)}
                </div>

                {/* Time slot */}
                <div
                  onClick={() => handleHourClick(hour)}
                  style={{
                    minHeight: '60px',
                    padding: '8px',
                    border: '1px solid var(--border-color)',
                    borderRadius: '4px',
                    marginBottom: '8px',
                    cursor: 'pointer',
                    backgroundColor: entries.length > 0 ? 'rgba(0, 123, 255, 0.1)' : 'var(--bg-primary)',
                    transition: 'background-color 0.2s',
                    position: 'relative',
                  }}
                  onMouseEnter={(e) => {
                    if (entries.length === 0) {
                      e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (entries.length === 0) {
                      e.currentTarget.style.backgroundColor = 'var(--bg-primary)';
                    }
                  }}
                >
                  {hourEntries.length === 0 ? (
                    <div style={{ color: 'var(--text-tertiary)', fontSize: '14px' }}>
                      Click to add time entry
                    </div>
                  ) : (
                    hourEntries.map((entry: TimeEntry) => (
                      <div
                        key={entry.id}
                        style={{
                          backgroundColor: 'var(--bg-secondary)',
                          padding: '8px',
                          borderRadius: '4px',
                          marginBottom: '4px',
                          border: '1px solid var(--border-color)',
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEditEntry(entry);
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>
                              {entry.project?.name || 'No Project'}
                            </div>
                            {entry.startTime && entry.endTime && (
                              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                                {formatTime(entry.startTime)} - {formatTime(entry.endTime)}
                              </div>
                            )}
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                              {entry.hours}h @ ${entry.rate}/hr = ${(entry.hours * entry.rate).toFixed(2)}
                              {entry.billable && <span style={{ marginLeft: '8px', color: '#28a745' }}>● Billable</span>}
                            </div>
                            {entry.description && (
                              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px', fontStyle: 'italic' }}>
                                {entry.description}
                              </div>
                            )}
                          </div>
                          <button
                            className="button button-danger"
                            style={{ padding: '4px 8px', fontSize: '12px', marginLeft: '8px' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteEntry(entry.id);
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Time Entry Form Modal */}
      {showEntryForm && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 1000,
          }}
          onClick={resetForm}
        >
          <div
            className="card"
            style={{ width: '600px', maxWidth: '90vw', maxHeight: '90vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>{editingEntry ? 'Edit Time Entry' : 'Add Time Entry'}</h3>
            
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label className="label">Project</label>
                <select
                  className="input"
                  value={formData.projectId}
                  onChange={(e) => {
                    const project = projects?.find((p: any) => p.id === e.target.value);
                    setFormData({
                      ...formData,
                      projectId: e.target.value,
                      rate: project?.rate?.toString() || formData.rate,
                    });
                  }}
                  required
                >
                  <option value="">Select Project</option>
                  {projects?.map((project: any) => (
                    <option key={project.id} value={project.id}>
                      {project.name} - {project.customer?.name}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div className="form-group">
                  <label className="label">Start Time</label>
                  <input
                    type="datetime-local"
                    className="input"
                    value={formData.startTime}
                    onChange={(e) => setFormData({ ...formData, startTime: e.target.value })}
                  />
                </div>

                <div className="form-group">
                  <label className="label">End Time</label>
                  <input
                    type="datetime-local"
                    className="input"
                    value={formData.endTime}
                    onChange={(e) => setFormData({ ...formData, endTime: e.target.value })}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div className="form-group">
                  <label className="label">Hours</label>
                  <input
                    type="number"
                    step="0.25"
                    className="input"
                    value={formData.hours}
                    onChange={(e) => setFormData({ ...formData, hours: e.target.value })}
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="label">Rate ($/hr)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    value={formData.rate}
                    onChange={(e) => setFormData({ ...formData, rate: e.target.value })}
                    required
                  />
                </div>
              </div>

              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <input
                    type="checkbox"
                    checked={formData.billable}
                    onChange={(e) => setFormData({ ...formData, billable: e.target.checked })}
                  />
                  Billable to Client
                </label>
              </div>

              <div className="form-group">
                <label className="label">Description</label>
                <textarea
                  className="input"
                  rows={4}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="What did you work on?"
                />
              </div>

              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={resetForm}
                >
                  Cancel
                </button>
                <button type="submit" className="button button-primary">
                  {editingEntry ? 'Update' : 'Create'} Time Entry
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

