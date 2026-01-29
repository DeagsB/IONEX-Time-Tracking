import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { useTheme } from '../context/ThemeContext';

export default function Sidebar() {
  const location = useLocation();
  const { user, logout, isAdmin } = useAuth();
  const { isDemoMode } = useDemoMode();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const isActive = (path: string) => location.pathname === path || location.pathname.startsWith(path);
  
  // Use stable theme detection - check localStorage directly to avoid flash
  const stableTheme = theme || localStorage.getItem('theme') || 'light';
  const isDarkMode = stableTheme === 'dark';

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
        <img
          src={isDarkMode ? '/Black w WHT background square.png' : '/ionex-logo-removebg-preview.png'}
          alt="IONEX Time Tracking"
          onError={(e) => {
            if (!e.currentTarget.src.includes('ionex-logo.png')) {
              e.currentTarget.src = '/ionex-logo.png';
            }
          }}
          style={{
            height: '50px',
            width: 'auto',
            objectFit: 'contain',
          }}
        />
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
          {!isAdmin && (
            <>
              <SidebarLink to="/projects" active={isActive('/projects')}>
                Projects
              </SidebarLink>
              <SidebarLink to="/customers" active={isActive('/customers')}>
                Clients
              </SidebarLink>
              <SidebarLink to="/service-tickets" active={isActive('/service-tickets')}>
                Service Tickets
              </SidebarLink>
            </>
          )}
        </div>

        {isAdmin && (
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
            {isAdmin && (
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

        {isAdmin && (
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
            <SidebarLink to="/employees" active={isActive('/employees')}>
              Members
            </SidebarLink>
          </div>
        )}

        {isAdmin && (
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
            {isAdmin && (
              <>
                <SidebarLink to="/user-management" active={isActive('/user-management')}>
                  User Management
                </SidebarLink>
                <SidebarLink to="/bug-reports" active={isActive('/bug-reports')}>
                  Feedback & Issues
                </SidebarLink>
              </>
            )}
            {!isDemoMode && (
              <SidebarLink to="/profile" active={isActive('/profile')}>
                Profile
              </SidebarLink>
            )}
            <SidebarLink to="/user-archive" active={isActive('/user-archive')}>
              User Archive
            </SidebarLink>
          </div>
        )}

        {/* Sign Out */}
        <div style={{ marginBottom: '30px' }}>
          <button
            onClick={handleSignOut}
            style={{
              display: 'block',
              width: 'calc(100% - 16px)',
              padding: '10px 16px',
              color: 'var(--text-primary)',
              textDecoration: 'none',
              borderRadius: '8px',
              marginBottom: '4px',
              marginLeft: '8px',
              marginRight: '8px',
              backgroundColor: 'transparent',
              fontWeight: '400',
              fontSize: '14px',
              transition: 'all 0.2s ease',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
          >
            Sign Out
          </button>
        </div>
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

