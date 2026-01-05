import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { projectsService, customersService } from '../services/supabaseServices';

export default function Projects() {
  const { user } = useAuth();
  const { isDemoMode } = useDemoMode();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingProject, setEditingProject] = useState<any>(null);
  const [formData, setFormData] = useState({
    name: '',
    project_number: '',
    description: '',
    customer_id: '',
    status: 'active',
    start_date: '',
    end_date: '',
    budget: '',
    color: '#4ecdc4',
    is_private: false,
  });

  const { data: projects } = useQuery({
    queryKey: ['projects', user?.id],
    queryFn: () => projectsService.getAll(user?.id),
  });

  const { data: customers } = useQuery({
    queryKey: ['customers', user?.id],
    queryFn: () => customersService.getAll(user?.id),
  });

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const projectData: any = {
        name: data.name,
        project_number: data.project_number || null,
        description: data.description || null,
        customer_id: data.customer_id || null,
        status: data.status,
        start_date: data.start_date || null,
        end_date: data.end_date || null,
        budget: data.budget ? parseFloat(data.budget) : null,
        color: data.color || '#4ecdc4',
        is_private: data.is_private || false,
        is_demo: isDemoMode, // Mark as demo project if in demo mode
      };
      return await projectsService.create(projectData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setShowForm(false);
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const projectData: any = {};
      if (data.name !== undefined) projectData.name = data.name;
      if (data.project_number !== undefined) projectData.project_number = data.project_number || null;
      if (data.description !== undefined) projectData.description = data.description || null;
      if (data.customer_id !== undefined) projectData.customer_id = data.customer_id || null;
      if (data.status !== undefined) projectData.status = data.status;
      if (data.start_date !== undefined) projectData.start_date = data.start_date || null;
      if (data.end_date !== undefined) projectData.end_date = data.end_date || null;
      if (data.budget !== undefined) projectData.budget = data.budget ? parseFloat(data.budget) : null;
      if (data.color !== undefined) projectData.color = data.color;
      if (data.is_private !== undefined) projectData.is_private = data.is_private;

      return await projectsService.update(id, projectData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setEditingProject(null);
      resetForm();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await projectsService.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const resetForm = () => {
    setFormData({
      name: '',
      project_number: '',
      description: '',
      customer_id: '',
      status: 'active',
      start_date: '',
      end_date: '',
      budget: '',
      color: '#4ecdc4',
      is_private: false,
    });
  };

  const handleEdit = (project: any) => {
    setEditingProject(project);
    setFormData({
      name: project.name || '',
      project_number: project.project_number || '',
      description: project.description || '',
      customer_id: project.customer_id || '',
      status: project.status || 'active',
      start_date: project.start_date ? new Date(project.start_date).toISOString().split('T')[0] : '',
      end_date: project.end_date ? new Date(project.end_date).toISOString().split('T')[0] : '',
      budget: project.budget?.toString() || '',
      color: project.color || '#4ecdc4',
      is_private: project.is_private || false,
    });
    setShowForm(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingProject) {
      updateMutation.mutate({ id: editingProject.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const handleDelete = (id: string) => {
    if (window.confirm('Are you sure you want to delete this project?')) {
      deleteMutation.mutate(id);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2>Projects</h2>
        <button className="button button-primary" onClick={() => { setShowForm(!showForm); setEditingProject(null); resetForm(); }}>
          {showForm ? 'Cancel' : 'Add Project'}
        </button>
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: '20px' }}>
          <h3>{editingProject ? 'Edit Project' : 'New Project'}</h3>
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">Name</label>
                <input
                  type="text"
                  className="input"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                />
              </div>

              <div className="form-group">
                <label className="label">Project Number (Job ID)</label>
                <input
                  type="text"
                  className="input"
                  value={formData.project_number}
                  onChange={(e) => setFormData({ ...formData, project_number: e.target.value })}
                  placeholder="e.g., PRJ-001"
                />
              </div>
            </div>

            <div className="form-group">
              <label className="label">Customer</label>
              <select
                className="input"
                value={formData.customer_id}
                onChange={(e) => setFormData({ ...formData, customer_id: e.target.value })}
                required
              >
                <option value="">Select Customer</option>
                {customers?.map((customer: any) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                  </option>
                ))}
              </select>
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

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">Status</label>
                <select
                  className="input"
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                >
                  <option value="active">Active</option>
                  <option value="completed">Completed</option>
                  <option value="on-hold">On Hold</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>

              <div className="form-group">
                <label className="label">Start Date</label>
                <input
                  type="date"
                  className="input"
                  value={formData.start_date}
                  onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label className="label">End Date</label>
                <input
                  type="date"
                  className="input"
                  value={formData.end_date}
                  onChange={(e) => setFormData({ ...formData, end_date: e.target.value })}
                />
              </div>
            </div>

            <div className="form-group">
              <label className="label">Project Color</label>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <input
                  type="color"
                  value={formData.color}
                  onChange={(e) => setFormData({ ...formData, color: e.target.value })}
                  style={{
                    width: '60px',
                    height: '40px',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    cursor: 'pointer',
                  }}
                />
                <span style={{ 
                  fontSize: '14px', 
                  color: 'var(--text-secondary)',
                  fontFamily: 'monospace'
                }}>
                  {formData.color}
                </span>
              </div>
            </div>

            <div className="form-group">
              <label className="label">Budget</label>
              <input
                type="number"
                step="0.01"
                className="input"
                value={formData.budget}
                onChange={(e) => setFormData({ ...formData, budget: e.target.value })}
              />
            </div>

            <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <input
                type="checkbox"
                id="is_private"
                checked={formData.is_private}
                onChange={(e) => setFormData({ ...formData, is_private: e.target.checked })}
                style={{ width: '18px', height: '18px', cursor: 'pointer' }}
              />
              <label htmlFor="is_private" style={{ cursor: 'pointer', margin: 0 }}>
                Make this project private (only visible to me)
              </label>
            </div>

            <button type="submit" className="button button-primary" disabled={createMutation.isPending || updateMutation.isPending}>
              {editingProject ? 'Update' : 'Create'} Project
            </button>
          </form>
        </div>
      )}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Project #</th>
              <th>Name</th>
              <th>Customer</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {projects && projects.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '20px' }}>
                  No projects found. Create your first project above.
                </td>
              </tr>
            )}
            {projects?.map((project: any) => (
              <tr key={project.id}>
                <td style={{ fontFamily: 'monospace', fontWeight: '600' }}>{project.project_number || '-'}</td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div
                      style={{
                        backgroundColor: project.color || '#4ecdc4',
                        width: '16px',
                        height: '16px',
                        borderRadius: '4px',
                        flexShrink: 0,
                        border: '1px solid rgba(0, 0, 0, 0.1)',
                      }}
                    />
                    <span>{project.name}</span>
                    {project.is_private && (
                      <span style={{
                        fontSize: '10px',
                        backgroundColor: 'var(--warning-color)',
                        color: 'white',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        fontWeight: '600',
                        textTransform: 'uppercase'
                      }}>
                        Private
                      </span>
                    )}
                  </div>
                </td>
                <td>{project.customer?.name || '-'}</td>
                <td>{project.status}</td>
                <td>
                  {(user?.id === project.created_by || user?.role === 'ADMIN' || !project.created_by) && (
                    <>
                      <button
                        className="button button-secondary"
                        style={{ marginRight: '5px', padding: '5px 10px', fontSize: '12px' }}
                        onClick={() => handleEdit(project)}
                      >
                        Edit
                      </button>
                      <button
                        className="button button-danger"
                        style={{ padding: '5px 10px', fontSize: '12px' }}
                        onClick={() => handleDelete(project.id)}
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
      </div>
    </div>
  );
}
