import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { customersService } from '../services/supabaseServices';

export default function Customers() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<any>(null);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    state: '',
    zip_code: '',
    country: '',
    tax_id: '',
    notes: '',
  });

  const { data: customers } = useQuery({
    queryKey: ['customers'],
    queryFn: () => customersService.getAll(),
  });

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      return await customersService.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setShowForm(false);
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      return await customersService.update(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setEditingCustomer(null);
      resetForm();
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
      email: '',
      phone: '',
      address: '',
      city: '',
      state: '',
      zip_code: '',
      country: '',
      tax_id: '',
      notes: '',
    });
  };

  const handleEdit = (customer: any) => {
    setEditingCustomer(customer);
    setFormData({
      name: customer.name || '',
      email: customer.email || '',
      phone: customer.phone || '',
      address: customer.address || '',
      city: customer.city || '',
      state: customer.state || '',
      zip_code: customer.zip_code || '',
      country: customer.country || '',
      tax_id: customer.tax_id || '',
      notes: customer.notes || '',
    });
    setShowForm(true);
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

  if (user?.role !== 'ADMIN') {
    return (
      <div>
        <h2>Customers</h2>
        <div className="card">
          <p>You don't have permission to view this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2>Customers</h2>
        <button className="button button-primary" onClick={() => { setShowForm(!showForm); setEditingCustomer(null); resetForm(); }}>
          {showForm ? 'Cancel' : 'Add Customer'}
        </button>
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: '20px' }}>
          <h3>{editingCustomer ? 'Edit Customer' : 'New Customer'}</h3>
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

            <button type="submit" className="button button-primary" disabled={createMutation.isPending || updateMutation.isPending}>
              {editingCustomer ? 'Update' : 'Create'} Customer
            </button>
          </form>
        </div>
      )}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>City</th>
              <th>Projects</th>
              <th>Actions</th>
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
            {customers?.map((customer: any) => (
              <tr key={customer.id}>
                <td>{customer.name}</td>
                <td>{customer.email || '-'}</td>
                <td>{customer.phone || '-'}</td>
                <td>{customer.city || '-'}</td>
                <td>{customer.projects?.length || 0}</td>
                <td>
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
