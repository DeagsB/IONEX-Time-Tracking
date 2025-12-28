import { useState } from 'react';
import { useDemoMode } from '../context/DemoModeContext';
import { supabase } from '../lib/supabaseClient';

export default function Settings() {
  const { isDemoMode, setDemoMode } = useDemoMode();
  const [isResetting, setIsResetting] = useState(false);
  const [isCreatingDemo, setIsCreatingDemo] = useState(false);

  // Create demo data when turning on demo mode - always creates the same data
  const createDemoData = async () => {
    setIsCreatingDemo(true);
    try {
      // Get the current user ID
      const { data: userData } = await supabase.from('users').select('id').limit(1).single();
      const userId = userData?.id || '235d854a-1b7d-4e00-a5a4-43835c85c086';

      // First, create CNRL customer if it doesn't exist
      let cnrlCustomerId: string;
      const { data: existingCustomer } = await supabase
        .from('customers')
        .select('id')
        .eq('name', 'CNRL')
        .eq('is_demo', true)
        .single();

      if (existingCustomer) {
        cnrlCustomerId = existingCustomer.id;
      } else {
        const { data: newCustomer, error: customerError } = await supabase
          .from('customers')
          .insert({
            name: 'CNRL',
            email: 'demo@cnrl.com',
            phone: '403-123-4567',
            address: '250 6 Ave SW',
            city: 'Calgary',
            state: 'AB',
            zip_code: 'T2P 3H7',
            is_demo: true,
          })
          .select('id')
          .single();
        
        if (customerError) throw customerError;
        cnrlCustomerId = newCustomer.id;
      }

      // Create demo projects for CNRL (deterministic - same every time)
      const projectNames = ['CNRL Project Alpha', 'CNRL Project Beta', 'CNRL Project Gamma'];
      const projectIds: string[] = [];

      for (const projectName of projectNames) {
        const { data: existingProject } = await supabase
          .from('projects')
          .select('id')
          .eq('name', projectName)
          .eq('is_demo', true)
          .single();

        if (existingProject) {
          projectIds.push(existingProject.id);
        } else {
          const { data: newProject, error: projectError } = await supabase
            .from('projects')
            .insert({
              name: projectName,
              customer_id: cnrlCustomerId,
              rate: 110,
              is_demo: true,
            })
            .select('id')
            .single();
          
          if (projectError) throw projectError;
          projectIds.push(newProject.id);
        }
      }

      // Create demo time entries - deterministic data (same every time)
      const today = new Date();
      const demoEntries = [];
      
      // Fixed descriptions in order
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

      // Generate entries for the past 10 business days (deterministic)
      let descriptionIndex = 0;
      for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
        const entryDate = new Date(today);
        entryDate.setDate(today.getDate() - dayOffset);
        
        // Skip weekends
        if (entryDate.getDay() === 0 || entryDate.getDay() === 6) continue;
        
        const dateStr = entryDate.toISOString().split('T')[0];
        
        // Fixed number of entries per day (deterministic)
        const entriesPerDay = [3, 2, 4, 2, 3, 3, 2, 4, 2, 3][dayOffset % 10] || 3;
        
        let currentHour = 8;
        for (let i = 0; i < entriesPerDay; i++) {
          // Cycle through projects deterministically
          const projectIndex = (dayOffset + i) % projectIds.length;
          const projectId = projectIds[projectIndex];
          
          // Cycle through rate types deterministically
          const rateTypeIndex = (dayOffset + i) % 3; // Mostly regular types
          
          // Fixed hours pattern
          const hoursPattern = [2, 3, 1.5, 4, 2.5, 2, 3, 1.5, 4, 2.5];
          const hours = hoursPattern[(dayOffset + i) % hoursPattern.length];
          
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
            description: descriptions[descriptionIndex % descriptions.length],
            billable: true,
            approved: true,
            is_demo: true, // Mark as demo data
          });
          
          descriptionIndex++;
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
      // Turning OFF demo mode - automatically delete all demo data (including any changes)
      setIsResetting(true);
      try {
        // Delete all demo data in correct order (respecting foreign keys)
        const { data: demoTickets } = await supabase.from('service_tickets').select('id').eq('is_demo', true);
        if (demoTickets && demoTickets.length > 0) {
          await supabase.from('service_ticket_expenses').delete().in('service_ticket_id', demoTickets.map(t => t.id));
        }
        await supabase.from('service_tickets').delete().eq('is_demo', true);
        await supabase.from('time_entries').delete().eq('is_demo', true);
        await supabase.from('projects').delete().eq('is_demo', true);
        await supabase.from('customers').delete().eq('is_demo', true);
        
        setDemoMode(false);
        alert('Demo mode disabled. All demo data has been deleted.');
      } catch (error) {
        console.error('Error deleting demo data:', error);
        alert('Error deleting some demo data. Check console for details.');
      } finally {
        setIsResetting(false);
      }
    } else {
      // Turning ON demo mode - delete any existing demo data first, then create fresh
      setIsResetting(true);
      try {
        // Delete any existing demo data first to ensure clean state
        const { data: existingDemoTickets } = await supabase.from('service_tickets').select('id').eq('is_demo', true);
        if (existingDemoTickets && existingDemoTickets.length > 0) {
          await supabase.from('service_ticket_expenses').delete().in('service_ticket_id', existingDemoTickets.map(t => t.id));
        }
        await supabase.from('service_tickets').delete().eq('is_demo', true);
        await supabase.from('time_entries').delete().eq('is_demo', true);
        await supabase.from('projects').delete().eq('is_demo', true);
        await supabase.from('customers').delete().eq('is_demo', true);
        
        // Now create fresh demo data (always the same)
        const success = await createDemoData();
        if (success) {
          setDemoMode(true);
        }
      } catch (error) {
        console.error('Error resetting demo data:', error);
        alert('Error resetting demo data. Check console for details.');
      } finally {
        setIsResetting(false);
      }
    }
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
              Hidden pages: Overview, Approvals, Forms, Profile. All demo data will be automatically deleted when you turn off demo mode.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
