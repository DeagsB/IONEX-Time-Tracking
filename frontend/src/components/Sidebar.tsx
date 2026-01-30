import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { useTheme } from '../context/ThemeContext';

export default function Sidebar() {
  const location = useLocation();
  const { user, logout, isAdmin } = useAuth();
  const { isDemoMode } = useDemoMode();
  const { theme, toggleTheme } = useTheme();
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
      padding: '24px 0 0 0',
      boxShadow: 'var(--shadow-sm)',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{ padding: '0 20px', marginBottom: '32px', flexShrink: 0 }}>
        <img
          src="/ionex-logo-removebg-preview.png"
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

      <div style={{ padding: '0 15px', flex: 1, overflowY: 'auto' }}>
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
              {!isDemoMode && (
                <div style={{ marginTop: '30px' }}>
                  <SidebarLink to="/profile" active={isActive('/profile')}>
                    Profile
                  </SidebarLink>
                </div>
              )}
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
            <SidebarLink to="/user-archive" active={isActive('/user-archive')}>
              User Archive
            </SidebarLink>
            {!isDemoMode && (
              <div style={{ marginTop: '30px' }}>
                <SidebarLink to="/profile" active={isActive('/profile')}>
                  Profile
                </SidebarLink>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sign Out + theme toggle - single compact footer row */}
      <div style={{
        padding: '10px 15px 12px',
        flexShrink: 0,
        borderTop: '1px solid var(--border-color)',
        backgroundColor: 'var(--bg-secondary)',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
      }}>
        <button
          onClick={handleSignOut}
          style={{
            flex: 1,
            padding: '10px 14px',
            color: 'var(--text-primary)',
            textDecoration: 'none',
            borderRadius: '8px',
            margin: 0,
            backgroundColor: 'transparent',
            fontWeight: '500',
            fontSize: '14px',
            transition: 'all 0.2s ease',
            border: '1px solid var(--border-color)',
            cursor: 'pointer',
            textAlign: 'center',
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
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
          style={{
            position: 'relative',
            width: '48px',
            height: '26px',
            borderRadius: '13px',
            border: '1px solid var(--border-color)',
            backgroundColor: 'var(--bg-secondary)',
            cursor: 'pointer',
            padding: 0,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            overflow: 'hidden',
            boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.06)',
          }}
        >
          <span style={{
            position: 'absolute',
            left: '5px',
            top: '50%',
            transform: 'translateY(-50%)',
            fontSize: '12px',
            opacity: theme === 'dark' ? 1 : 0.5,
            transition: 'opacity 0.2s',
            zIndex: 1,
          }}>🌙</span>
          <span style={{
            position: 'absolute',
            right: '5px',
            top: '50%',
            transform: 'translateY(-50%)',
            fontSize: '12px',
            opacity: theme === 'light' ? 1 : 0.5,
            transition: 'opacity 0.2s',
            zIndex: 1,
          }}>☀️</span>
          <span style={{
            position: 'absolute',
            left: theme === 'dark' ? '3px' : 'calc(100% - 21px)',
            top: '3px',
            width: '18px',
            height: '18px',
            borderRadius: '50%',
            backgroundColor: 'var(--bg-primary)',
            boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
            transition: 'left 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
            zIndex: 2,
          }} />
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

