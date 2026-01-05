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
  const [showModal, setShowModal] = useState(false);
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [editingProject, setEditingProject] = useState<any>(null);
  const [newCustomerData, setNewCustomerData] = useState({
    name: '',
    email: '',
    phone: '',
  });
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
        is_demo: isDemoMode, // Mark as demo project if in demo mode
      };
      if (!user?.id) throw new Error('User not authenticated.');
      return await projectsService.create(projectData, user.id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setShowForm(false);
      setShowModal(false);
      setEditingProject(null);
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
      // is_private is always false, don't include it

      return await projectsService.update(id, projectData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setShowModal(false);
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

  const createCustomerMutation = useMutation({
    mutationFn: async (data: any) => {
      return await customersService.create({
        ...data,
        is_demo: isDemoMode,
      });
    },
    onSuccess: (newCustomer) => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setFormData({ ...formData, customer_id: newCustomer.id });
      setShowCustomerModal(false);
      setNewCustomerData({ name: '', email: '', phone: '' });
    },
    onError: (error: any) => {
      console.error('Error creating customer:', error);
      alert(`Failed to create customer: ${error.message || 'Unknown error'}`);
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
    });
    setShowModal(true);
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

      {/* Modal for editing */}
      {showModal && (
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
            zIndex: 1000,
            padding: '20px',
          }}
          onClick={() => {
            setShowModal(false);
            setEditingProject(null);
            resetForm();
          }}
        >
          <div
            className="card"
            style={{
              maxWidth: '800px',
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
              position: 'relative',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3>Edit Project</h3>
              <button
                className="button button-secondary"
                onClick={() => {
                  setShowModal(false);
                  setEditingProject(null);
                  resetForm();
                }}
                style={{ padding: '5px 10px', fontSize: '14px' }}
              >
                ✕
              </button>
            </div>
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
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                <select
                  className="input"
                  value={formData.customer_id}
                  onChange={(e) => setFormData({ ...formData, customer_id: e.target.value })}
                  required
                  style={{ flex: 1 }}
                >
                  <option value="">Select Customer</option>
                  {customers?.map((customer: any) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setShowCustomerModal(true)}
                  style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}
                >
                  + New
                </button>
              </div>
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


              <button type="submit" className="button button-primary" disabled={createMutation.isPending || updateMutation.isPending}>
                Update Project
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Modal for creating new customer */}
      {showCustomerModal && (
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
            zIndex: 1000,
            padding: '20px',
          }}
          onClick={() => {
            setShowCustomerModal(false);
            setNewCustomerData({ name: '', email: '', phone: '' });
          }}
        >
          <div
            className="card"
            style={{
              maxWidth: '500px',
              width: '100%',
              position: 'relative',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3>Create New Customer</h3>
              <button
                className="button button-secondary"
                onClick={() => {
                  setShowCustomerModal(false);
                  setNewCustomerData({ name: '', email: '', phone: '' });
                }}
                style={{ padding: '5px 10px', fontSize: '14px' }}
              >
                ✕
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (newCustomerData.name.trim()) {
                  createCustomerMutation.mutate(newCustomerData);
                }
              }}
            >
              <div className="form-group">
                <label className="label">Customer Name *</label>
                <input
                  type="text"
                  className="input"
                  value={newCustomerData.name}
                  onChange={(e) => setNewCustomerData({ ...newCustomerData, name: e.target.value })}
                  required
                  placeholder="Enter customer name"
                />
              </div>
              <div className="form-group">
                <label className="label">Email</label>
                <input
                  type="email"
                  className="input"
                  value={newCustomerData.email}
                  onChange={(e) => setNewCustomerData({ ...newCustomerData, email: e.target.value })}
                  placeholder="customer@example.com"
                />
              </div>
              <div className="form-group">
                <label className="label">Phone</label>
                <input
                  type="tel"
                  className="input"
                  value={newCustomerData.phone}
                  onChange={(e) => setNewCustomerData({ ...newCustomerData, phone: e.target.value })}
                  placeholder="(555) 123-4567"
                />
              </div>
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '20px' }}>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    setShowCustomerModal(false);
                    setNewCustomerData({ name: '', email: '', phone: '' });
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={createCustomerMutation.isPending}
                >
                  {createCustomerMutation.isPending ? 'Creating...' : 'Create Customer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Form at top for creating new projects */}
      {showForm && !editingProject && (
        <div className="card" style={{ marginBottom: '20px' }}>
          <h3>New Project</h3>
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
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                <select
                  className="input"
                  value={formData.customer_id}
                  onChange={(e) => setFormData({ ...formData, customer_id: e.target.value })}
                  required
                  style={{ flex: 1 }}
                >
                  <option value="">Select Customer</option>
                  {customers?.map((customer: any) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setShowCustomerModal(true)}
                  style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}
                >
                  + New
                </button>
              </div>
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

            <button type="submit" className="button button-primary" disabled={createMutation.isPending || updateMutation.isPending}>
              Create Project
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
