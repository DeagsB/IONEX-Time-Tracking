import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { customersService } from '../services/supabaseServices';

export default function Customers() {
  const { user, isAdmin } = useAuth();
  const { isDemoMode } = useDemoMode();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<any>(null);
  const [modalMouseDownPos, setModalMouseDownPos] = useState<{ x: number; y: number } | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    contact_name: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    state: '',
    zip_code: '',
    country: '',
    tax_id: '',
    notes: '',
    po_number: '',
    approver_name: '',
    location_code: '',
    service_location: '',
    rate_shop_junior: '',
    rate_shop_senior: '',
    rate_field_junior: '',
    rate_field_senior: '',
    rate_travel: '',
  });

  const { data: customers } = useQuery({
    queryKey: ['customers', user?.id],
    queryFn: () => customersService.getAll(user?.id),
  });

  // Sorting state - persisted per user in localStorage
  const [sortField, setSortField] = useState<'name' | 'email' | 'phone' | 'city' | 'projects'>(() => {
    const saved = localStorage.getItem(`customers_sortField_${user?.id}`);
    return (saved as any) || 'name';
  });
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(() => {
    const saved = localStorage.getItem(`customers_sortDirection_${user?.id}`);
    return (saved as 'asc' | 'desc') || 'asc';
  });

  // Sorted customers
  const sortedCustomers = useMemo(() => {
    if (!customers) return [];
    
    return [...customers].sort((a: any, b: any) => {
      let aVal: string | number;
      let bVal: string | number;
      
      switch (sortField) {
        case 'name':
          aVal = (a.name || '').toLowerCase();
          bVal = (b.name || '').toLowerCase();
          break;
        case 'email':
          aVal = (a.email || '').toLowerCase();
          bVal = (b.email || '').toLowerCase();
          break;
        case 'phone':
          aVal = (a.phone || '').toLowerCase();
          bVal = (b.phone || '').toLowerCase();
          break;
        case 'city':
          aVal = (a.city || '').toLowerCase();
          bVal = (b.city || '').toLowerCase();
          break;
        case 'projects':
          aVal = a.projects?.length || 0;
          bVal = b.projects?.length || 0;
          break;
        default:
          return 0;
      }
      
      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [customers, sortField, sortDirection]);

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
      if (user?.id) localStorage.setItem(`customers_sortField_${user.id}`, field);
    }
    if (user?.id) localStorage.setItem(`customers_sortDirection_${user.id}`, newDirection);
  };

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const { is_private, ...customerData } = data; // Remove is_private if present
      return await customersService.create({
        ...customerData,
        is_demo: isDemoMode, // Mark as demo customer if in demo mode
        is_private: false, // Always set to false
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setShowForm(false);
      setShowModal(false);
      setEditingCustomer(null);
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      if (!user?.id) throw new Error('User not authenticated.');
      try {
        return await customersService.update(id, data);
      } catch (error: any) {
        console.error('Error updating customer:', error);
        alert(`Failed to update customer: ${error.message || 'Unknown error'}`);
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setShowModal(false);
      setEditingCustomer(null);
      resetForm();
    },
    onError: (error: any) => {
      console.error('Update mutation error:', error);
      alert(`Failed to update customer: ${error.message || 'Unknown error'}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await customersService.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
  });

  const resetForm = () => {
    setFormData({
      name: '',
      contact_name: '',
      email: '',
      phone: '',
      address: '',
      city: '',
      state: '',
      zip_code: '',
      country: '',
      tax_id: '',
      notes: '',
      po_number: '',
      approver_name: '',
      location_code: '',
      service_location: '',
      rate_shop_junior: '',
      rate_shop_senior: '',
      rate_field_junior: '',
      rate_field_senior: '',
      rate_travel: '',
    });
  };

  const handleEdit = (customer: any) => {
    setEditingCustomer(customer);
    setFormData({
      name: customer.name || '',
      contact_name: customer.contact_name || '',
      email: customer.email || '',
      phone: customer.phone || '',
      address: customer.address || '',
      city: customer.city || '',
      state: customer.state || '',
      zip_code: customer.zip_code || '',
      country: customer.country || '',
      tax_id: customer.tax_id || '',
      notes: customer.notes || '',
      po_number: customer.po_number || '',
      approver_name: customer.approver_name || '',
      location_code: customer.location_code || '',
      service_location: customer.service_location || '',
      rate_shop_junior: customer.rate_shop_junior || '',
      rate_shop_senior: customer.rate_shop_senior || '',
      rate_field_junior: customer.rate_field_junior || '',
      rate_field_senior: customer.rate_field_senior || '',
      rate_travel: customer.rate_travel || '',
    });
    setShowModal(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingCustomer) {
      updateMutation.mutate({ id: editingCustomer.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const handleDelete = (id: string) => {
    if (window.confirm('Are you sure you want to delete this customer?')) {
      deleteMutation.mutate(id);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2>Customers</h2>
        <button className="button button-primary" onClick={() => { setShowForm(!showForm); setEditingCustomer(null); resetForm(); }}>
          {showForm ? 'Cancel' : 'Add Customer'}
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
                setEditingCustomer(null);
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
              <h3>Edit Customer</h3>
              <button
                className="button button-secondary"
                onClick={() => {
                  setShowModal(false);
                  setEditingCustomer(null);
                  resetForm();
                }}
                style={{ padding: '5px 10px', fontSize: '14px' }}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="label">Name *</label>
              <input
                type="text"
                className="input"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
              />
            </div>

            <div className="form-group">
              <label className="label">Contact Name</label>
              <input
                type="text"
                className="input"
                value={formData.contact_name}
                onChange={(e) => setFormData({ ...formData, contact_name: e.target.value })}
                placeholder="Primary contact person"
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">Email</label>
                <input
                  type="email"
                  className="input"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label className="label">Phone</label>
                <input
                  type="tel"
                  className="input"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                />
              </div>
            </div>

            <div className="form-group">
              <label className="label">Address</label>
              <input
                type="text"
                className="input"
                value={formData.address}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">City</label>
                <input
                  type="text"
                  className="input"
                  value={formData.city}
                  onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label className="label">State</label>
                <input
                  type="text"
                  className="input"
                  value={formData.state}
                  onChange={(e) => setFormData({ ...formData, state: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label className="label">ZIP Code</label>
                <input
                  type="text"
                  className="input"
                  value={formData.zip_code}
                  onChange={(e) => setFormData({ ...formData, zip_code: e.target.value })}
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">Country</label>
                <input
                  type="text"
                  className="input"
                  value={formData.country}
                  onChange={(e) => setFormData({ ...formData, country: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label className="label">Tax ID</label>
                <input
                  type="text"
                  className="input"
                  value={formData.tax_id}
                  onChange={(e) => setFormData({ ...formData, tax_id: e.target.value })}
                />
              </div>
            </div>

            <div className="form-group">
              <label className="label">Notes</label>
              <textarea
                className="input"
                rows={3}
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              />
            </div>

            <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid var(--border-color)' }} />
            <h4 style={{ marginBottom: '15px', color: 'var(--text-secondary)', fontSize: '14px', textTransform: 'uppercase' }}>
              Special Billing Rates (Optional)
            </h4>
            <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '15px' }}>
              Set custom rates for this client. Project rates take priority if also set.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">Shop Rate - Junior</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.rate_shop_junior}
                    onChange={(e) => setFormData({ ...formData, rate_shop_junior: e.target.value })}
                    placeholder="0.00"
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="label">Shop Rate - Senior</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.rate_shop_senior}
                    onChange={(e) => setFormData({ ...formData, rate_shop_senior: e.target.value })}
                    placeholder="0.00"
                  />
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">Field Rate - Junior</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.rate_field_junior}
                    onChange={(e) => setFormData({ ...formData, rate_field_junior: e.target.value })}
                    placeholder="0.00"
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="label">Field Rate - Senior</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.rate_field_senior}
                    onChange={(e) => setFormData({ ...formData, rate_field_senior: e.target.value })}
                    placeholder="0.00"
                  />
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">Travel Time Rate</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.rate_travel}
                    onChange={(e) => setFormData({ ...formData, rate_travel: e.target.value })}
                    placeholder="0.00"
                  />
                </div>
              </div>
              <div></div>
            </div>

              <button type="submit" className="button button-primary" disabled={createMutation.isPending || updateMutation.isPending}>
                Update Customer
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Form at top for creating new customers */}
      {showForm && !editingCustomer && (
        <div className="card" style={{ marginBottom: '20px' }}>
          <h3>New Customer</h3>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="label">Name *</label>
              <input
                type="text"
                className="input"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
              />
            </div>

            <div className="form-group">
              <label className="label">Contact Name</label>
              <input
                type="text"
                className="input"
                value={formData.contact_name}
                onChange={(e) => setFormData({ ...formData, contact_name: e.target.value })}
                placeholder="Primary contact person"
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">Email</label>
                <input
                  type="email"
                  className="input"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label className="label">Phone</label>
                <input
                  type="tel"
                  className="input"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                />
              </div>
            </div>

            <div className="form-group">
              <label className="label">Address</label>
              <input
                type="text"
                className="input"
                value={formData.address}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">City</label>
                <input
                  type="text"
                  className="input"
                  value={formData.city}
                  onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label className="label">State</label>
                <input
                  type="text"
                  className="input"
                  value={formData.state}
                  onChange={(e) => setFormData({ ...formData, state: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label className="label">ZIP Code</label>
                <input
                  type="text"
                  className="input"
                  value={formData.zip_code}
                  onChange={(e) => setFormData({ ...formData, zip_code: e.target.value })}
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">Country</label>
                <input
                  type="text"
                  className="input"
                  value={formData.country}
                  onChange={(e) => setFormData({ ...formData, country: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label className="label">Tax ID</label>
                <input
                  type="text"
                  className="input"
                  value={formData.tax_id}
                  onChange={(e) => setFormData({ ...formData, tax_id: e.target.value })}
                />
              </div>
            </div>

            <div className="form-group">
              <label className="label">Notes</label>
              <textarea
                className="input"
                rows={3}
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              />
            </div>

            <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid var(--border-color)' }} />
            <h4 style={{ marginBottom: '15px', color: 'var(--text-secondary)', fontSize: '14px', textTransform: 'uppercase' }}>
              Special Billing Rates (Optional)
            </h4>
            <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '15px' }}>
              Set custom rates for this client. Project rates take priority if also set.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">Shop Rate - Junior</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.rate_shop_junior}
                    onChange={(e) => setFormData({ ...formData, rate_shop_junior: e.target.value })}
                    placeholder="0.00"
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="label">Shop Rate - Senior</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.rate_shop_senior}
                    onChange={(e) => setFormData({ ...formData, rate_shop_senior: e.target.value })}
                    placeholder="0.00"
                  />
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">Field Rate - Junior</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.rate_field_junior}
                    onChange={(e) => setFormData({ ...formData, rate_field_junior: e.target.value })}
                    placeholder="0.00"
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="label">Field Rate - Senior</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.rate_field_senior}
                    onChange={(e) => setFormData({ ...formData, rate_field_senior: e.target.value })}
                    placeholder="0.00"
                  />
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">Travel Time Rate</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.rate_travel}
                    onChange={(e) => setFormData({ ...formData, rate_travel: e.target.value })}
                    placeholder="0.00"
                  />
                </div>
              </div>
              <div></div>
            </div>

            <button type="submit" className="button button-primary" disabled={createMutation.isPending || updateMutation.isPending}>
              Create Customer
            </button>
          </form>
        </div>
      )}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th onClick={() => handleSort('name')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                Name {sortField === 'name' && (sortDirection === 'asc' ? '▲' : '▼')}
              </th>
              <th onClick={() => handleSort('email')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                Email {sortField === 'email' && (sortDirection === 'asc' ? '▲' : '▼')}
              </th>
              <th onClick={() => handleSort('phone')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                Phone {sortField === 'phone' && (sortDirection === 'asc' ? '▲' : '▼')}
              </th>
              <th onClick={() => handleSort('city')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                City {sortField === 'city' && (sortDirection === 'asc' ? '▲' : '▼')}
              </th>
              <th onClick={() => handleSort('projects')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                Projects {sortField === 'projects' && (sortDirection === 'asc' ? '▲' : '▼')}
              </th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {customers && customers.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: '20px' }}>
                  No customers found. Create your first customer above.
                </td>
              </tr>
            )}
            {sortedCustomers.map((customer: any) => (
              <tr key={customer.id}>
                <td>{customer.name}</td>
                <td>{customer.email || '-'}</td>
                <td>{customer.phone || '-'}</td>
                <td>{customer.city || '-'}</td>
                <td>{customer.projects?.length || 0}</td>
                <td style={{ textAlign: 'right' }}>
                  {/* Allow users to edit/delete their own customers, or admins to edit/delete any */}
                  {(user?.id === customer.created_by || isAdmin || customer.created_by === null || customer.created_by === undefined) && (
                    <>
                      <button
                        className="button button-secondary"
                        style={{ marginRight: '5px', padding: '5px 10px', fontSize: '12px' }}
                        onClick={() => handleEdit(customer)}
                      >
                        Edit
                      </button>
                      <button
                        className="button button-danger"
                        style={{ padding: '5px 10px', fontSize: '12px' }}
                        onClick={() => handleDelete(customer.id)}
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
