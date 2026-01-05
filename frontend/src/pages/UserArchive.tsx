import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { usersService } from '../services/supabaseServices';

export default function UserArchive() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const { data: users, isLoading } = useQuery({
    queryKey: ['users', showArchived],
    queryFn: () => usersService.getAll(showArchived),
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

  const handleArchive = (userId: string, isArchived: boolean) => {
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

  if (user?.role !== 'ADMIN') {
    return (
      <div>
        <h2>User Archive</h2>
        <div className="card">
          <p>You don't have permission to view this page.</p>
        </div>
      </div>
    );
  }

  const filteredUsers = users?.filter((u: any) => {
    if (!searchTerm) return true;
    const search = searchTerm.toLowerCase();
    return (
      u.email?.toLowerCase().includes(search) ||
      u.first_name?.toLowerCase().includes(search) ||
      u.last_name?.toLowerCase().includes(search)
    );
  }) || [];

  const activeUsers = filteredUsers.filter((u: any) => !u.archived);
  const archivedUsers = filteredUsers.filter((u: any) => u.archived);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h2>User Archive</h2>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <input
            type="text"
            placeholder="Search users..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              padding: '8px 12px',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              fontSize: '14px',
              width: '250px',
              backgroundColor: 'var(--input-bg)',
              color: 'var(--text-primary)',
            }}
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
      </div>

      {isLoading ? (
        <div className="card">
          <p>Loading users...</p>
        </div>
      ) : (
        <>
          {/* Active Users Section */}
          <div className="card" style={{ marginBottom: '24px' }}>
            <h3 style={{ marginBottom: '16px', fontSize: '18px', fontWeight: '600' }}>
              Active Users ({activeUsers.length})
            </h3>
            {activeUsers.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)' }}>No active users found.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Created</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {activeUsers.map((u: any) => (
                    <tr key={u.id}>
                      <td>
                        {u.first_name} {u.last_name}
                      </td>
                      <td>{u.email}</td>
                      <td>
                        <span
                          style={{
                            padding: '4px 8px',
                            borderRadius: '4px',
                            fontSize: '12px',
                            fontWeight: '500',
                            backgroundColor: u.role === 'ADMIN' ? 'var(--primary-light)' : 'var(--bg-tertiary)',
                            color: u.role === 'ADMIN' ? 'var(--primary-color)' : 'var(--text-secondary)',
                          }}
                        >
                          {u.role}
                        </span>
                      </td>
                      <td>{new Date(u.created_at).toLocaleDateString()}</td>
                      <td>
                        <button
                          className="button button-secondary"
                          style={{ padding: '6px 12px', fontSize: '12px' }}
                          onClick={() => handleArchive(u.id, false)}
                          disabled={archiveMutation.isPending}
                        >
                          {archiveMutation.isPending ? 'Archiving...' : 'Archive'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Archived Users Section */}
          {showArchived && (
            <div className="card">
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
                        <td>
                          {u.first_name} {u.last_name}
                        </td>
                        <td>{u.email}</td>
                        <td>
                          <span
                            style={{
                              padding: '4px 8px',
                              borderRadius: '4px',
                              fontSize: '12px',
                              fontWeight: '500',
                              backgroundColor: u.role === 'ADMIN' ? 'var(--primary-light)' : 'var(--bg-tertiary)',
                              color: u.role === 'ADMIN' ? 'var(--primary-color)' : 'var(--text-secondary)',
                            }}
                          >
                            {u.role}
                          </span>
                        </td>
                        <td>
                          {u.archived_at
                            ? new Date(u.archived_at).toLocaleDateString()
                            : 'N/A'}
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
  );
}

