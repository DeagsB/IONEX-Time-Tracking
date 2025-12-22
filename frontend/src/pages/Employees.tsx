import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';

export default function Employees() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<any>(null);
  const [formData, setFormData] = useState({
    userId: '',
    employeeId: '',
    wageRate: '',
    hourlyRate: '',
    salary: '',
    hireDate: new Date().toISOString().split('T')[0],
    department: '',
    position: '',
    status: 'active',
  });

  const { data: employees } = useQuery({
    queryKey: ['employees'],
    queryFn: async () => {
      const response = await axios.get('/api/employees');
      return response.data;
    },
  });

  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: async () => {
      const response = await axios.get('/api/users');
      return response.data;
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const response = await axios.post('/api/employees', data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] });
      setShowForm(false);
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const response = await axios.put(`/api/employees/${id}`, data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] });
      setEditingEmployee(null);
      resetForm();
    },
  });

  const resetForm = () => {
    setFormData({
      userId: '',
      employeeId: '',
      wageRate: '',
      hourlyRate: '',
      salary: '',
      hireDate: new Date().toISOString().split('T')[0],
      department: '',
      position: '',
      status: 'active',
    });
  };

  const handleEdit = (employee: any) => {
    setEditingEmployee(employee);
    setFormData({
      userId: employee.userId,
      employeeId: employee.employeeId,
      wageRate: employee.wageRate.toString(),
      hourlyRate: employee.hourlyRate?.toString() || '',
      salary: employee.salary?.toString() || '',
      hireDate: new Date(employee.hireDate).toISOString().split('T')[0],
      department: employee.department || '',
      position: employee.position || '',
      status: employee.status,
    });
    setShowForm(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingEmployee) {
      updateMutation.mutate({ id: editingEmployee.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2>Employees</h2>
        <button className="button button-primary" onClick={() => { setShowForm(!showForm); setEditingEmployee(null); resetForm(); }}>
          {showForm ? 'Cancel' : 'Add Employee'}
        </button>
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: '20px' }}>
          <h3>{editingEmployee ? 'Edit Employee' : 'New Employee'}</h3>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="label">User</label>
              <select
                className="input"
                value={formData.userId}
                onChange={(e) => setFormData({ ...formData, userId: e.target.value })}
                required
                disabled={!!editingEmployee}
              >
                <option value="">Select User</option>
                {users?.filter((u: any) => !u.employee).map((user: any) => (
                  <option key={user.id} value={user.id}>
                    {user.firstName} {user.lastName} ({user.email})
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label className="label">Employee ID *</label>
              <input
                type="text"
                className="input"
                value={formData.employeeId}
                onChange={(e) => setFormData({ ...formData, employeeId: e.target.value })}
                required
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">Wage Rate ($) *</label>
                <input
                  type="number"
                  step="0.01"
                  className="input"
                  value={formData.wageRate}
                  onChange={(e) => setFormData({ ...formData, wageRate: e.target.value })}
                  required
                />
              </div>

              <div className="form-group">
                <label className="label">Hourly Rate ($)</label>
                <input
                  type="number"
                  step="0.01"
                  className="input"
                  value={formData.hourlyRate}
                  onChange={(e) => setFormData({ ...formData, hourlyRate: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label className="label">Salary ($)</label>
                <input
                  type="number"
                  step="0.01"
                  className="input"
                  value={formData.salary}
                  onChange={(e) => setFormData({ ...formData, salary: e.target.value })}
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">Hire Date *</label>
                <input
                  type="date"
                  className="input"
                  value={formData.hireDate}
                  onChange={(e) => setFormData({ ...formData, hireDate: e.target.value })}
                  required
                />
              </div>

              <div className="form-group">
                <label className="label">Department</label>
                <input
                  type="text"
                  className="input"
                  value={formData.department}
                  onChange={(e) => setFormData({ ...formData, department: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label className="label">Position</label>
                <input
                  type="text"
                  className="input"
                  value={formData.position}
                  onChange={(e) => setFormData({ ...formData, position: e.target.value })}
                />
              </div>
            </div>

            <div className="form-group">
              <label className="label">Status</label>
              <select
                className="input"
                value={formData.status}
                onChange={(e) => setFormData({ ...formData, status: e.target.value })}
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="terminated">Terminated</option>
              </select>
            </div>

            <button type="submit" className="button button-primary">
              {editingEmployee ? 'Update' : 'Create'} Employee
            </button>
          </form>
        </div>
      )}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Employee ID</th>
              <th>Name</th>
              <th>Email</th>
              <th>Wage Rate</th>
              <th>Department</th>
              <th>Position</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {employees?.map((employee: any) => (
              <tr key={employee.id}>
                <td>{employee.employeeId}</td>
                <td>{employee.user?.firstName} {employee.user?.lastName}</td>
                <td>{employee.user?.email}</td>
                <td>${employee.wageRate}/hr</td>
                <td>{employee.department || '-'}</td>
                <td>{employee.position || '-'}</td>
                <td>{employee.status}</td>
                <td>
                  <button
                    className="button button-secondary"
                    style={{ padding: '5px 10px', fontSize: '12px' }}
                    onClick={() => handleEdit(employee)}
                  >
                    Edit
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

