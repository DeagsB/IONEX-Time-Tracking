import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { usersService } from '../services/supabaseServices';

export default function UserManagement() {
  const { user, isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');

  // Redirect if not admin
  if (!isAdmin) {
    return (
      <div style={{ padding: '40px', textAlign: 'center' }}>
        <h2>Access Denied</h2>
        <p>You must be an admin to access this page.</p>
      </div>
    );
  }

  const { data: users, isLoading } = useQuery({
    queryKey: ['users', 'all'],
    queryFn: () => usersService.getAll(true), // Include archived users
  });

  const updateRoleMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: 'ADMIN' | 'USER' | 'DEVELOPER' }) => {
      return await usersService.updateUserRole(userId, role);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const filteredUsers = users?.filter((u: any) => {
    const searchLower = searchTerm.toLowerCase();
    return (
      u.email?.toLowerCase().includes(searchLower) ||
      u.first_name?.toLowerCase().includes(searchLower) ||
      u.last_name?.toLowerCase().includes(searchLower)
    );
  });

  const handleRoleChange = (userId: string, newRole: 'ADMIN' | 'USER' | 'DEVELOPER') => {
    if (window.confirm(`Are you sure you want to change this user's role to ${newRole}?`)) {
      updateRoleMutation.mutate({ userId, role: newRole });
    }
  };

  const deleteUserMutation = useMutation({
    mutationFn: async (userId: string) => {
      return await usersService.deleteUser(userId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const handleDeleteUser = (userId: string, userName: string) => {
    if (userId === user?.id) {
      alert('You cannot delete your own account.');
      return;
    }
    
    if (window.confirm(`Are you sure you want to delete ${userName}? This will remove their user account but preserve their employee record and time entries. This action cannot be undone.`)) {
      deleteUserMutation.mutate(userId);
    }
  };

  return (
    <div style={{ padding: '40px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <h1>User Management</h1>
      </div>

      <div className="card" style={{ marginBottom: '20px' }}>
        <div style={{ marginBottom: '20px' }}>
          <input
            type="text"
            className="input"
            placeholder="Search by name or email..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ width: '100%', maxWidth: '400px' }}
          />
        </div>

        {isLoading ? (
          <div style={{ textAlign: 'center', padding: '40px' }}>Loading users...</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers && filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: '20px' }}>
                    No users found.
                  </td>
                </tr>
              )}
              {filteredUsers?.map((u: any) => (
                <tr key={u.id}>
                  <td>
                    {u.first_name} {u.last_name}
                  </td>
                  <td>{u.email}</td>
                  <td>
                    <select
                      className="input"
                      value={u.role || 'USER'}
                      onChange={(e) => handleRoleChange(u.id, e.target.value as 'ADMIN' | 'USER' | 'DEVELOPER')}
                      style={{ 
                        padding: '4px 8px', 
                        fontSize: '13px',
                        minWidth: '120px'
                      }}
                    >
                      <option value="USER">USER</option>
                      <option value="ADMIN">ADMIN</option>
                      <option value="DEVELOPER">DEVELOPER</option>
                    </select>
                  </td>
                  <td>
                    {u.archived ? (
                      <span style={{ 
                        backgroundColor: 'var(--warning-color)', 
                        color: 'white', 
                        padding: '2px 6px', 
                        borderRadius: '4px', 
                        fontSize: '10px', 
                        fontWeight: 'bold'
                      }}>
                        ARCHIVED
                      </span>
                    ) : (
                      <span style={{ 
                        backgroundColor: 'var(--success-color)', 
                        color: 'white', 
                        padding: '2px 6px', 
                        borderRadius: '4px', 
                        fontSize: '10px', 
                        fontWeight: 'bold'
                      }}>
                        ACTIVE
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'flex-end' }}>
                      {u.id === user?.id && (
                        <span style={{ 
                          fontSize: '12px',
                          color: 'var(--text-secondary)',
                          marginRight: '8px'
                        }}>
                          (You)
                        </span>
                      )}
                      {u.id !== user?.id && (
                        <button
                          className="button button-danger"
                          style={{ 
                            padding: '5px 10px', 
                            fontSize: '12px',
                            marginLeft: 'auto'
                          }}
                          onClick={() => handleDeleteUser(u.id, `${u.first_name} ${u.last_name}`)}
                          disabled={deleteUserMutation.isPending}
                        >
                          {deleteUserMutation.isPending ? 'Deleting...' : 'Delete'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ backgroundColor: 'var(--info-light)', border: '1px solid var(--info-color)' }}>
        <h3 style={{ marginBottom: '10px', fontSize: '16px' }}>About User Roles</h3>
        <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', lineHeight: '1.6' }}>
          <li><strong>USER:</strong> Standard user with basic access to time tracking and projects.</li>
          <li><strong>ADMIN:</strong> Full access including employee reports, service tickets, payroll, and user management.</li>
          <li><strong>DEVELOPER:</strong> Can switch between USER and ADMIN modes for testing purposes.</li>
        </ul>
      </div>
    </div>
  );
}

