import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';

export default function Sidebar() {
  const location = useLocation();
  const { user, logout } = useAuth();
  const { isDemoMode } = useDemoMode();
  const navigate = useNavigate();
  const isActive = (path: string) => location.pathname === path || location.pathname.startsWith(path);

  const handleSignOut = async () => {
    try {
      await logout();
      navigate('/login');
    } catch (error) {
      console.error('Error signing out:', error);
    }
  };

  return (
    <div style={{
      width: '240px',
      backgroundColor: 'var(--bg-primary)',
      borderRight: '1px solid var(--border-color)',
      height: '100vh',
      position: 'fixed',
      left: 0,
      top: 0,
      padding: '24px 0',
      overflowY: 'auto',
      boxShadow: 'var(--shadow-sm)',
    }}>
      <div style={{ padding: '0 20px', marginBottom: '32px' }}>
        <h2 style={{ 
          fontSize: '18px', 
          fontWeight: '700', 
          color: 'var(--text-primary)',
          letterSpacing: '-0.02em',
        }}>
          IONEX Time Tracking
        </h2>
      </div>

      <div style={{ padding: '0 15px' }}>
        <div style={{ marginBottom: '30px' }}>
          <div style={{ 
            fontSize: '11px', 
            fontWeight: '600', 
            textTransform: 'uppercase', 
            letterSpacing: '1px',
            color: 'var(--text-tertiary)',
            marginBottom: '10px',
            padding: '0 10px'
          }}>
            TRACK
          </div>
          <SidebarLink to="/calendar" active={isActive('/calendar')}>
            Timer
          </SidebarLink>
        </div>

        {user?.role === 'ADMIN' && (
          <div style={{ marginBottom: '30px' }}>
            <div style={{ 
              fontSize: '11px', 
              fontWeight: '600', 
              textTransform: 'uppercase', 
              letterSpacing: '1px',
              color: 'var(--text-tertiary)',
              marginBottom: '10px',
              padding: '0 10px'
            }}>
              ANALYZE
            </div>
            {user?.global_admin && (
              <SidebarLink to="/payroll" active={isActive('/payroll')}>
                Payroll
              </SidebarLink>
            )}
            <SidebarLink to="/service-tickets" active={isActive('/service-tickets')}>
              Service Tickets
            </SidebarLink>
            <SidebarLink to="/employee-reports" active={isActive('/employee-reports')}>
              Employee Reports
            </SidebarLink>
          </div>
        )}

        <div style={{ marginBottom: '30px' }}>
          <div style={{ 
            fontSize: '11px', 
            fontWeight: '600', 
            textTransform: 'uppercase', 
            letterSpacing: '1px',
            color: 'var(--text-tertiary)',
            marginBottom: '10px',
            padding: '0 10px'
          }}>
            MANAGE
          </div>
          <SidebarLink to="/projects" active={isActive('/projects')}>
            Projects
          </SidebarLink>
          <SidebarLink to="/customers" active={isActive('/customers')}>
            Clients
          </SidebarLink>
          {user?.role === 'ADMIN' && (
            <>
              <SidebarLink to="/employees" active={isActive('/employees')}>
                Members
              </SidebarLink>
            </>
          )}
        </div>

        {user?.role === 'ADMIN' && (
          <div style={{ marginBottom: '30px' }}>
            <div style={{ 
              fontSize: '11px', 
              fontWeight: '600', 
              textTransform: 'uppercase', 
              letterSpacing: '1px',
              color: 'var(--text-tertiary)',
              marginBottom: '10px',
              padding: '0 10px'
            }}>
              ADMIN
            </div>
            {user?.global_admin && (
              <SidebarLink to="/user-management" active={isActive('/user-management')}>
                User Management
              </SidebarLink>
            )}
            {!isDemoMode && (
              <SidebarLink to="/profile" active={isActive('/profile')}>
                Profile
              </SidebarLink>
            )}
            <SidebarLink to="/user-archive" active={isActive('/user-archive')}>
              User Archive
            </SidebarLink>
            <SidebarLink to="/settings" active={isActive('/settings')}>
              Settings
            </SidebarLink>
          </div>
        )}
      </div>

      {/* Sign Out Button at Bottom */}
      <div style={{
        position: 'absolute',
        bottom: '24px',
        left: '0',
        right: '0',
        padding: '0 15px'
      }}>
        <button
          onClick={handleSignOut}
          style={{
            width: '100%',
            padding: '12px 16px',
            backgroundColor: 'transparent',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            color: 'var(--text-primary)',
            fontSize: '14px',
            fontWeight: '500',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
            e.currentTarget.style.borderColor = 'var(--error-color)';
            e.currentTarget.style.color = 'var(--error-color)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.style.borderColor = 'var(--border-color)';
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
        >
          <span>🚪</span>
          <span>Sign Out</span>
        </button>
      </div>
    </div>
  );
}

function SidebarLink({ to, active, children }: { to: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      style={{
        display: 'block',
        padding: '10px 16px',
        color: active ? 'var(--logo-red)' : 'var(--text-primary)',
        textDecoration: 'none',
        borderRadius: '8px',
        marginBottom: '4px',
        marginLeft: '8px',
        marginRight: '8px',
        backgroundColor: active ? 'var(--primary-light)' : 'transparent',
        fontWeight: active ? '600' : '400',
        fontSize: '14px',
        transition: 'all 0.2s ease',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.backgroundColor = 'transparent';
        }
      }}
    >
      {children}
    </Link>
  );
}

