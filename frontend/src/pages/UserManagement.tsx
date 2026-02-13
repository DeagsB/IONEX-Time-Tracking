import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { usersService } from '../services/supabaseServices';

export default function UserManagement() {
  const { user, isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [showArchived, setShowArchived] = useState(false);

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
    queryFn: () => usersService.getAll(true),
  });

  const updateRoleMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: 'ADMIN' | 'USER' | 'DEVELOPER' }) => {
      return await usersService.updateUserRole(userId, role);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (userId: string) => usersService.archiveUser(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const unarchiveMutation = useMutation({
    mutationFn: (userId: string) => usersService.unarchiveUser(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (userId: string) => {
      return await usersService.deleteUser(userId);
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
  }) || [];

  const activeUsers = filteredUsers.filter((u: any) => !u.archived);
  const archivedUsers = filteredUsers.filter((u: any) => u.archived);

  const handleRoleChange = (userId: string, newRole: 'ADMIN' | 'USER' | 'DEVELOPER') => {
    if (window.confirm(`Are you sure you want to change this user's role to ${newRole}?`)) {
      updateRoleMutation.mutate({ userId, role: newRole });
    }
  };

  const handleArchive = (userId: string, isArchived: boolean) => {
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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'center', marginBottom: '20px' }}>
          <input
            type="text"
            className="input"
            placeholder="Search by name or email..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ flex: '1', minWidth: '200px', maxWidth: '400px' }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>Show Archived</span>
          </label>
        </div>

        {isLoading ? (
          <div style={{ textAlign: 'center', padding: '40px' }}>Loading users...</div>
        ) : (
          <>
            {/* Active Users */}
            <div style={{ marginBottom: showArchived ? '24px' : 0 }}>
              <h3 style={{ marginBottom: '16px', fontSize: '18px', fontWeight: '600' }}>
                Active Users ({activeUsers.length})
              </h3>
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
                  {activeUsers.length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', padding: '20px' }}>
                        No active users found.
                      </td>
                    </tr>
                  )}
                  {activeUsers.map((u: any) => (
                    <tr key={u.id}>
                      <td>{u.first_name} {u.last_name}</td>
                      <td>{u.email}</td>
                      <td>
                        <select
                          className="input"
                          value={u.role || 'USER'}
                          onChange={(e) => handleRoleChange(u.id, e.target.value as 'ADMIN' | 'USER' | 'DEVELOPER')}
                          style={{ padding: '4px 8px', fontSize: '13px', minWidth: '120px' }}
                        >
                          <option value="USER">USER</option>
                          <option value="ADMIN">ADMIN</option>
                          <option value="DEVELOPER">DEVELOPER</option>
                        </select>
                      </td>
                      <td>
                        <span style={{
                          backgroundColor: 'var(--success-color)',
                          color: 'white',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontSize: '10px',
                          fontWeight: 'bold',
                        }}>
                          ACTIVE
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'flex-end' }}>
                          {u.id === user?.id && (
                            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', marginRight: '8px' }}>
                              (You)
                            </span>
                          )}
                          {u.id !== user?.id && (
                            <>
                              <button
                                className="button button-secondary"
                                style={{ padding: '5px 10px', fontSize: '12px' }}
                                onClick={() => handleArchive(u.id, false)}
                                disabled={archiveMutation.isPending}
                              >
                                {archiveMutation.isPending ? 'Archiving...' : 'Archive'}
                              </button>
                              <button
                                className="button button-danger"
                                style={{ padding: '5px 10px', fontSize: '12px' }}
                                onClick={() => handleDeleteUser(u.id, `${u.first_name} ${u.last_name}`)}
                                disabled={deleteUserMutation.isPending}
                              >
                                {deleteUserMutation.isPending ? 'Deleting...' : 'Delete'}
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Archived Users */}
            {showArchived && (
              <div>
                <h3 style={{ marginBottom: '16px', fontSize: '18px', fontWeight: '600', color: 'var(--text-secondary)' }}>
                  Archived Users ({archivedUsers.length})
                </h3>
                <p style={{ marginBottom: '16px', fontSize: '14px', color: 'var(--text-tertiary)' }}>
                  Archived users are hidden from reports and the application, but their data is preserved.
                </p>
                {archivedUsers.length === 0 ? (
                  <p style={{ color: 'var(--text-secondary)' }}>No archived users found.</p>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Email</th>
                        <th>Role</th>
                        <th>Archived Date</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {archivedUsers.map((u: any) => (
                        <tr key={u.id} style={{ opacity: 0.7 }}>
                          <td>{u.first_name} {u.last_name}</td>
                          <td>{u.email}</td>
                          <td>
                            <span style={{
                              padding: '4px 8px',
                              borderRadius: '4px',
                              fontSize: '12px',
                              fontWeight: '500',
                              backgroundColor: u.role === 'ADMIN' ? 'var(--primary-light)' : 'var(--bg-tertiary)',
                              color: u.role === 'ADMIN' ? 'var(--primary-color)' : 'var(--text-secondary)',
                            }}>
                              {u.role}
                            </span>
                          </td>
                          <td>
                            {u.archived_at ? new Date(u.archived_at).toLocaleDateString() : 'N/A'}
                          </td>
                          <td>
                            <button
                              className="button button-primary"
                              style={{ padding: '6px 12px', fontSize: '12px' }}
                              onClick={() => handleArchive(u.id, true)}
                              disabled={unarchiveMutation.isPending}
                            >
                              {unarchiveMutation.isPending ? 'Unarchiving...' : 'Unarchive'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </>
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
