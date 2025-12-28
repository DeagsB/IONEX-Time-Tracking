import { useState } from 'react';
import { useDemoMode } from '../context/DemoModeContext';
import { supabase } from '../lib/supabaseClient';

export default function Settings() {
  const { isDemoMode, setDemoMode } = useDemoMode();
  const [showResetModal, setShowResetModal] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isCreatingDemo, setIsCreatingDemo] = useState(false);

  // Create demo data when turning on demo mode
  const createDemoData = async () => {
    setIsCreatingDemo(true);
    try {
      // Get the current user ID
      const { data: userData } = await supabase.from('users').select('id').limit(1).single();
      const userId = userData?.id || '235d854a-1b7d-4e00-a5a4-43835c85c086';

      // Get existing projects
      const { data: projects } = await supabase.from('projects').select('id').limit(5);
      const projectIds = projects?.map(p => p.id) || [];

      if (projectIds.length === 0) {
        alert('Please create at least one project before enabling demo mode.');
        return false;
      }

      // Create demo time entries for the past 2 weeks
      const today = new Date();
      const demoEntries = [];
      
      const descriptions = [
        'Travel to client site',
        'On-site HVAC inspection and diagnostics',
        'Replaced compressor components',
        'System testing and calibration',
        'Return travel from site',
        'Prepared service documentation',
        'Parts ordering and inventory check',
        'Control system programming',
        'Emergency repair service',
        'Quarterly maintenance inspection',
      ];
      
      const rateTypes = ['Shop Time', 'Travel Time', 'Field Time', 'Shop Overtime', 'Field Overtime'];
      const rates = [95, 85, 125, 142.5, 187.5];

      // Generate entries for the past 10 days
      for (let dayOffset = 0; dayOffset < 10; dayOffset++) {
        const entryDate = new Date(today);
        entryDate.setDate(today.getDate() - dayOffset);
        
        // Skip weekends
        if (entryDate.getDay() === 0 || entryDate.getDay() === 6) continue;
        
        const dateStr = entryDate.toISOString().split('T')[0];
        const entriesPerDay = Math.floor(Math.random() * 3) + 2; // 2-4 entries per day
        
        let currentHour = 8;
        for (let i = 0; i < entriesPerDay; i++) {
          const projectId = projectIds[Math.floor(Math.random() * projectIds.length)];
          const rateTypeIndex = Math.floor(Math.random() * 3); // Mostly regular types
          const hours = [1.5, 2, 2.5, 3, 4, 5, 6][Math.floor(Math.random() * 7)];
          
          const startHour = currentHour;
          const endHour = currentHour + hours;
          currentHour = endHour + 0.5;
          
          const startDate = new Date(entryDate);
          startDate.setHours(Math.floor(startHour), (startHour % 1) * 60);
          
          const endDate = new Date(entryDate);
          endDate.setHours(Math.floor(endHour), (endHour % 1) * 60);
          
          demoEntries.push({
            user_id: userId,
            project_id: projectId,
            date: dateStr,
            start_time: startDate.toISOString(),
            end_time: endDate.toISOString(),
            hours: hours,
            rate: rates[rateTypeIndex],
            rate_type: rateTypes[rateTypeIndex],
            description: descriptions[Math.floor(Math.random() * descriptions.length)],
            billable: true,
            approved: true,
            is_demo: true, // Mark as demo data
          });
        }
      }

      // Insert demo entries
      const { error } = await supabase.from('time_entries').insert(demoEntries);
      if (error) throw error;

      return true;
    } catch (error) {
      console.error('Error creating demo data:', error);
      alert('Error creating demo data. Check console for details.');
      return false;
    } finally {
      setIsCreatingDemo(false);
    }
  };

  const handleToggleDemoMode = async () => {
    if (isDemoMode) {
      // Turning OFF demo mode - show confirmation modal
      setShowResetModal(true);
    } else {
      // Turning ON demo mode - create demo data first
      const success = await createDemoData();
      if (success) {
        setDemoMode(true);
      }
    }
  };

  const handleConfirmReset = async (resetData: boolean) => {
    if (resetData) {
      setIsResetting(true);
      try {
        // Only delete demo service tickets (marked with is_demo = true)
        await supabase.from('service_tickets').delete().eq('is_demo', true);
        
        // Only delete demo time entries (marked with is_demo = true)
        await supabase.from('time_entries').delete().eq('is_demo', true);
        
        // Only delete demo projects (marked with is_demo = true)
        await supabase.from('projects').delete().eq('is_demo', true);
        
        // Only delete demo customers (marked with is_demo = true)
        await supabase.from('customers').delete().eq('is_demo', true);
        
        alert('Demo data has been reset successfully! Your real data is preserved.');
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
              {isCreatingDemo 
                ? 'Creating demo time entries...' 
                : 'When enabled, creates demo data and hides Overview, Approvals, Forms, and Profile pages'}
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
              disabled={isCreatingDemo}
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
              Would you like to reset demo data? This will <strong>only</strong> delete entries created in demo mode:
            </p>
            <ul style={{ 
              color: 'var(--text-secondary)', 
              marginBottom: '24px', 
              paddingLeft: '20px',
              lineHeight: '1.8',
            }}>
              <li>Demo time entries</li>
              <li>Demo service tickets</li>
              <li>Demo projects</li>
              <li>Demo customers</li>
            </ul>
            <p style={{ color: '#4ade80', fontSize: '13px', marginBottom: '16px' }}>
              ✓ Your real data will NOT be affected
            </p>
            
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
