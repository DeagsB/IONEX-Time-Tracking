import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';

export default function Forms() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    formType: 'timesheet',
    title: '',
    content: '',
  });

  const { data: forms } = useQuery({
    queryKey: ['forms'],
    queryFn: async () => {
      const response = await axios.get('/api/forms');
      return response.data;
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const response = await axios.post('/api/forms', data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forms'] });
      setShowForm(false);
      setFormData({ formType: 'timesheet', title: '', content: '' });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const response = await axios.put(`/api/forms/${id}`, data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forms'] });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate(formData);
  };

  const handleApprove = (id: string) => {
    updateMutation.mutate({ id, data: { status: 'approved' } });
  };

  const handleReject = (id: string) => {
    updateMutation.mutate({ id, data: { status: 'rejected' } });
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2>Forms</h2>
        {user?.role !== 'ADMIN' && (
          <button className="button button-primary" onClick={() => setShowForm(!showForm)}>
            {showForm ? 'Cancel' : 'Submit New Form'}
          </button>
        )}
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: '20px' }}>
          <h3>Submit New Form</h3>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="label">Form Type</label>
              <select
                className="input"
                value={formData.formType}
                onChange={(e) => setFormData({ ...formData, formType: e.target.value })}
                required
              >
                <option value="timesheet">Timesheet</option>
                <option value="expense">Expense Report</option>
                <option value="time-off">Time Off Request</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div className="form-group">
              <label className="label">Title</label>
              <input
                type="text"
                className="input"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                required
              />
            </div>

            <div className="form-group">
              <label className="label">Content</label>
              <textarea
                className="input"
                rows={5}
                value={formData.content}
                onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                required
                placeholder="Enter form details..."
              />
            </div>

            <button type="submit" className="button button-primary">
              Submit Form
            </button>
          </form>
        </div>
      )}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Title</th>
              {user?.role === 'ADMIN' && <th>Employee</th>}
              <th>Submitted</th>
              <th>Status</th>
              {user?.role === 'ADMIN' && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {forms?.map((form: any) => (
              <tr key={form.id}>
                <td>{form.formType}</td>
                <td>{form.title}</td>
                {user?.role === 'ADMIN' && (
                  <td>{form.employee?.user?.firstName} {form.employee?.user?.lastName}</td>
                )}
                <td>{new Date(form.submittedAt).toLocaleDateString()}</td>
                <td>
                  <span style={{
                    padding: '4px 8px',
                    borderRadius: '4px',
                    fontSize: '12px',
                    backgroundColor: form.status === 'approved' ? '#d4edda' : form.status === 'rejected' ? '#f8d7da' : '#fff3cd',
                    color: form.status === 'approved' ? '#155724' : form.status === 'rejected' ? '#721c24' : '#856404',
                  }}>
                    {form.status}
                  </span>
                </td>
                {user?.role === 'ADMIN' && form.status === 'pending' && (
                  <td>
                    <button
                      className="button button-secondary"
                      style={{ marginRight: '5px', padding: '5px 10px', fontSize: '12px' }}
                      onClick={() => handleApprove(form.id)}
                    >
                      Approve
                    </button>
                    <button
                      className="button button-danger"
                      style={{ padding: '5px 10px', fontSize: '12px' }}
                      onClick={() => handleReject(form.id)}
                    >
                      Reject
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

