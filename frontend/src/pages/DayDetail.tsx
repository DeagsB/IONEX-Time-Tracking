import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { timeEntriesService, projectsService } from '../services/supabaseServices';

interface TimeEntry {
  id: string;
  date?: string;
  project_id?: string;
  start_time?: string;
  end_time?: string;
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
  const { isDemoMode } = useDemoMode();
  const queryClient = useQueryClient();
  
  const [selectedDate] = useState(date ? new Date(date) : new Date());
  
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null);
  const [showEntryForm, setShowEntryForm] = useState(false);
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const [formData, setFormData] = useState({
    project_id: '',
    hours: '1',
    description: '',
    start_time: '',
    end_time: '',
  });

  const { data: projects } = useQuery({
    queryKey: ['projects', user?.id],
    queryFn: () => projectsService.getAll(user?.id),
  });

  const { data: timeEntries } = useQuery({
    queryKey: ['timeEntries', 'day', date, user?.id],
    queryFn: async () => {
      // Fetch entries filtered by user_id for privacy - even admins only see their own entries
      const entries = await timeEntriesService.getAll(undefined, user?.id);
      return entries?.filter((entry: any) => entry.date === date);
    },
  });

  const createEntryMutation = useMutation({
    mutationFn: async (data: any) => {
      if (!user) throw new Error("No user");
      
      const entryData: any = {
        user_id: user.id,
        project_id: data.project_id || null,
        date: date,
        start_time: data.start_time || null,
        end_time: data.end_time || null,
        hours: parseFloat(data.hours),
        rate: 0, // Should fetch project rate
        billable: true,
        description: data.description || null,
        is_demo: isDemoMode, // Mark as demo entry if in demo mode
      };
      
      // Get project rate if project selected
      if (data.project_id && projects) {
        const project = projects.find((p: any) => p.id === data.project_id);
        if (project) entryData.rate = project.rate;
      }
      
      return await timeEntriesService.create(entryData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
      setShowEntryForm(false);
      resetForm();
    },
  });

  const updateEntryMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      return await timeEntriesService.update(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
      setEditingEntry(null);
      resetForm();
    },
  });

  const deleteEntryMutation = useMutation({
    mutationFn: async (id: string) => {
      await timeEntriesService.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
    },
  });

  const resetForm = () => {
    setFormData({
      project_id: '',
      hours: '1',
      description: '',
      start_time: '',
      end_time: '',
    });
    setEditingEntry(null);
    setSelectedHour(null);
  };

  const handleHourClick = (hour: number) => {
    setSelectedHour(hour);
    const startTime = new Date(selectedDate);
    startTime.setHours(hour, 0, 0, 0);
    const endTime = new Date(startTime);
    endTime.setHours(hour + 1);

    setFormData({
      ...formData,
      start_time: startTime.toTimeString().slice(0, 5),
      end_time: endTime.toTimeString().slice(0, 5),
      hours: '1',
    });
    setShowEntryForm(true);
  };

  const handleEditEntry = (entry: any) => {
    setEditingEntry(entry);
    const startTime = entry.start_time ? new Date(entry.start_time) : null;
    const endTime = entry.end_time ? new Date(entry.end_time) : null;

    setFormData({
      project_id: entry.project_id || '',
      hours: entry.hours.toString(),
      description: entry.description || '',
      start_time: startTime ? startTime.toTimeString().slice(0, 5) : '',
      end_time: endTime ? endTime.toTimeString().slice(0, 5) : '',
    });
    setShowEntryForm(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Construct ISO strings for start/end times if provided
    let startTimeISO = null;
    let endTimeISO = null;
    
    if (formData.start_time) {
      const start = new Date(selectedDate);
      const [sh, sm] = formData.start_time.split(':').map(Number);
      start.setHours(sh, sm, 0, 0);
      startTimeISO = start.toISOString();
    }
    
    if (formData.end_time) {
      const end = new Date(selectedDate);
      const [eh, em] = formData.end_time.split(':').map(Number);
      end.setHours(eh, em, 0, 0);
      endTimeISO = end.toISOString();
    }

    const data: any = {
      project_id: formData.project_id,
      hours: formData.hours,
      description: formData.description,
      start_time: startTimeISO,
      end_time: endTimeISO,
    };

    // When editing, ensure the date is preserved to prevent entry from disappearing
    if (editingEntry) {
      // Preserve the original date to avoid timezone issues
      // Use entry date if available, otherwise use the date from URL params
      data.date = editingEntry.date || date;
      updateEntryMutation.mutate({ id: editingEntry.id, data });
    } else {
      createEntryMutation.mutate(data);
    }
  };

  const handleDelete = (id: string) => {
    if (window.confirm('Are you sure?')) {
      deleteEntryMutation.mutate(id);
    }
  };

  // Generate time slots
  const hours = Array.from({ length: 24 }, (_, i) => i);

  return (
    <div style={{ height: 'calc(100vh - 100px)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <button 
            className="button"
            onClick={() => navigate('/calendar')}
          >
            ← Back to Week
          </button>
          <h2>
            {selectedDate.toLocaleDateString('en-US', { 
              weekday: 'long', 
              year: 'numeric', 
              month: 'long', 
              day: 'numeric' 
            })}
          </h2>
        </div>
        <button 
          className="button button-primary"
          onClick={() => {
            resetForm();
            setShowEntryForm(true);
          }}
        >
          Add Entry
        </button>
      </div>

      <div style={{ display: 'flex', gap: '20px', flex: 1, minHeight: 0 }}>
        {/* Time Grid */}
        <div className="card" style={{ flex: 1, overflowY: 'auto', padding: 0, display: 'flex', flexDirection: 'column' }}>
          {hours.map((hour) => (
            <div 
              key={hour}
              style={{
                height: '60px',
                borderBottom: '1px solid var(--border-color)',
                display: 'flex',
                position: 'relative',
              }}
            >
              <div style={{
                width: '60px',
                borderRight: '1px solid var(--border-color)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '12px',
                color: 'var(--text-secondary)',
                flexShrink: 0,
              }}>
                {hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`}
              </div>
              <div 
                style={{ flex: 1, cursor: 'pointer' }}
                onClick={() => handleHourClick(hour)}
              >
                {/* Render entries for this hour */}
                {timeEntries?.filter((entry: any) => {
                  if (!entry.start_time) return false;
                  const entryHour = new Date(entry.start_time).getHours();
                  return entryHour === hour;
                }).map((entry: any) => (
                  <div
                    key={entry.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleEditEntry(entry);
                    }}
                    style={{
                      position: 'absolute',
                      top: '2px',
                      left: '5px',
                      right: '5px',
                      bottom: '2px',
                      backgroundColor: 'var(--primary-light)',
                      border: '1px solid var(--primary-color)',
                      borderRadius: '4px',
                      padding: '4px 8px',
                      fontSize: '12px',
                      overflow: 'hidden',
                      cursor: 'pointer',
                      zIndex: 10,
                    }}
                  >
                    <strong>{entry.project?.name || 'No Project'}</strong>
                    {entry.description && <span style={{ marginLeft: '5px' }}>- {entry.description}</span>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Entry Form Sidebar */}
        {showEntryForm && (
          <div className="card" style={{ width: '300px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
              <h3>{editingEntry ? 'Edit Entry' : 'New Entry'}</h3>
              <button 
                className="button" 
                style={{ padding: '4px 8px' }}
                onClick={() => {
                  setShowEntryForm(false);
                  resetForm();
                }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div className="form-group">
                <label className="label">Project</label>
                <select
                  className="input"
                  value={formData.project_id}
                  onChange={(e) => setFormData({ ...formData, project_id: e.target.value })}
                >
                  <option value="">Select Project</option>
                  {projects?.map((project: any) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div className="form-group">
                  <label className="label">Start</label>
                  <input
                    type="time"
                    className="input"
                    value={formData.start_time}
                    onChange={(e) => setFormData({ ...formData, start_time: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="label">End</label>
                  <input
                    type="time"
                    className="input"
                    value={formData.end_time}
                    onChange={(e) => setFormData({ ...formData, end_time: e.target.value })}
                  />
                </div>
              </div>

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
                <label className="label">Description</label>
                <textarea
                  className="input"
                  rows={3}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                />
              </div>

              <div style={{ display: 'flex', gap: '10px', marginTop: 'auto' }}>
                <button type="submit" className="button button-primary" style={{ flex: 1 }}>
                  Save
                </button>
                {editingEntry && (
                  <button 
                    type="button" 
                    className="button button-danger"
                    onClick={() => handleDelete(editingEntry.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
