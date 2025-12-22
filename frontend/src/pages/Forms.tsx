import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { formsService } from '../services/supabaseServices';

export default function Forms() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    type: 'time-off',
    title: '',
    content: '',
  });

  const { data: forms } = useQuery({
    queryKey: ['forms'],
    queryFn: () => formsService.getAll(),
  });

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      // In a real app, we'd look up the employee ID for the current user
      // For now, we'll assume there's a mapping or pass user ID if allowed
      // This is a placeholder since we haven't fully implemented the user-employee link logic in frontend
      alert("Note: Create form requires Employee record linking. Implemented in backend schema.");
      return null; 
      // return await formsService.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forms'] });
      setShowForm(false);
      setFormData({ type: 'time-off', title: '', content: '' });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate(formData);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2>Forms & Requests</h2>
        <button className="button button-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : 'New Request'}
        </button>
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: '20px' }}>
          <h3>Submit New Request</h3>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="label">Type</label>
              <select
                className="input"
                value={formData.type}
                onChange={(e) => setFormData({ ...formData, type: e.target.value })}
              >
                <option value="time-off">Time Off Request</option>
                <option value="expense">Expense Reimbursement</option>
                <option value="incident">Incident Report</option>
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
              <label className="label">Details</label>
              <textarea
                className="input"
                rows={5}
                value={formData.content}
                onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                required
              />
            </div>

            <button type="submit" className="button button-primary">
              Submit Request
            </button>
          </form>
        </div>
      )}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Title</th>
              <th>Status</th>
              <th>Submitted By</th>
            </tr>
          </thead>
          <tbody>
            {forms?.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '20px' }}>
                  No forms submitted.
                </td>
              </tr>
            )}
            {forms?.map((form: any) => (
              <tr key={form.id}>
                <td>{new Date(form.submitted_at).toLocaleDateString()}</td>
                <td style={{ textTransform: 'capitalize' }}>{form.form_type}</td>
                <td>{form.title}</td>
                <td>
                  <span style={{
                    padding: '4px 8px',
                    borderRadius: '4px',
                    backgroundColor: 
                      form.status === 'approved' ? '#dcfce7' : 
                      form.status === 'rejected' ? '#fee2e2' : '#fef9c3',
                    color: 
                      form.status === 'approved' ? '#166534' : 
                      form.status === 'rejected' ? '#991b1b' : '#854d0e',
                    fontSize: '12px',
                    fontWeight: '500',
                    textTransform: 'uppercase'
                  }}>
                    {form.status}
                  </span>
                </td>
                <td>{form.employee?.user ? `${form.employee.user.first_name} ${form.employee.user.last_name}` : 'Unknown'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
