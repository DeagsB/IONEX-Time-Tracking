import { useState } from 'react';
import { useDemoMode } from '../context/DemoModeContext';
import { supabase } from '../lib/supabaseClient';

export default function Settings() {
  const { isDemoMode, setDemoMode } = useDemoMode();
  const [showResetModal, setShowResetModal] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const handleToggleDemoMode = () => {
    if (isDemoMode) {
      // Turning OFF demo mode - show confirmation modal
      setShowResetModal(true);
    } else {
      // Turning ON demo mode
      setDemoMode(true);
    }
  };

  const handleConfirmReset = async (resetData: boolean) => {
    if (resetData) {
      setIsResetting(true);
      try {
        // Delete all service tickets
        await supabase.from('service_tickets').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        
        // Delete all time entries
        await supabase.from('time_entries').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        
        alert('Demo data has been reset successfully!');
      } catch (error) {
        console.error('Error resetting demo data:', error);
        alert('Error resetting some data. Check console for details.');
      } finally {
        setIsResetting(false);
      }
    }
    
    setDemoMode(false);
    setShowResetModal(false);
  };

  const handleCancelReset = () => {
    setShowResetModal(false);
    // Don't turn off demo mode if cancelled
  };

  return (
    <div>
      <h2 style={{ fontSize: '24px', fontWeight: '700', marginBottom: '24px' }}>Settings</h2>
      
      <div className="card" style={{ padding: '24px' }}>
        <h3 style={{ fontSize: '18px', fontWeight: '600', marginBottom: '20px', color: 'var(--text-primary)' }}>
          Display Options
        </h3>
        
        {/* Demo Mode Toggle */}
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          padding: '16px',
          backgroundColor: isDemoMode ? 'rgba(199, 112, 240, 0.1)' : 'var(--bg-secondary)',
          borderRadius: '8px',
          border: isDemoMode ? '1px solid #c770f0' : '1px solid var(--border-color)',
        }}>
          <div>
            <div style={{ fontWeight: '600', color: 'var(--text-primary)', marginBottom: '4px' }}>
              Demo Mode
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              When enabled, hides Overview, Approvals, Forms, and Profile pages for cleaner demos
            </div>
          </div>
          <label style={{ 
            position: 'relative', 
            display: 'inline-block', 
            width: '56px', 
            height: '28px',
            cursor: 'pointer',
          }}>
            <input
              type="checkbox"
              checked={isDemoMode}
              onChange={handleToggleDemoMode}
              style={{ opacity: 0, width: 0, height: 0 }}
            />
            <span style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: isDemoMode ? '#c770f0' : '#444',
              borderRadius: '28px',
              transition: 'all 0.3s ease',
            }}>
              <span style={{
                position: 'absolute',
                content: '""',
                height: '22px',
                width: '22px',
                left: isDemoMode ? '31px' : '3px',
                bottom: '3px',
                backgroundColor: 'white',
                borderRadius: '50%',
                transition: 'all 0.3s ease',
                boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
              }} />
            </span>
          </label>
        </div>

        {isDemoMode && (
          <div style={{ 
            marginTop: '16px', 
            padding: '12px 16px', 
            backgroundColor: 'rgba(199, 112, 240, 0.1)', 
            borderRadius: '8px',
            border: '1px solid rgba(199, 112, 240, 0.3)',
          }}>
            <div style={{ fontSize: '13px', color: '#c770f0', fontWeight: '500' }}>
              🎭 Demo Mode is ON
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Hidden pages: Overview, Approvals, Forms, Profile
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
              When you turn off demo mode, you'll have the option to reset all time entries and service tickets.
            </div>
          </div>
        )}
      </div>

      {/* Reset Confirmation Modal */}
      {showResetModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
        }}>
          <div style={{
            backgroundColor: 'var(--bg-primary)',
            borderRadius: '12px',
            padding: '24px',
            maxWidth: '450px',
            width: '90%',
            boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
          }}>
            <h3 style={{ fontSize: '18px', fontWeight: '600', marginBottom: '16px', color: 'var(--text-primary)' }}>
              Turn Off Demo Mode
            </h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '20px', lineHeight: '1.5' }}>
              Would you like to reset all demo data? This will delete:
            </p>
            <ul style={{ 
              color: 'var(--text-secondary)', 
              marginBottom: '24px', 
              paddingLeft: '20px',
              lineHeight: '1.8',
            }}>
              <li>All time entries</li>
              <li>All service ticket records</li>
            </ul>
            
            <div style={{ 
              display: 'flex', 
              gap: '12px',
              flexDirection: 'column',
            }}>
              <button
                onClick={() => handleConfirmReset(true)}
                disabled={isResetting}
                style={{
                  padding: '12px 20px',
                  backgroundColor: '#dc2626',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '14px',
                  fontWeight: '500',
                  cursor: isResetting ? 'not-allowed' : 'pointer',
                  opacity: isResetting ? 0.6 : 1,
                }}
              >
                {isResetting ? 'Resetting...' : '🗑️ Yes, Reset All Demo Data'}
              </button>
              <button
                onClick={() => handleConfirmReset(false)}
                disabled={isResetting}
                style={{
                  padding: '12px 20px',
                  backgroundColor: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '8px',
                  fontSize: '14px',
                  fontWeight: '500',
                  cursor: isResetting ? 'not-allowed' : 'pointer',
                }}
              >
                No, Keep Data
              </button>
              <button
                onClick={handleCancelReset}
                disabled={isResetting}
                style={{
                  padding: '12px 20px',
                  backgroundColor: 'transparent',
                  color: 'var(--text-secondary)',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '14px',
                  cursor: isResetting ? 'not-allowed' : 'pointer',
                }}
              >
                Cancel (Stay in Demo Mode)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
