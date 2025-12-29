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

      // Delete all existing demo data first to ensure clean state (including service tickets to reset numbering)
      // Delete from the demo table
      const { data: existingDemoTickets } = await supabase
        .from('service_tickets_demo')
        .select('id');
      
      if (existingDemoTickets && existingDemoTickets.length > 0) {
        // Delete service ticket expenses first (foreign key constraint)
        for (const ticket of existingDemoTickets) {
          await supabase
            .from('service_ticket_expenses')
            .delete()
            .eq('service_ticket_id', ticket.id);
        }
        await supabase
          .from('service_tickets_demo')
          .delete();
      }
      
      // Also delete any demo tickets from the regular table (for backward compatibility)
      const { data: existingDemoTicketsOld } = await supabase
        .from('service_tickets')
        .select('id')
        .eq('is_demo', true);
      
      if (existingDemoTicketsOld && existingDemoTicketsOld.length > 0) {
        for (const ticket of existingDemoTicketsOld) {
          await supabase
            .from('service_ticket_expenses')
            .delete()
            .eq('service_ticket_id', ticket.id);
        }
        await supabase
          .from('service_tickets')
          .delete()
          .eq('is_demo', true);
      }

      const { data: existingDemoProjects } = await supabase
        .from('projects')
        .select('id')
        .eq('is_demo', true);
      
      if (existingDemoProjects && existingDemoProjects.length > 0) {
        await supabase
          .from('projects')
          .delete()
          .eq('is_demo', true);
      }

      const { data: existingDemoCustomers } = await supabase
        .from('customers')
        .select('id')
        .eq('is_demo', true);
      
      if (existingDemoCustomers && existingDemoCustomers.length > 0) {
        await supabase
          .from('customers')
          .delete()
          .eq('is_demo', true);
      }

      // Create CNRL customer with full name, PO number, and contact name
      const { data: newCustomer, error: customerError } = await supabase
        .from('customers')
        .insert({
          name: 'Canadian Natural Resources Limited (CNRL)',
          email: 'demo@cnrl.com',
          phone: '403-123-4567',
          address: '250 6 Ave SW',
          city: 'Calgary',
          state: 'AB',
          zip_code: 'T2P 3H7',
          po_number: 'PO-2025-001',
          approver_name: 'John Smith',
          is_demo: true,
        })
        .select('id')
        .single();
      
      if (customerError) throw customerError;
      const cnrlCustomerId = newCustomer.id;

      // Create demo projects for CNRL with project numbers, full names, and project-specific PO/contact
      const projectData = [
        { 
          project_number: 'CNRL-001',
          name: 'Pipeline Compressor Station PLC Upgrade',
          color: '#4ecdc4',
          po_number: 'PO-2025-001',
          contact_name: 'Sarah Johnson'
        },
        { 
          project_number: 'CNRL-002',
          name: 'Gas Processing Facility Control System Commissioning',
          color: '#ff6b6b',
          po_number: 'PO-2025-002',
          contact_name: 'Mike Anderson'
        },
        { 
          project_number: 'CNRL-003',
          name: 'Well Pad Automation and HMI Integration',
          color: '#95e1d3',
          po_number: 'PO-2025-003',
          contact_name: 'Emily Chen'
        },
      ];
      const projectIds: string[] = [];

      for (const project of projectData) {
        const { data: newProject, error: projectError } = await supabase
          .from('projects')
          .insert({
            project_number: project.project_number,
            name: project.name,
            customer_id: cnrlCustomerId,
            rate: 110,
            color: project.color,
            po_number: project.po_number,
            contact_name: project.contact_name,
            is_demo: true,
          })
          .select('id')
          .single();
        
        if (projectError) throw projectError;
        projectIds.push(newProject.id);
      }

      // Create demo time entries - only for current week with cohesive Tue-Thu story
      const today = new Date();
      const demoEntries: Array<{
        user_id: string;
        project_id: string;
        date: string;
        start_time: string;
        end_time: string;
        hours: number;
        rate: number;
        rate_type: string;
        description: string;
        billable: boolean;
        approved: boolean;
        is_demo: boolean;
      }> = [];
      
      // Get current week (Monday to Friday)
      const getMonday = (date: Date) => {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
        return new Date(d.setDate(diff));
      };
      
      const monday = getMonday(today);
      const weekDays: Date[] = [];
      for (let i = 0; i < 5; i++) {
        const day = new Date(monday);
        day.setDate(monday.getDate() + i);
        weekDays.push(day);
      }
      
      // Rate type to rate mapping
      const rateTypeToRate: { [key: string]: number } = {
        'Shop Time': 95,
        'Travel Time': 85,
        'Field Time': 125,
        'Shop Overtime': 142.5,
        'Field Overtime': 187.5,
      };

      // Use first project for the cohesive Tue-Thu story
      const siteProjectId = projectIds[0];

      // Create entries for each day of the week
      weekDays.forEach((entryDate, dayIndex) => {
        const dayOfWeek = entryDate.getDay(); // 0 = Sunday, 1 = Monday, etc.
        const dateStr = entryDate.toISOString().split('T')[0];
        
        if (dayOfWeek === 2) { // Tuesday - Travel to site, begin work
          // Travel to site (morning)
          const travelStart = new Date(entryDate);
          travelStart.setHours(7, 0);
          const travelEnd = new Date(entryDate);
          travelEnd.setHours(9, 0);
          
          demoEntries.push({
            user_id: userId,
            project_id: siteProjectId,
            date: dateStr,
            start_time: travelStart.toISOString(),
            end_time: travelEnd.toISOString(),
            hours: 2,
            rate: rateTypeToRate['Travel Time'],
            rate_type: 'Travel Time',
            description: 'Travel to client site',
            billable: true,
            approved: true,
            is_demo: true,
          });
          
          // Begin on-site work (afternoon)
          const workStart = new Date(entryDate);
          workStart.setHours(10, 0);
          const workEnd = new Date(entryDate);
          workEnd.setHours(17, 0);
          
          demoEntries.push({
            user_id: userId,
            project_id: siteProjectId,
            date: dateStr,
            start_time: workStart.toISOString(),
            end_time: workEnd.toISOString(),
            hours: 7,
            rate: rateTypeToRate['Field Time'],
            rate_type: 'Field Time',
            description: 'On-site PLC system review and I/O commissioning',
            billable: true,
            approved: true,
            is_demo: true,
          });
          
        } else if (dayOfWeek === 3) { // Wednesday - Full day of work
          const workStart = new Date(entryDate);
          workStart.setHours(8, 0);
          const workEnd = new Date(entryDate);
          workEnd.setHours(12, 0);
          
          demoEntries.push({
            user_id: userId,
            project_id: siteProjectId,
            date: dateStr,
            start_time: workStart.toISOString(),
            end_time: workEnd.toISOString(),
            hours: 4,
            rate: rateTypeToRate['Field Time'],
            rate_type: 'Field Time',
            description: 'PLC programming and HMI configuration',
            billable: true,
            approved: true,
            is_demo: true,
          });
          
          const workStart2 = new Date(entryDate);
          workStart2.setHours(13, 0);
          const workEnd2 = new Date(entryDate);
          workEnd2.setHours(17, 0);
          
          demoEntries.push({
            user_id: userId,
            project_id: siteProjectId,
            date: dateStr,
            start_time: workStart2.toISOString(),
            end_time: workEnd2.toISOString(),
            hours: 4,
            rate: rateTypeToRate['Field Time'],
            rate_type: 'Field Time',
            description: 'Control loop testing and safety system verification',
            billable: true,
            approved: true,
            is_demo: true,
          });
          
        } else if (dayOfWeek === 4) { // Thursday - Finish work, travel home
          // Complete remaining work (morning)
          const workStart = new Date(entryDate);
          workStart.setHours(8, 0);
          const workEnd = new Date(entryDate);
          workEnd.setHours(13, 0);
          
          demoEntries.push({
            user_id: userId,
            project_id: siteProjectId,
            date: dateStr,
            start_time: workStart.toISOString(),
            end_time: workEnd.toISOString(),
            hours: 5,
            rate: rateTypeToRate['Field Time'],
            rate_type: 'Field Time',
            description: 'Final commissioning and as-built documentation',
            billable: true,
            approved: true,
            is_demo: true,
          });
          
          // Return travel (afternoon)
          const travelStart = new Date(entryDate);
          travelStart.setHours(14, 0);
          const travelEnd = new Date(entryDate);
          travelEnd.setHours(16, 0);
          
          demoEntries.push({
            user_id: userId,
            project_id: siteProjectId,
            date: dateStr,
            start_time: travelStart.toISOString(),
            end_time: travelEnd.toISOString(),
            hours: 2,
            rate: rateTypeToRate['Travel Time'],
            rate_type: 'Travel Time',
            description: 'Return travel from site',
            billable: true,
            approved: true,
            is_demo: true,
          });
          
        } else if (dayOfWeek === 1 || dayOfWeek === 5) { // Monday or Friday - Shop work
          const otherProjectId = projectIds[dayOfWeek === 1 ? 1 : 2]; // Different project for Mon/Fri
          
          const workStart = new Date(entryDate);
          workStart.setHours(8, 0);
          const workEnd = new Date(entryDate);
          workEnd.setHours(17, 0);
          
          demoEntries.push({
            user_id: userId,
            project_id: otherProjectId,
            date: dateStr,
            start_time: workStart.toISOString(),
            end_time: workEnd.toISOString(),
            hours: 8,
            rate: rateTypeToRate['Shop Time'],
            rate_type: 'Shop Time',
            description: dayOfWeek === 1 ? 'PLC program development and simulation' : 'HMI screen design and documentation',
            billable: true,
            approved: true,
            is_demo: true,
          });
        }
      });

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
        // First, delete from the demo table (service_tickets_demo)
        const { data: demoTicketsDemo } = await supabase.from('service_tickets_demo').select('id');
        if (demoTicketsDemo && demoTicketsDemo.length > 0) {
          await supabase.from('service_ticket_expenses').delete().in('service_ticket_id', demoTicketsDemo.map(t => t.id));
          await supabase.from('service_tickets_demo').delete();
        }
        
        // Also delete from regular table for backward compatibility
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
        // First, delete from the demo table (service_tickets_demo)
        const { data: existingDemoTicketsDemo } = await supabase.from('service_tickets_demo').select('id');
        if (existingDemoTicketsDemo && existingDemoTicketsDemo.length > 0) {
          await supabase.from('service_ticket_expenses').delete().in('service_ticket_id', existingDemoTicketsDemo.map(t => t.id));
          await supabase.from('service_tickets_demo').delete();
        }
        
        // Also delete from regular table for backward compatibility
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
