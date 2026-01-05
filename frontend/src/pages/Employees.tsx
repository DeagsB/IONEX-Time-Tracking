import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { employeesService, usersService } from '../services/supabaseServices';

export default function Employees() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<any>(null);
  const [formData, setFormData] = useState({
    user_id: '', // Will need to fetch users to link
    employee_id: '',
    hire_date: new Date().toISOString().split('T')[0],
    department: '',
    position: '',
    status: 'active',
    // Billable rates for service tickets
    rt_rate: '110.00',
    tt_rate: '85.00',
    ft_rate: '140.00',
    shop_ot_rate: '165.00',
    field_ot_rate: '165.00',
    // Pay rates (what employee gets paid)
    shop_pay_rate: '25.00',
    field_pay_rate: '30.00',
    shop_ot_pay_rate: '37.50',
    field_ot_pay_rate: '45.00',
  });

  const { data: employees, isLoading, error } = useQuery({
    queryKey: ['employees'],
    queryFn: () => employeesService.getAll(),
  });

  // Log errors separately
  if (error) {
    console.error('Error fetching employees:', error);
  }

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      // Convert form data to DB format
      const employeeData = {
        user_id: data.user_id || null,
        employee_id: data.employee_id,
        hire_date: data.hire_date,
        department: data.department || null,
        position: data.position || null,
        status: data.status || 'active',
        wage_rate: data.wage_rate ? parseFloat(data.wage_rate) : 25.00,
        rt_rate: data.rt_rate ? parseFloat(data.rt_rate) : 110.00,
        tt_rate: data.tt_rate ? parseFloat(data.tt_rate) : 85.00,
        ft_rate: data.ft_rate ? parseFloat(data.ft_rate) : 140.00,
        shop_ot_rate: data.shop_ot_rate ? parseFloat(data.shop_ot_rate) : 165.00,
        field_ot_rate: data.field_ot_rate ? parseFloat(data.field_ot_rate) : 165.00,
        shop_pay_rate: data.shop_pay_rate ? parseFloat(data.shop_pay_rate) : 25.00,
        field_pay_rate: data.field_pay_rate ? parseFloat(data.field_pay_rate) : 30.00,
        shop_ot_pay_rate: data.shop_ot_pay_rate ? parseFloat(data.shop_ot_pay_rate) : 37.50,
        field_ot_pay_rate: data.field_ot_pay_rate ? parseFloat(data.field_ot_pay_rate) : 45.00,
      };
      return await employeesService.create(employeeData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] });
      setShowForm(false);
      resetForm();
    },
    onError: (error: any) => {
      console.error('Error creating employee:', error);
      alert(`Failed to create employee: ${error.message || 'Unknown error'}`);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data, existingEmployee }: { id: string; data: any; existingEmployee: any }) => {
      const employeeData: any = {
        employee_id: data.employee_id,
        hire_date: data.hire_date,
        department: data.department || null,
        position: data.position || null,
        status: data.status || 'active',
        wage_rate: existingEmployee?.wage_rate || 25.00, // Preserve existing wage_rate
        rt_rate: data.rt_rate ? parseFloat(data.rt_rate) : 110.00,
        tt_rate: data.tt_rate ? parseFloat(data.tt_rate) : 85.00,
        ft_rate: data.ft_rate ? parseFloat(data.ft_rate) : 140.00,
        shop_ot_rate: data.shop_ot_rate ? parseFloat(data.shop_ot_rate) : 165.00,
        field_ot_rate: data.field_ot_rate ? parseFloat(data.field_ot_rate) : 165.00,
        shop_pay_rate: data.shop_pay_rate ? parseFloat(data.shop_pay_rate) : 25.00,
        field_pay_rate: data.field_pay_rate ? parseFloat(data.field_pay_rate) : 30.00,
        shop_ot_pay_rate: data.shop_ot_pay_rate ? parseFloat(data.shop_ot_pay_rate) : 37.50,
        field_ot_pay_rate: data.field_ot_pay_rate ? parseFloat(data.field_ot_pay_rate) : 45.00,
      };
      return await employeesService.update(id, employeeData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] });
      setEditingEmployee(null);
      setShowForm(false);
      resetForm();
    },
    onError: (error: any) => {
      console.error('Error updating employee:', error);
      let errorMessage = error.message || 'Unknown error';
      
      // Provide helpful message if columns are missing
      if (errorMessage.includes("Could not find") && errorMessage.includes("column")) {
        errorMessage = `Database schema error: Missing required columns. Please run the migration 'migration_add_billable_rates.sql' in your Supabase SQL Editor. Error: ${errorMessage}`;
      }
      
      alert(`Failed to update employee: ${errorMessage}`);
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
      hire_date: new Date().toISOString().split('T')[0],
      department: '',
      position: '',
      status: 'active',
      rt_rate: '110.00',
      tt_rate: '85.00',
      ft_rate: '140.00',
      shop_ot_rate: '165.00',
      field_ot_rate: '165.00',
      shop_pay_rate: '25.00',
      field_pay_rate: '30.00',
      shop_ot_pay_rate: '37.50',
      field_ot_pay_rate: '45.00',
    });
  };

  const handleEdit = (employee: any) => {
    setEditingEmployee(employee);
    setFormData({
      user_id: employee.user_id || '',
      employee_id: employee.employee_id || '',
      hire_date: employee.hire_date || '',
      department: employee.department || '',
      position: employee.position || '',
      status: employee.status || 'active',
      rt_rate: employee.rt_rate?.toString() || '110.00',
      tt_rate: employee.tt_rate?.toString() || '85.00',
      ft_rate: employee.ft_rate?.toString() || '140.00',
      shop_ot_rate: employee.shop_ot_rate?.toString() || '165.00',
      field_ot_rate: employee.field_ot_rate?.toString() || '165.00',
      shop_pay_rate: employee.shop_pay_rate?.toString() || '25.00',
      field_pay_rate: employee.field_pay_rate?.toString() || '30.00',
      shop_ot_pay_rate: employee.shop_ot_pay_rate?.toString() || '37.50',
      field_ot_pay_rate: employee.field_ot_pay_rate?.toString() || '45.00',
    });
    setShowForm(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingEmployee) {
      updateMutation.mutate({ id: editingEmployee.id, data: formData, existingEmployee: editingEmployee });
    } else {
      createMutation.mutate(formData);
    }
  };

  const handleDelete = (id: string) => {
    if (window.confirm('Are you sure you want to delete this employee?')) {
      deleteMutation.mutate(id);
    }
  };

  const archiveMutation = useMutation({
    mutationFn: (userId: string) => usersService.archiveUser(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] });
    },
  });

  const unarchiveMutation = useMutation({
    mutationFn: (userId: string) => usersService.unarchiveUser(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] });
    },
  });

  const handleToggleArchive = (userId: string, isArchived: boolean) => {
    const action = isArchived ? 'unarchive' : 'archive';
    const message = isArchived
      ? 'Are you sure you want to unarchive this user? Their data will be visible again in reports and the application.'
      : 'Are you sure you want to archive this user? Their data will be hidden from reports and the application, but will be preserved.';

    if (window.confirm(message)) {
      if (isArchived) {
        unarchiveMutation.mutate(userId);
      } else {
        archiveMutation.mutate(userId);
      }
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

            <h4 style={{ marginTop: '20px', marginBottom: '10px', borderTop: '1px solid var(--border-color)', paddingTop: '15px' }}>
              Billable Rates (Service Tickets)
            </h4>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">Regular Time (RT)</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.rt_rate}
                    onChange={(e) => setFormData({ ...formData, rt_rate: e.target.value })}
                    placeholder="110.00"
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="label">Travel Time (TT)</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.tt_rate}
                    onChange={(e) => setFormData({ ...formData, tt_rate: e.target.value })}
                    placeholder="85.00"
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="label">Field Time (FT)</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.ft_rate}
                    onChange={(e) => setFormData({ ...formData, ft_rate: e.target.value })}
                    placeholder="140.00"
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="label">Shop OT Rate</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.shop_ot_rate}
                    onChange={(e) => setFormData({ ...formData, shop_ot_rate: e.target.value })}
                    placeholder="165.00"
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="label">Field OT Rate</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.field_ot_rate}
                    onChange={(e) => setFormData({ ...formData, field_ot_rate: e.target.value })}
                    placeholder="165.00"
                  />
                </div>
              </div>
            </div>

            <h4 style={{ marginTop: '20px', marginBottom: '10px', borderTop: '1px solid var(--border-color)', paddingTop: '15px' }}>
              Pay Rates (Employee Compensation)
            </h4>
            <p style={{ fontSize: '0.9em', color: 'var(--text-secondary)', marginBottom: '15px' }}>
              Note: Travel time is paid at the Shop Rate
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="label">Shop Pay Rate</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.shop_pay_rate}
                    onChange={(e) => setFormData({ ...formData, shop_pay_rate: e.target.value })}
                    placeholder="25.00"
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="label">Field Pay Rate</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.field_pay_rate}
                    onChange={(e) => setFormData({ ...formData, field_pay_rate: e.target.value })}
                    placeholder="30.00"
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="label">Shop OT Pay Rate</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.shop_ot_pay_rate}
                    onChange={(e) => setFormData({ ...formData, shop_ot_pay_rate: e.target.value })}
                    placeholder="37.50"
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="label">Field OT Pay Rate</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    style={{ paddingLeft: '25px' }}
                    value={formData.field_ot_pay_rate}
                    onChange={(e) => setFormData({ ...formData, field_ot_pay_rate: e.target.value })}
                    placeholder="45.00"
                  />
                </div>
              </div>
            </div>

            <button 
              type="submit" 
              className="button button-primary"
              disabled={updateMutation.isPending || createMutation.isPending}
            >
              {updateMutation.isPending || createMutation.isPending 
                ? 'Saving...' 
                : editingEmployee 
                  ? 'Update' 
                  : 'Create'} Employee
            </button>
          </form>
        </div>
      )}

      <div className="card">
        {isLoading && (
          <div style={{ textAlign: 'center', padding: '20px' }}>Loading employees...</div>
        )}
        {error && (
          <div style={{ textAlign: 'center', padding: '20px', color: 'var(--error-color)' }}>
            Error loading employees: {error instanceof Error ? error.message : 'Unknown error'}
          </div>
        )}
        {!isLoading && !error && (!employees || (Array.isArray(employees) && employees.length === 0)) && (
          <div style={{ textAlign: 'center', padding: '20px' }}>
            No employees found. Click "Add Employee" to create one.
          </div>
        )}
        {!isLoading && !error && employees && Array.isArray(employees) && employees.length > 0 && (
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
              {employees.map((employee: any) => (
              <tr key={employee.id}>
                <td>{employee.employee_id}</td>
                <td>
                  {employee.user ? (
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                      <span>{`${employee.user.first_name} ${employee.user.last_name}`}</span>
                      {employee.user.archived && (
                        <span
                          style={{
                            padding: '2px 6px',
                            borderRadius: '4px',
                            fontSize: '10px',
                            backgroundColor: 'var(--warning-color)',
                            color: 'white',
                            fontWeight: '500',
                          }}
                          title="User is archived - data hidden from reports"
                        >
                          ARCHIVED
                        </span>
                      )}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        {employee.user.email}
                      </div>
                    </div>
                  ) : (
                    'Unlinked'
                  )}
                </td>
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
                  {employee.user && (
                    <button
                      className="button"
                      style={{
                        marginRight: '5px',
                        padding: '5px 10px',
                        fontSize: '12px',
                        backgroundColor: employee.user.archived ? 'var(--success-color)' : 'var(--warning-color)',
                        color: 'white',
                        border: 'none',
                      }}
                      onClick={() => handleToggleArchive(employee.user.id, employee.user.archived)}
                      title={employee.user.archived ? 'Unarchive user' : 'Archive user'}
                    >
                      {employee.user.archived ? 'Unarchive' : 'Archive'}
                    </button>
                  )}
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
        )}
      </div>
    </div>
  );
}
