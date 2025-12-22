import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { employeesService } from '../services/supabaseServices';

export default function Employees() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<any>(null);
  const [formData, setFormData] = useState({
    user_id: '', // Will need to fetch users to link
    employee_id: '',
    wage_rate: '',
    hourly_rate: '',
    salary: '',
    hire_date: new Date().toISOString().split('T')[0],
    department: '',
    position: '',
    status: 'active',
  });

  const { data: employees } = useQuery({
    queryKey: ['employees'],
    queryFn: () => employeesService.getAll(),
  });

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      // Convert form data to DB format
      const employeeData = {
        ...data,
        wage_rate: parseFloat(data.wage_rate),
        hourly_rate: data.hourly_rate ? parseFloat(data.hourly_rate) : null,
        salary: data.salary ? parseFloat(data.salary) : null,
      };
      return await employeesService.create(employeeData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] });
      setShowForm(false);
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const employeeData = {
        ...data,
        wage_rate: parseFloat(data.wage_rate),
        hourly_rate: data.hourly_rate ? parseFloat(data.hourly_rate) : null,
        salary: data.salary ? parseFloat(data.salary) : null,
      };
      return await employeesService.update(id, employeeData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] });
      setEditingEmployee(null);
      resetForm();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await employeesService.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] });
    },
  });

  const resetForm = () => {
    setFormData({
      user_id: '',
      employee_id: '',
      wage_rate: '',
      hourly_rate: '',
      salary: '',
      hire_date: new Date().toISOString().split('T')[0],
      department: '',
      position: '',
      status: 'active',
    });
  };

  const handleEdit = (employee: any) => {
    setEditingEmployee(employee);
    setFormData({
      user_id: employee.user_id || '',
      employee_id: employee.employee_id || '',
      wage_rate: employee.wage_rate?.toString() || '',
      hourly_rate: employee.hourly_rate?.toString() || '',
      salary: employee.salary?.toString() || '',
      hire_date: employee.hire_date || '',
      department: employee.department || '',
      position: employee.position || '',
      status: employee.status || 'active',
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

  const handleDelete = (id: string) => {
    if (window.confirm('Are you sure you want to delete this employee?')) {
      deleteMutation.mutate(id);
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
              <label className="label">Employee ID</label>
              <input
                type="text"
                className="input"
                value={formData.employee_id}
                onChange={(e) => setFormData({ ...formData, employee_id: e.target.value })}
                required
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">First Name</label>
                <input type="text" className="input" placeholder="Linked to User" disabled />
              </div>
              <div className="form-group">
                <label className="label">Last Name</label>
                <input type="text" className="input" placeholder="Linked to User" disabled />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
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
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">Wage Rate</label>
                <input
                  type="number"
                  step="0.01"
                  className="input"
                  value={formData.wage_rate}
                  onChange={(e) => setFormData({ ...formData, wage_rate: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label className="label">Hourly Rate (Billing)</label>
                <input
                  type="number"
                  step="0.01"
                  className="input"
                  value={formData.hourly_rate}
                  onChange={(e) => setFormData({ ...formData, hourly_rate: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="label">Salary (Annual)</label>
                <input
                  type="number"
                  step="0.01"
                  className="input"
                  value={formData.salary}
                  onChange={(e) => setFormData({ ...formData, salary: e.target.value })}
                />
              </div>
            </div>

            <div className="form-group">
              <label className="label">Hire Date</label>
              <input
                type="date"
                className="input"
                value={formData.hire_date}
                onChange={(e) => setFormData({ ...formData, hire_date: e.target.value })}
                required
              />
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
              <th>ID</th>
              <th>Name</th>
              <th>Department</th>
              <th>Position</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {employees?.map((employee: any) => (
              <tr key={employee.id}>
                <td>{employee.employee_id}</td>
                <td>{employee.user ? `${employee.user.first_name} ${employee.user.last_name}` : 'Unlinked'}</td>
                <td>{employee.department}</td>
                <td>{employee.position}</td>
                <td>{employee.status}</td>
                <td>
                  <button
                    className="button button-secondary"
                    style={{ marginRight: '5px', padding: '5px 10px', fontSize: '12px' }}
                    onClick={() => handleEdit(employee)}
                  >
                    Edit
                  </button>
                  <button
                    className="button button-danger"
                    style={{ padding: '5px 10px', fontSize: '12px' }}
                    onClick={() => handleDelete(employee.id)}
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
