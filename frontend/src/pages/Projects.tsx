import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { projectsService, customersService, timeEntriesService } from '../services/supabaseServices';

export default function Projects() {
  const { user, isAdmin } = useAuth();
  const { isDemoMode } = useDemoMode();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [editingProject, setEditingProject] = useState<any>(null);
  const [modalMouseDownPos, setModalMouseDownPos] = useState<{ x: number; y: number } | null>(null);
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
    color: '#4ecdc4',
    location: '',
    approver_po_afe: '',
    other: '',
    shop_junior_rate: '',
    shop_senior_rate: '',
    ft_junior_rate: '',
    ft_senior_rate: '',
    travel_rate: '',
  });

  const { data: projects } = useQuery({
    queryKey: ['projects', user?.id, user?.role],
    queryFn: () => projectsService.getAll(user?.id),
  });

  const { data: customers } = useQuery({
    queryKey: ['customers', user?.id],
    queryFn: () => customersService.getAll(user?.id),
  });

  // Toggle for admins to show only their hours vs all hours
  const [showOnlyMyHours, setShowOnlyMyHours] = useState(false);
  
  // Sorting state - persisted per user in localStorage
  const [sortField, setSortField] = useState<'project_number' | 'name' | 'customer' | 'status' | 'hours'>(() => {
    const saved = localStorage.getItem(`projects_sortField_${user?.id}`);
    return (saved as any) || 'name';
  });
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(() => {
    const saved = localStorage.getItem(`projects_sortDirection_${user?.id}`);
    return (saved as 'asc' | 'desc') || 'asc';
  });

  // Fetch all time entries to calculate total hours per project
  const { data: allTimeEntries } = useQuery({
    queryKey: ['allTimeEntries'],
    queryFn: () => timeEntriesService.getAll(isDemoMode),
    enabled: !!user,
  });

  // Calculate total hours per project
  const projectHours = useMemo(() => {
    if (!allTimeEntries || !projects) return {};
    
    const hoursMap: Record<string, number> = {};
    
    allTimeEntries.forEach((entry: any) => {
      if (entry.project_id && entry.hours) {
        const projectId = entry.project_id;
        
        // For non-admin users, only count their own hours
        // For admin users, count all hours unless toggle is on
        if (user?.role !== 'ADMIN' || showOnlyMyHours) {
          // Only count hours for the current user
          if (entry.user_id === user?.id) {
            hoursMap[projectId] = (hoursMap[projectId] || 0) + Number(entry.hours);
          }
        } else {
          // Count all users' hours
          hoursMap[projectId] = (hoursMap[projectId] || 0) + Number(entry.hours);
        }
      }
    });
    
    return hoursMap;
  }, [allTimeEntries, projects, user?.id, user?.role, showOnlyMyHours]);

  // Format hours helper
  const formatHours = (hours: number): string => {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return `${h}:${m.toString().padStart(2, '0')}`;
  };

  // Sorted projects
  const sortedProjects = useMemo(() => {
    if (!projects) return [];
    
    return [...projects].sort((a: any, b: any) => {
      let aVal: string | number;
      let bVal: string | number;
      
      switch (sortField) {
        case 'project_number':
          aVal = (a.project_number || '').toLowerCase();
          bVal = (b.project_number || '').toLowerCase();
          break;
        case 'name':
          aVal = (a.name || '').toLowerCase();
          bVal = (b.name || '').toLowerCase();
          break;
        case 'customer':
          aVal = (a.customer?.name || '').toLowerCase();
          bVal = (b.customer?.name || '').toLowerCase();
          break;
        case 'status':
          aVal = a.status || '';
          bVal = b.status || '';
          break;
        case 'hours':
          aVal = projectHours[a.id] || 0;
          bVal = projectHours[b.id] || 0;
          break;
        default:
          return 0;
      }
      
      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [projects, sortField, sortDirection, projectHours]);

  // Toggle sort function - saves to localStorage per user
  const handleSort = (field: typeof sortField) => {
    let newDirection: 'asc' | 'desc';
    if (sortField === field) {
      newDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      setSortDirection(newDirection);
    } else {
      newDirection = 'asc';
      setSortField(field);
      setSortDirection(newDirection);
      if (user?.id) localStorage.setItem(`projects_sortField_${user.id}`, field);
    }
    if (user?.id) localStorage.setItem(`projects_sortDirection_${user.id}`, newDirection);
  };

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const projectData: any = {
        name: data.name,
        project_number: data.project_number || null,
        description: data.description || null,
        customer_id: data.customer_id || null,
        status: data.status,
        color: data.color || '#4ecdc4',
        location: data.location || null,
        approver_po_afe: data.approver_po_afe || null,
        other: data.other || null,
        shop_junior_rate: data.shop_junior_rate ? parseFloat(data.shop_junior_rate) : null,
        shop_senior_rate: data.shop_senior_rate ? parseFloat(data.shop_senior_rate) : null,
        ft_junior_rate: data.ft_junior_rate ? parseFloat(data.ft_junior_rate) : null,
        ft_senior_rate: data.ft_senior_rate ? parseFloat(data.ft_senior_rate) : null,
        travel_rate: data.travel_rate ? parseFloat(data.travel_rate) : null,
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
      if (data.color !== undefined) projectData.color = data.color;
      if (data.location !== undefined) projectData.location = data.location || null;
      if (data.approver_po_afe !== undefined) projectData.approver_po_afe = data.approver_po_afe || null;
      if (data.other !== undefined) projectData.other = data.other || null;
      if (data.shop_junior_rate !== undefined) projectData.shop_junior_rate = data.shop_junior_rate ? parseFloat(data.shop_junior_rate) : null;
      if (data.shop_senior_rate !== undefined) projectData.shop_senior_rate = data.shop_senior_rate ? parseFloat(data.shop_senior_rate) : null;
      if (data.ft_junior_rate !== undefined) projectData.ft_junior_rate = data.ft_junior_rate ? parseFloat(data.ft_junior_rate) : null;
      if (data.ft_senior_rate !== undefined) projectData.ft_senior_rate = data.ft_senior_rate ? parseFloat(data.ft_senior_rate) : null;
      if (data.travel_rate !== undefined) projectData.travel_rate = data.travel_rate ? parseFloat(data.travel_rate) : null;

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
      color: '#4ecdc4',
      location: '',
      approver_po_afe: '',
      other: '',
      shop_junior_rate: '',
      shop_senior_rate: '',
      ft_junior_rate: '',
      ft_senior_rate: '',
      travel_rate: '',
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
      color: project.color || '#4ecdc4',
      location: project.location || '',
      approver_po_afe: project.approver_po_afe || '',
      other: project.other || '',
      shop_junior_rate: project.shop_junior_rate?.toString() || '',
      shop_senior_rate: project.shop_senior_rate?.toString() || '',
      ft_junior_rate: project.ft_junior_rate?.toString() || '',
      ft_senior_rate: project.ft_senior_rate?.toString() || '',
      travel_rate: project.travel_rate?.toString() || '',
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
        <div style={{ display: 'flex', gap: '15px', alignItems: 'center' }}>
          {isAdmin && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '14px' }}>
              <input
                type="checkbox"
                checked={showOnlyMyHours}
                onChange={(e) => setShowOnlyMyHours(e.target.checked)}
                style={{
                  width: '18px',
                  height: '18px',
                  cursor: 'pointer',
                  accentColor: '#dc2626'
                }}
              />
              <span>Show only my hours</span>
            </label>
          )}
          <button className="button button-primary" onClick={() => { setShowForm(!showForm); setEditingProject(null); resetForm(); }}>
            {showForm ? 'Cancel' : 'Add Project'}
          </button>
        </div>
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
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setModalMouseDownPos({ x: e.clientX, y: e.clientY });
            }
          }}
          onMouseUp={(e) => {
            if (e.target === e.currentTarget && modalMouseDownPos) {
              const moved = Math.abs(e.clientX - modalMouseDownPos.x) > 5 || Math.abs(e.clientY - modalMouseDownPos.y) > 5;
              if (!moved) {
                setShowModal(false);
                setEditingProject(null);
                resetForm();
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
              <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
                <select
                  className="input"
                  value={formData.customer_id}
                  onChange={(e) => setFormData({ ...formData, customer_id: e.target.value })}
                  required
                  style={{ flex: 1, margin: 0 }}
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
                  style={{ padding: '0 12px', whiteSpace: 'nowrap', height: 'auto' }}
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

            {/* Service Ticket Defaults */}
            <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border-color)' }}>
              <h4 style={{ marginBottom: '15px', fontSize: '14px', color: 'var(--text-secondary)' }}>
                Service Ticket Defaults (auto-populate service tickets)
              </h4>
              <div className="form-group">
                <label className="label">Location</label>
                <input
                  type="text"
                  className="input"
                  value={formData.location}
                  onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                  placeholder="e.g., Site A, Building 3"
                />
              </div>
              <div className="form-group">
                <label className="label">Approver / PO / AFE</label>
                <input
                  type="text"
                  className="input"
                  value={formData.approver_po_afe}
                  onChange={(e) => setFormData({ ...formData, approver_po_afe: e.target.value })}
                  placeholder="e.g., G900 CN0031 24561 or G900, CN0031, 24561"
                />
              </div>
              <div className="form-group">
                <label className="label">Other</label>
                <input
                  type="text"
                  className="input"
                  value={formData.other}
                  onChange={(e) => setFormData({ ...formData, other: e.target.value })}
                  placeholder="Additional notes"
                />
              </div>
            </div>

            {/* Project-Specific Rate Overrides */}
            <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border-color)' }}>
              <h4 style={{ marginBottom: '15px', fontSize: '14px', color: 'var(--text-secondary)' }}>
                Rate Overrides (Optional - overrides employee default rates)
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div className="form-group">
                  <label className="label">Shop Junior ($/hr)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    value={formData.shop_junior_rate}
                    onChange={(e) => setFormData({ ...formData, shop_junior_rate: e.target.value })}
                    placeholder="Leave empty to use default"
                  />
                </div>
                <div className="form-group">
                  <label className="label">Shop Senior ($/hr)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    value={formData.shop_senior_rate}
                    onChange={(e) => setFormData({ ...formData, shop_senior_rate: e.target.value })}
                    placeholder="Leave empty to use default"
                  />
                </div>
                <div className="form-group">
                  <label className="label">FT Junior ($/hr)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    value={formData.ft_junior_rate}
                    onChange={(e) => setFormData({ ...formData, ft_junior_rate: e.target.value })}
                    placeholder="Leave empty to use default"
                  />
                </div>
                <div className="form-group">
                  <label className="label">FT Senior ($/hr)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    value={formData.ft_senior_rate}
                    onChange={(e) => setFormData({ ...formData, ft_senior_rate: e.target.value })}
                    placeholder="Leave empty to use default"
                  />
                </div>
                <div className="form-group">
                  <label className="label">Travel Time ($/hr)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    value={formData.travel_rate}
                    onChange={(e) => setFormData({ ...formData, travel_rate: e.target.value })}
                    placeholder="Leave empty to use default"
                  />
                </div>
              </div>
            </div>

              <button type="submit" className="button button-primary" disabled={createMutation.isPending || updateMutation.isPending} style={{ marginTop: '20px' }}>
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
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setModalMouseDownPos({ x: e.clientX, y: e.clientY });
            }
          }}
          onMouseUp={(e) => {
            if (e.target === e.currentTarget && modalMouseDownPos) {
              const moved = Math.abs(e.clientX - modalMouseDownPos.x) > 5 || Math.abs(e.clientY - modalMouseDownPos.y) > 5;
              if (!moved) {
                setShowCustomerModal(false);
                setNewCustomerData({ name: '', email: '', phone: '' });
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
              <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
                <select
                  className="input"
                  value={formData.customer_id}
                  onChange={(e) => setFormData({ ...formData, customer_id: e.target.value })}
                  required
                  style={{ flex: 1, margin: 0 }}
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
                  style={{ padding: '0 12px', whiteSpace: 'nowrap', height: 'auto' }}
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

            {/* Service Ticket Defaults */}
            <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border-color)' }}>
              <h4 style={{ marginBottom: '15px', fontSize: '14px', color: 'var(--text-secondary)' }}>
                Service Ticket Defaults (auto-populate service tickets)
              </h4>
              <div className="form-group">
                <label className="label">Location</label>
                <input
                  type="text"
                  className="input"
                  value={formData.location}
                  onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                  placeholder="e.g., Site A, Building 3"
                />
              </div>
              <div className="form-group">
                <label className="label">Approver / PO / AFE</label>
                <input
                  type="text"
                  className="input"
                  value={formData.approver_po_afe}
                  onChange={(e) => setFormData({ ...formData, approver_po_afe: e.target.value })}
                  placeholder="e.g., G900 CN0031 24561 or G900, CN0031, 24561"
                />
              </div>
              <div className="form-group">
                <label className="label">Other</label>
                <input
                  type="text"
                  className="input"
                  value={formData.other}
                  onChange={(e) => setFormData({ ...formData, other: e.target.value })}
                  placeholder="Additional notes"
                />
              </div>
            </div>

            {/* Project-Specific Rate Overrides */}
            <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border-color)' }}>
              <h4 style={{ marginBottom: '15px', fontSize: '14px', color: 'var(--text-secondary)' }}>
                Rate Overrides (Optional - overrides employee default rates)
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div className="form-group">
                  <label className="label">Shop Junior ($/hr)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    value={formData.shop_junior_rate}
                    onChange={(e) => setFormData({ ...formData, shop_junior_rate: e.target.value })}
                    placeholder="Leave empty to use default"
                  />
                </div>
                <div className="form-group">
                  <label className="label">Shop Senior ($/hr)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    value={formData.shop_senior_rate}
                    onChange={(e) => setFormData({ ...formData, shop_senior_rate: e.target.value })}
                    placeholder="Leave empty to use default"
                  />
                </div>
                <div className="form-group">
                  <label className="label">FT Junior ($/hr)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    value={formData.ft_junior_rate}
                    onChange={(e) => setFormData({ ...formData, ft_junior_rate: e.target.value })}
                    placeholder="Leave empty to use default"
                  />
                </div>
                <div className="form-group">
                  <label className="label">FT Senior ($/hr)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    value={formData.ft_senior_rate}
                    onChange={(e) => setFormData({ ...formData, ft_senior_rate: e.target.value })}
                    placeholder="Leave empty to use default"
                  />
                </div>
                <div className="form-group">
                  <label className="label">Travel Time ($/hr)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    value={formData.travel_rate}
                    onChange={(e) => setFormData({ ...formData, travel_rate: e.target.value })}
                    placeholder="Leave empty to use default"
                  />
                </div>
              </div>
            </div>

            <button type="submit" className="button button-primary" disabled={createMutation.isPending || updateMutation.isPending} style={{ marginTop: '20px' }}>
              Create Project
            </button>
          </form>
        </div>
      )}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th onClick={() => handleSort('project_number')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                Project # {sortField === 'project_number' && (sortDirection === 'asc' ? '▲' : '▼')}
              </th>
              <th onClick={() => handleSort('name')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                Name {sortField === 'name' && (sortDirection === 'asc' ? '▲' : '▼')}
              </th>
              <th onClick={() => handleSort('customer')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                Customer {sortField === 'customer' && (sortDirection === 'asc' ? '▲' : '▼')}
              </th>
              <th onClick={() => handleSort('status')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                Status {sortField === 'status' && (sortDirection === 'asc' ? '▲' : '▼')}
              </th>
              <th onClick={() => handleSort('hours')} style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none' }}>
                Total Hours {sortField === 'hours' && (sortDirection === 'asc' ? '▲' : '▼')}
              </th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {projects && projects.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: '20px' }}>
                  No projects found. Create your first project above.
                </td>
              </tr>
            )}
            {sortedProjects.map((project: any) => (
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
                <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                  {formatHours(projectHours[project.id] || 0)}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {/* Allow users to edit/delete their own projects, or admins to edit/delete any */}
                  {(user?.id === project.created_by || isAdmin || !project.created_by) && (
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
