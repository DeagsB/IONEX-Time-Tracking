import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';

export default function Sidebar() {
  const location = useLocation();
  const { user } = useAuth();
  const { isDemoMode } = useDemoMode();
  const isActive = (path: string) => location.pathname === path || location.pathname.startsWith(path);

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
          {!isDemoMode && (
            <SidebarLink to="/dashboard" active={isActive('/dashboard')}>
              Overview
            </SidebarLink>
          )}
          <SidebarLink to="/calendar" active={isActive('/calendar')}>
            Timer
          </SidebarLink>
        </div>

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
          <SidebarLink to="/payroll" active={isActive('/payroll')}>
            Payroll
          </SidebarLink>
          {!isDemoMode && (
            <SidebarLink to="/approvals" active={isActive('/approvals')}>
              Approvals
            </SidebarLink>
          )}
          {user?.role === 'ADMIN' && (
            <SidebarLink to="/service-tickets" active={isActive('/service-tickets')}>
              Service Tickets
            </SidebarLink>
          )}
          {user?.role === 'ADMIN' && (
            <SidebarLink to="/employee-reports" active={isActive('/employee-reports')}>
              Employee Reports
            </SidebarLink>
          )}
        </div>

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
          <SidebarLink to="/time-entries" active={isActive('/time-entries')}>
            Timesheet
          </SidebarLink>
          {!isDemoMode && (
            <SidebarLink to="/forms" active={isActive('/forms')}>
              Forms
            </SidebarLink>
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
            {!isDemoMode && (
              <SidebarLink to="/profile" active={isActive('/profile')}>
                Profile
              </SidebarLink>
            )}
            <SidebarLink to="/settings" active={isActive('/settings')}>
              Settings
            </SidebarLink>
          </div>
        )}
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

