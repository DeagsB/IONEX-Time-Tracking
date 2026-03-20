import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { projectsService, customersService, timeEntriesService } from '../services/supabaseServices';
import SearchableSelect from '../components/SearchableSelect';
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
    is_completed: false,
    color: '#4ecdc4',
    location: '',
    approver: '',
    poAfe: '',
    cc: '',
    other: '',
    budget: '',
    shop_junior_rate: '',
    shop_senior_rate: '',
    ft_junior_rate: '',
    ft_senior_rate: '',
    travel_rate: '',
  });

  const [showInactive, setShowInactive] = useState(false);
  const [showMissingOnly, setShowMissingOnly] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: projects } = useQuery({
    queryKey: ['projects', showInactive],
    queryFn: () => projectsService.getAll(isAdmin ? showInactive : false),
  });
  const activeProjects = useMemo(() => (projects || []).filter((p: any) => p.active !== false), [projects]);
  const inactiveProjects = useMemo(() => (projects || []).filter((p: any) => p.active === false), [projects]);

  const { data: customers } = useQuery({
    queryKey: ['customers'],
    queryFn: () => customersService.getAll(),
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
        if (!isAdmin || showOnlyMyHours) {
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
  }, [allTimeEntries, projects, user?.id, isAdmin, showOnlyMyHours]);

  // Format hours helper
  const formatHours = (hours: number): string => {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return `${h}:${m.toString().padStart(2, '0')}`;
  };

  // Sorted projects (active only for main list; optionally filtered to missing numbers only)
  const sortedProjects = useMemo(() => {
    let list = activeProjects;
    if (showMissingOnly && isAdmin) {
      list = list.filter((p: any) => !p.project_number || String(p.project_number).trim() === '');
    }
    if (!list.length) return [];
    
    return [...list].sort((a: any, b: any) => {
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
  }, [activeProjects, sortField, sortDirection, projectHours, showMissingOnly, isAdmin]);

  const sortedInactiveProjects = useMemo(() => {
    if (!inactiveProjects.length) return [];
    return [...inactiveProjects].sort((a: any, b: any) =>
      (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase())
    );
  }, [inactiveProjects]);

  // Dashboard action items: filter to projects missing numbers from URL params
  useEffect(() => {
    const missing = searchParams.get('missing');
    if (missing === '1') {
      setShowMissingOnly(true);
    }
    if (missing) {
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

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
        project_number: isAdmin ? (data.project_number || null) : null,
        description: data.description || null,
        customer_id: data.customer_id || null,
        status: data.status,
        is_completed: !!data.is_completed,
        color: data.color || '#4ecdc4',
        location: data.location || null,
        approver: data.approver?.trim() || null,
        po_afe: data.poAfe?.trim() || null,
        cc: data.cc?.trim() || null,
        other: data.other || null,
        budget: data.budget ? parseFloat(data.budget) : null,
        shop_junior_rate: data.shop_junior_rate ? parseFloat(data.shop_junior_rate) : null,
        shop_senior_rate: data.shop_senior_rate ? parseFloat(data.shop_senior_rate) : null,
        ft_junior_rate: data.ft_junior_rate ? parseFloat(data.ft_junior_rate) : null,
        ft_senior_rate: data.ft_senior_rate ? parseFloat(data.ft_senior_rate) : null,
        travel_rate: data.travel_rate ? parseFloat(data.travel_rate) : null,
        is_demo: isDemoMode,
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
      if (isAdmin && data.project_number !== undefined) projectData.project_number = data.project_number || null;
      if (data.description !== undefined) projectData.description = data.description || null;
      if (data.customer_id !== undefined) projectData.customer_id = data.customer_id || null;
      if (data.status !== undefined) projectData.status = data.status;
      if (data.is_completed !== undefined) projectData.is_completed = !!data.is_completed;
      if (data.color !== undefined) projectData.color = data.color;
      if (data.location !== undefined) projectData.location = data.location || null;
      if (data.approver !== undefined || data.poAfe !== undefined || data.cc !== undefined) {
        projectData.approver = (data.approver ?? '').trim() || null;
        projectData.po_afe = (data.poAfe ?? '').trim() || null;
        projectData.cc = (data.cc ?? '').trim() || null;
      }
      if (data.other !== undefined) projectData.other = data.other || null;
      if (data.budget !== undefined) projectData.budget = data.budget ? parseFloat(data.budget) : null;
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

  const setActiveMutation = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      return await projectsService.update(id, { active });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const setCompletedMutation = useMutation({
    mutationFn: async ({ id, is_completed }: { id: string; is_completed: boolean }) => {
      return await projectsService.update(id, { is_completed });
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
      is_completed: false,
      color: '#4ecdc4',
      location: '',
      approver: '',
      poAfe: '',
      cc: '',
      other: '',
      budget: '',
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
      is_completed: project.is_completed === true,
      color: project.color || '#4ecdc4',
      location: project.location || '',
      approver: project.approver || '',
      poAfe: project.po_afe || '',
      cc: project.cc || '',
      other: project.other || '',
      budget: project.budget != null ? String(project.budget) : '',
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

  const handleReactivate = (id: string) => {
    setActiveMutation.mutate({ id, active: true });
  };

  const handleToggleCompleted = (project: any) => {
    const next = !project.is_completed;
    const msg = next
      ? 'Mark this project as closed? It will appear muted on the Profitability page.'
      : 'Reopen this project? It will show normally on Profitability again.';
    if (window.confirm(msg)) {
      setCompletedMutation.mutate({ id: project.id, is_completed: next });
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2>Projects</h2>
        <div style={{ display: 'flex', gap: '15px', alignItems: 'center', flexWrap: 'wrap' }}>
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
          {isAdmin && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '14px' }}>
              <input
                type="checkbox"
                checked={showMissingOnly}
                onChange={(e) => setShowMissingOnly(e.target.checked)}
                style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: '#10b981' }}
              />
              <span>Missing project # only</span>
            </label>
          )}
          {isAdmin && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '14px' }}>
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
                style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: '#4ecdc4' }}
              />
              <span>Show inactive</span>
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

              {isAdmin && (
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
              )}
            </div>

            <div className="form-group">
              <label className="label">Customer</label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
                <SearchableSelect
                  options={customers?.map((customer: any) => ({
                    value: customer.id,
                    label: customer.name,
                  })) || []}
                  value={formData.customer_id}
                  onChange={(value) => setFormData({ ...formData, customer_id: value })}
                  placeholder="Search customers..."
                  emptyOption={{ value: '', label: 'Select Customer' }}
                  style={{ flex: 1 }}
                />
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
              <label className="label" style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={formData.is_completed}
                  onChange={(e) => setFormData({ ...formData, is_completed: e.target.checked })}
                  style={{ marginTop: '3px', width: '18px', height: '18px', accentColor: '#64748b', flexShrink: 0 }}
                />
                <span>
                  <strong>Project closed</strong>
                  <span style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 'normal', marginTop: '4px' }}>
                    Shows muted on the Profitability page (informational only; does not hide the project).
                  </span>
                </span>
              </label>
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
              <h4 style={{ marginBottom: '8px', fontSize: '14px', color: 'var(--text-secondary)' }}>
                Service Ticket Defaults (auto-populate service tickets)
              </h4>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '15px' }}>
                PO/AFE/CC (Cost Center), Approver, Coding, and Other are separate fields.
              </p>
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
                <label className="label">PO/AFE/CC (Cost Center)</label>
                <input
                  type="text"
                  className="input"
                  value={formData.poAfe}
                  onChange={(e) => setFormData({ ...formData, poAfe: e.target.value })}
                  placeholder="e.g., PO: FC250505-8887"
                />
              </div>
              <div className="form-group">
                <label className="label">Approver</label>
                <input
                  type="text"
                  className="input"
                  value={formData.approver}
                  onChange={(e) => setFormData({ ...formData, approver: e.target.value })}
                  placeholder="e.g., G900, AC: C566"
                />
              </div>
              <div className="form-group">
                <label className="label">Coding</label>
                <input
                  type="text"
                  className="input"
                  value={formData.cc}
                  onChange={(e) => setFormData({ ...formData, cc: e.target.value })}
                  placeholder="e.g., 12345 or 3210_430"
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

            {/* Budget */}
            {isAdmin && (
              <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border-color)' }}>
                <div className="form-group">
                  <label className="label">Project Budget ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="input"
                    value={formData.budget}
                    onChange={(e) => setFormData({ ...formData, budget: e.target.value })}
                    placeholder="Leave empty if no budget set"
                  />
                </div>
              </div>
            )}

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

              {isAdmin && (
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
              )}
            </div>

            <div className="form-group">
              <label className="label">Customer</label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
                <SearchableSelect
                  options={customers?.map((customer: any) => ({
                    value: customer.id,
                    label: customer.name,
                  })) || []}
                  value={formData.customer_id}
                  onChange={(value) => setFormData({ ...formData, customer_id: value })}
                  placeholder="Search customers..."
                  emptyOption={{ value: '', label: 'Select Customer' }}
                  style={{ flex: 1 }}
                />
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
              <label className="label" style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={formData.is_completed}
                  onChange={(e) => setFormData({ ...formData, is_completed: e.target.checked })}
                  style={{ marginTop: '3px', width: '18px', height: '18px', accentColor: '#64748b', flexShrink: 0 }}
                />
                <span>
                  <strong>Project closed</strong>
                  <span style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 'normal', marginTop: '4px' }}>
                    Shows muted on the Profitability page (informational only; does not hide the project).
                  </span>
                </span>
              </label>
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
              <h4 style={{ marginBottom: '8px', fontSize: '14px', color: 'var(--text-secondary)' }}>
                Service Ticket Defaults (auto-populate service tickets)
              </h4>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '15px' }}>
                PO/AFE/CC (Cost Center), Approver, Coding, and Other are separate fields.
              </p>
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
                <label className="label">PO/AFE/CC (Cost Center)</label>
                <input
                  type="text"
                  className="input"
                  value={formData.poAfe}
                  onChange={(e) => setFormData({ ...formData, poAfe: e.target.value })}
                  placeholder="e.g., PO: FC250505-8887"
                />
              </div>
              <div className="form-group">
                <label className="label">Approver</label>
                <input
                  type="text"
                  className="input"
                  value={formData.approver}
                  onChange={(e) => setFormData({ ...formData, approver: e.target.value })}
                  placeholder="e.g., G900, AC: C566"
                />
              </div>
              <div className="form-group">
                <label className="label">Coding</label>
                <input
                  type="text"
                  className="input"
                  value={formData.cc}
                  onChange={(e) => setFormData({ ...formData, cc: e.target.value })}
                  placeholder="e.g., 12345 or 3210_430"
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

            {/* Budget */}
            {isAdmin && (
              <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border-color)' }}>
                <div className="form-group">
                  <label className="label">Project Budget ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="input"
                    value={formData.budget}
                    onChange={(e) => setFormData({ ...formData, budget: e.target.value })}
                    placeholder="Leave empty if no budget set"
                  />
                </div>
              </div>
            )}

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
              <th style={{ textAlign: 'right' }}>Close</th>
            </tr>
          </thead>
          <tbody>
            {sortedProjects.length === 0 && !(isAdmin && showInactive && inactiveProjects.length > 0) && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: '20px' }}>
                  No projects found. Create your first project above.
                </td>
              </tr>
            )}
            {sortedProjects.map((project: any) => {
              const missingProjectNumber = isAdmin && (!project.project_number || String(project.project_number).trim() === '');
              const isClosed = project.is_completed === true;
              const rowBg = missingProjectNumber
                ? 'rgba(16, 185, 129, 0.08)'
                : isClosed
                  ? 'rgba(148, 163, 184, 0.07)'
                  : 'transparent';
              const rowHoverBg = missingProjectNumber
                ? 'rgba(16, 185, 129, 0.12)'
                : isClosed
                  ? 'rgba(148, 163, 184, 0.12)'
                  : 'var(--hover-bg)';
              const rowBorderLeft = missingProjectNumber ? '4px solid #10b981' : isClosed ? '3px solid #94a3b8' : undefined;
              return (
              <tr
                key={project.id}
                title={user ? 'Click row to edit' : undefined}
                onClick={() => {
                  if (user) handleEdit(project);
                }}
                style={{
                  borderLeft: rowBorderLeft,
                  transition: 'background-color 0.2s',
                  backgroundColor: rowBg,
                  opacity: isClosed && !missingProjectNumber ? 0.92 : 1,
                  cursor: user ? 'pointer' : 'default',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = rowHoverBg;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = rowBg;
                }}
              >
                <td style={{ fontFamily: 'monospace', fontWeight: '600' }}>
                  {missingProjectNumber ? (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{
                        display: 'inline-block',
                        padding: '2px 8px',
                        fontSize: '10px',
                        fontWeight: '700',
                        color: '#10b981',
                        backgroundColor: 'rgba(16, 185, 129, 0.15)',
                        border: '1px solid rgba(16, 185, 129, 0.4)',
                        borderRadius: '4px',
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                      }} title="Add a project number in Edit">Missing #</span>
                      –
                    </span>
                  ) : (
                    project.project_number || '-'
                  )}
                </td>
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
                <td>
                  <span>{project.status}</span>
                  {isClosed ? (
                    <span
                      style={{
                        marginLeft: '8px',
                        fontSize: '10px',
                        fontWeight: '700',
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        color: 'var(--text-tertiary)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '4px',
                        padding: '2px 6px',
                        verticalAlign: 'middle',
                      }}
                    >
                      Closed
                    </span>
                  ) : null}
                </td>
                <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                  {formatHours(projectHours[project.id] || 0)}
                </td>
                <td style={{ textAlign: 'right', verticalAlign: 'middle' }} onClick={(e) => e.stopPropagation()}>
                  {user && (
                    <button
                      type="button"
                      onClick={() => handleToggleCompleted(project)}
                      disabled={setCompletedMutation.isPending}
                      title={isClosed ? 'Show as active on Profitability' : 'Mark closed — muted on Profitability; stays in lists'}
                      style={{
                        padding: '7px 16px',
                        fontSize: '12px',
                        fontWeight: 600,
                        letterSpacing: '0.02em',
                        borderRadius: '999px',
                        border: isClosed ? '1px solid rgba(34, 197, 94, 0.45)' : '1px solid color-mix(in srgb, var(--primary-color) 55%, var(--border-color))',
                        backgroundColor: isClosed ? 'rgba(34, 197, 94, 0.1)' : 'color-mix(in srgb, var(--primary-color) 8%, transparent)',
                        color: isClosed ? '#16a34a' : 'var(--primary-color)',
                        cursor: setCompletedMutation.isPending ? 'not-allowed' : 'pointer',
                        opacity: setCompletedMutation.isPending ? 0.65 : 1,
                        transition: 'background-color 0.15s ease, border-color 0.15s ease, transform 0.1s ease',
                        boxShadow: isClosed ? 'none' : '0 1px 2px rgba(0,0,0,0.04)',
                      }}
                      onMouseEnter={(e) => {
                        if (setCompletedMutation.isPending) return;
                        e.currentTarget.style.filter = 'brightness(1.05)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.filter = '';
                      }}
                    >
                      {isClosed ? 'Reopen' : 'Mark closed'}
                    </button>
                  )}
                </td>
              </tr>
            );})}
          </tbody>
        </table>
      </div>

      {isAdmin && showInactive && sortedInactiveProjects.length > 0 && (
        <div style={{ marginTop: '32px' }}>
          <h3 style={{ marginBottom: '12px', color: 'var(--text-secondary)', fontSize: '16px' }}>Inactive projects</h3>
          <p style={{ marginBottom: '12px', fontSize: '13px', color: 'var(--text-secondary)' }}>
            Only admins can see this section. Reactivate to show in the main list again.
          </p>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Project #</th>
                <th>Name</th>
                <th>Customer</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Total Hours</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedInactiveProjects.map((project: any) => {
                const inClosed = project.is_completed === true;
                const inRowBg = 'rgba(0,0,0,0.02)';
                const inRowHover = 'var(--hover-bg)';
                return (
                <tr
                  key={project.id}
                  title="Click row to edit"
                  onClick={() => handleEdit(project)}
                  style={{
                    opacity: 0.85,
                    cursor: 'pointer',
                    backgroundColor: inRowBg,
                    transition: 'background-color 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = inRowHover;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = inRowBg;
                  }}
                >
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
                  <td>
                    <span>{project.status}</span>
                    {inClosed ? (
                      <span
                        style={{
                          marginLeft: '8px',
                          fontSize: '10px',
                          fontWeight: '700',
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                          color: 'var(--text-tertiary)',
                          border: '1px solid var(--border-color)',
                          borderRadius: '4px',
                          padding: '2px 6px',
                          verticalAlign: 'middle',
                        }}
                      >
                        Closed
                      </span>
                    ) : null}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                    {formatHours(projectHours[project.id] || 0)}
                  </td>
                  <td style={{ textAlign: 'right', verticalAlign: 'middle' }} onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        onClick={() => handleToggleCompleted(project)}
                        disabled={setCompletedMutation.isPending}
                        title={inClosed ? 'Show as active on Profitability' : 'Mark closed — muted on Profitability'}
                        style={{
                          padding: '7px 16px',
                          fontSize: '12px',
                          fontWeight: 600,
                          letterSpacing: '0.02em',
                          borderRadius: '999px',
                          border: inClosed ? '1px solid rgba(34, 197, 94, 0.45)' : '1px solid color-mix(in srgb, var(--primary-color) 55%, var(--border-color))',
                          backgroundColor: inClosed ? 'rgba(34, 197, 94, 0.1)' : 'color-mix(in srgb, var(--primary-color) 8%, transparent)',
                          color: inClosed ? '#16a34a' : 'var(--primary-color)',
                          cursor: setCompletedMutation.isPending ? 'not-allowed' : 'pointer',
                          opacity: setCompletedMutation.isPending ? 0.65 : 1,
                          transition: 'background-color 0.15s ease, filter 0.1s ease',
                          boxShadow: inClosed ? 'none' : '0 1px 2px rgba(0,0,0,0.04)',
                        }}
                        onMouseEnter={(e) => {
                          if (!setCompletedMutation.isPending) e.currentTarget.style.filter = 'brightness(1.05)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.filter = '';
                        }}
                      >
                        {inClosed ? 'Reopen' : 'Mark closed'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReactivate(project.id)}
                        style={{
                          padding: '7px 16px',
                          fontSize: '12px',
                          fontWeight: 600,
                          letterSpacing: '0.02em',
                          borderRadius: '999px',
                          border: 'none',
                          backgroundColor: 'var(--primary-color)',
                          color: '#fff',
                          cursor: 'pointer',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
                          transition: 'filter 0.1s ease',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.filter = 'brightness(1.08)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.filter = '';
                        }}
                      >
                        Reactivate
                      </button>
                    </div>
                  </td>
                </tr>
              );})}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
