import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { timeEntriesService, projectsService } from '../services/supabaseServices';

export default function TimeEntries() {
  const { user } = useAuth();
  const { isDemoMode } = useDemoMode();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingEntry, setEditingEntry] = useState<any>(null);
  const [formData, setFormData] = useState({
    project_id: '',
    date: new Date().toISOString().split('T')[0],
    start_time: '',
    end_time: '',
    hours: '',
    rate: '',
    billable: true,
    description: '',
  });

  const { data: timeEntries, isLoading: isLoadingEntries } = useQuery({
    queryKey: ['timeEntries', isDemoMode, user?.id],
    queryFn: () => timeEntriesService.getAll(isDemoMode, user?.id),
  });

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => projectsService.getAll(),
  });

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      if (!user) throw new Error('Not authenticated');
      
      // Map form fields to database columns (snake_case)
      const entryData = {
        user_id: user.id,
        project_id: data.project_id || null,
        date: data.date,
        start_time: data.start_time || null,
        end_time: data.end_time || null,
        hours: parseFloat(data.hours),
        rate: parseFloat(data.rate || 0),
        billable: data.billable !== undefined ? data.billable : true,
        description: data.description || null,
        is_demo: isDemoMode, // Mark as demo entry if in demo mode
      };

      return await timeEntriesService.create(entryData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
      setShowForm(false);
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const entryData: any = {};
      if (data.project_id !== undefined) entryData.project_id = data.project_id || null;
      if (data.date !== undefined) entryData.date = data.date;
      if (data.start_time !== undefined) entryData.start_time = data.start_time || null;
      if (data.end_time !== undefined) entryData.end_time = data.end_time || null;
      if (data.hours !== undefined) entryData.hours = parseFloat(data.hours);
      if (data.rate !== undefined) entryData.rate = parseFloat(data.rate);
      if (data.billable !== undefined) entryData.billable = data.billable;
      if (data.description !== undefined) entryData.description = data.description || null;

      return await timeEntriesService.update(id, entryData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
      setEditingEntry(null);
      resetForm();
    },
  });

  const deleteMutation = useMutation({
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
      date: new Date().toISOString().split('T')[0],
      start_time: '',
      end_time: '',
      hours: '',
      rate: '',
      billable: true,
      description: '',
    });
  };

  const handleEdit = (entry: any) => {
    setEditingEntry(entry);
    setFormData({
      project_id: entry.project_id || '',
      date: entry.date ? new Date(entry.date).toISOString().split('T')[0] : '',
      start_time: entry.start_time ? new Date(entry.start_time).toISOString().slice(0, 16) : '',
      end_time: entry.end_time ? new Date(entry.end_time).toISOString().slice(0, 16) : '',
      hours: entry.hours?.toString() || '',
      rate: entry.rate?.toString() || '',
      billable: entry.billable,
      description: entry.description || '',
    });
    setShowForm(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingEntry) {
      updateMutation.mutate({ id: editingEntry.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const handleDelete = (id: string) => {
    if (window.confirm('Are you sure you want to delete this time entry?')) {
      deleteMutation.mutate(id);
    }
  };

  // Transform data for display (handle nested relations)
  const displayEntries = timeEntries?.map((entry: any) => ({
    ...entry,
    project: entry.project || null,
    customer: entry.project?.customer || null,
  }));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2>Time Entries</h2>
        <button className="button button-primary" onClick={() => { setShowForm(!showForm); setEditingEntry(null); resetForm(); }}>
          {showForm ? 'Cancel' : 'Add Time Entry'}
        </button>
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: '20px' }}>
          <h3>{editingEntry ? 'Edit Time Entry' : 'New Time Entry'}</h3>
          <form onSubmit={handleSubmit}>
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
                    {project.name} - {project.customer?.name || 'No Customer'}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label className="label">Date</label>
              <input
                type="date"
                className="input"
                value={formData.date}
                onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                required
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">Start Time</label>
                <input
                  type="datetime-local"
                  className="input"
                  value={formData.start_time}
                  onChange={(e) => setFormData({ ...formData, start_time: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label className="label">End Time</label>
                <input
                  type="datetime-local"
                  className="input"
                  value={formData.end_time}
                  onChange={(e) => setFormData({ ...formData, end_time: e.target.value })}
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
                rows={3}
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              />
            </div>

            <button type="submit" className="button button-primary" disabled={createMutation.isPending || updateMutation.isPending}>
              {editingEntry ? 'Update' : 'Create'} Time Entry
            </button>
          </form>
        </div>
      )}

      <div className="card">
        {isLoadingEntries ? (
          <p>Loading...</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Project</th>
                <th>Hours</th>
                <th>Rate</th>
                <th>Total</th>
                <th>Billable</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayEntries && displayEntries.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '20px' }}>
                    No time entries found. Create your first entry above.
                  </td>
                </tr>
              )}
              {displayEntries?.map((entry: any) => (
                <tr key={entry.id}>
                  <td>{entry.date ? new Date(entry.date).toLocaleDateString() : '-'}</td>
                  <td>{entry.project?.name || 'No Project'}</td>
                  <td>{entry.hours}</td>
                  <td>${entry.rate?.toFixed(2)}</td>
                  <td>${((entry.hours || 0) * (entry.rate || 0)).toFixed(2)}</td>
                  <td>{entry.billable ? 'Yes' : 'Internal'}</td>
                  <td>{entry.approved ? 'Approved' : 'Pending'}</td>
                  <td>
                    {!entry.approved && (
                      <>
                        <button
                          className="button button-secondary"
                          style={{ marginRight: '5px', padding: '5px 10px', fontSize: '12px' }}
                          onClick={() => handleEdit(entry)}
                        >
                          Edit
                        </button>
                        <button
                          className="button button-danger"
                          style={{ padding: '5px 10px', fontSize: '12px' }}
                          onClick={() => handleDelete(entry.id)}
                        >
                          Delete
                        </button>
                      </>
                    )}
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
