import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { bugReportsService } from '../services/supabaseServices';

export default function Sidebar() {
  const location = useLocation();
  const { user, logout, isAdmin } = useAuth();
  const { isDemoMode } = useDemoMode();
  const navigate = useNavigate();
  const isActive = (path: string) => location.pathname === path || location.pathname.startsWith(path);
  const [showBugReportModal, setShowBugReportModal] = useState(false);
  const [bugReportDescription, setBugReportDescription] = useState('');
  const [isSubmittingBug, setIsSubmittingBug] = useState(false);
  const [showSuggestionModal, setShowSuggestionModal] = useState(false);
  const [suggestionDescription, setSuggestionDescription] = useState('');
  const [isSubmittingSuggestion, setIsSubmittingSuggestion] = useState(false);
  const [modalRoot, setModalRoot] = useState<HTMLElement | null>(null);
  const [mouseDownPos, setMouseDownPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setModalRoot(document.body);
  }, []);

  const handleSignOut = async () => {
    try {
      await logout();
      navigate('/login');
    } catch (error) {
      console.error('Error signing out:', error);
    }
  };

  const handleSubmitBugReport = async () => {
    if (!bugReportDescription.trim()) {
      alert('Please describe the issue.');
      return;
    }

    setIsSubmittingBug(true);
    try {
      const description = bugReportDescription.trim();

      await bugReportsService.create({
        user_id: user?.id,
        user_email: user?.email,
        user_name: `${user?.firstName} ${user?.lastName}`,
        title: '', // No title, just description
        description: description,
        priority: 'medium',
      });
      
      alert('Bug report submitted successfully! Thank you for your feedback.');
      setBugReportDescription('');
      setShowBugReportModal(false);
    } catch (error: any) {
      console.error('Error submitting bug report:', error);
      alert(`Failed to submit bug report: ${error.message || 'Unknown error'}`);
    } finally {
      setIsSubmittingBug(false);
    }
  };

  const handleSubmitSuggestion = async () => {
    if (!suggestionDescription.trim()) {
      alert('Please describe your suggestion.');
      return;
    }

    setIsSubmittingSuggestion(true);
    try {
      const description = suggestionDescription.trim();

      await bugReportsService.create({
        user_id: user?.id,
        user_email: user?.email,
        user_name: `${user?.firstName} ${user?.lastName}`,
        title: '[Suggestion]', // Just mark as suggestion, no title
        description: description,
        priority: 'low', // Suggestions are lower priority than bugs
      });
      
      alert('Suggestion submitted successfully! Thank you for your feedback.');
      setSuggestionDescription('');
      setShowSuggestionModal(false);
    } catch (error: any) {
      console.error('Error submitting suggestion:', error);
      alert(`Failed to submit suggestion: ${error.message || 'Unknown error'}`);
    } finally {
      setIsSubmittingSuggestion(false);
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
          {user?.role !== 'ADMIN' && (
            <>
              <SidebarLink to="/projects" active={isActive('/projects')}>
                Projects
              </SidebarLink>
              <SidebarLink to="/customers" active={isActive('/customers')}>
                Clients
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
            {user?.global_admin && (
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
      </div>

      {/* Suggest, Report Bug and Sign Out Buttons at Bottom */}
      <div style={{
        position: 'absolute',
        bottom: '24px',
        left: '0',
        right: '0',
        padding: '0 15px'
      }}>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setShowSuggestionModal(true);
          }}
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
            marginBottom: '10px',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
            e.currentTarget.style.borderColor = '#10b981';
            e.currentTarget.style.color = '#10b981';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.style.borderColor = 'var(--border-color)';
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
        >
          <span>💡</span>
          <span>Suggest Improvement</span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setShowBugReportModal(true);
          }}
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
            marginBottom: '10px',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
            e.currentTarget.style.borderColor = 'var(--info-color)';
            e.currentTarget.style.color = 'var(--info-color)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.style.borderColor = 'var(--border-color)';
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
        >
          <span>🐛</span>
          <span>Report a Bug/Problem</span>
        </button>
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

      {/* Bug Report Modal - Rendered via Portal */}
      {showBugReportModal && modalRoot && createPortal(
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '20px',
            userSelect: 'none',
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setMouseDownPos({ x: e.clientX, y: e.clientY });
            }
          }}
          onMouseUp={(e) => {
            if (e.target === e.currentTarget && mouseDownPos) {
              const moved = Math.abs(e.clientX - mouseDownPos.x) > 5 || Math.abs(e.clientY - mouseDownPos.y) > 5;
              if (!moved && !isSubmittingBug) {
                setShowBugReportModal(false);
                setBugReportDescription('');
              }
              setMouseDownPos(null);
            }
          }}
          onClick={(e) => {
            // Only handle click if mouse didn't move (handled by onMouseUp)
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div
            className="card"
            style={{
              maxWidth: '600px',
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
              position: 'relative',
              zIndex: 10000,
              userSelect: 'text',
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3>Report a Bug/Problem</h3>
              <button
                className="button button-secondary"
                onClick={() => {
                  if (!isSubmittingBug) {
                    setShowBugReportModal(false);
                    setBugReportDescription('');
                  }
                }}
                disabled={isSubmittingBug}
                style={{ padding: '5px 10px', fontSize: '14px' }}
              >
                ✕
              </button>
            </div>

            <div className="form-group" style={{ marginBottom: '20px' }}>
              <label className="label">Describe the issue</label>
              <textarea
                className="input"
                rows={10}
                value={bugReportDescription}
                onChange={(e) => setBugReportDescription(e.target.value)}
                placeholder="Please describe the bug or problem you encountered..."
                disabled={isSubmittingBug}
                autoFocus
                style={{ width: '100%', resize: 'none' }}
              />
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                className="button button-secondary"
                onClick={() => {
                  if (!isSubmittingBug) {
                    setShowBugReportModal(false);
                    setBugReportDescription('');
                  }
                }}
                disabled={isSubmittingBug}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                onClick={handleSubmitBugReport}
                disabled={isSubmittingBug || !bugReportDescription.trim()}
              >
                {isSubmittingBug ? 'Submitting...' : 'Submit'}
              </button>
            </div>
          </div>
        </div>,
        modalRoot
      )}

      {/* Suggestion Modal - Rendered via Portal */}
      {showSuggestionModal && modalRoot && createPortal(
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '20px',
            userSelect: 'none',
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setMouseDownPos({ x: e.clientX, y: e.clientY });
            }
          }}
          onMouseUp={(e) => {
            if (e.target === e.currentTarget && mouseDownPos) {
              const moved = Math.abs(e.clientX - mouseDownPos.x) > 5 || Math.abs(e.clientY - mouseDownPos.y) > 5;
              if (!moved && !isSubmittingSuggestion) {
                setShowSuggestionModal(false);
                setSuggestionDescription('');
              }
              setMouseDownPos(null);
            }
          }}
          onClick={(e) => {
            // Only handle click if mouse didn't move (handled by onMouseUp)
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div
            className="card"
            style={{
              maxWidth: '600px',
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
              position: 'relative',
              zIndex: 10000,
              userSelect: 'text',
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3>💡 Suggest an Improvement</h3>
              <button
                className="button button-secondary"
                onClick={() => {
                  if (!isSubmittingSuggestion) {
                    setShowSuggestionModal(false);
                    setSuggestionDescription('');
                  }
                }}
                disabled={isSubmittingSuggestion}
                style={{ padding: '5px 10px', fontSize: '14px' }}
              >
                ✕
              </button>
            </div>

            <div className="form-group" style={{ marginBottom: '20px' }}>
              <label className="label">Describe your suggestion</label>
              <textarea
                className="input"
                rows={10}
                value={suggestionDescription}
                onChange={(e) => setSuggestionDescription(e.target.value)}
                placeholder="Share your idea for improving the application..."
                disabled={isSubmittingSuggestion}
                autoFocus
                style={{ width: '100%', resize: 'none' }}
              />
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                className="button button-secondary"
                onClick={() => {
                  if (!isSubmittingSuggestion) {
                    setShowSuggestionModal(false);
                    setSuggestionDescription('');
                  }
                }}
                disabled={isSubmittingSuggestion}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                onClick={handleSubmitSuggestion}
                disabled={isSubmittingSuggestion || !suggestionDescription.trim()}
                style={{ backgroundColor: '#10b981' }}
              >
                {isSubmittingSuggestion ? 'Submitting...' : 'Submit'}
              </button>
            </div>
          </div>
        </div>,
        modalRoot
      )}
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

