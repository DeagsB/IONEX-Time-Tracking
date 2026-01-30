import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useDemoMode } from '../context/DemoModeContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { projectsService, customersService, timeEntriesService } from '../services/supabaseServices';
import { useNavigate } from 'react-router-dom';
import SearchableSelect from './SearchableSelect';

interface HeaderProps {
  onTimerStart: (description: string, projectId?: string) => void;
  onTimerStop: () => void;
  timerRunning: boolean;
  timerDisplay: string;
  currentEntry: { description: string; projectId?: string; projectName?: string } | null;
  timerStartTime: number | null;
}

export default function Header({ onTimerStart, onTimerStop, timerRunning, timerDisplay, currentEntry, timerStartTime }: HeaderProps) {
  const { user, isDeveloper, effectiveRole, setEffectiveRole } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { isDemoMode } = useDemoMode();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [description, setDescription] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [location, setLocation] = useState(''); // Work location for service tickets

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => projectsService.getAll(),
  });

  const { data: customers } = useQuery({
    queryKey: ['customers'],
    queryFn: () => customersService.getAll(),
  });

  // Filter projects based on selected customer
  const filteredProjects = projects?.filter((project: any) => {
    return !selectedCustomerId || project.customer_id === selectedCustomerId;
  }) || [];

  const createTimeEntryMutation = useMutation({
    mutationFn: async (data: any) => {
      const { timeEntriesService } = await import('../services/supabaseServices');
      if (!user) throw new Error('Not authenticated');
      
      const entryData = {
        user_id: user.id,
        project_id: data.projectId || null,
        date: data.date,
        start_time: data.startTime || null,
        end_time: data.endTime || null,
        hours: parseFloat(data.hours),
        rate: parseFloat(data.rate || 0),
        billable: data.billable !== undefined ? data.billable : true,
        rate_type: data.rateType || 'Shop Time',
        description: data.description || null,
        location: data.location || null, // Work location for service tickets
        is_demo: isDemoMode, // Mark as demo entry if in demo mode
      };
      
      return await timeEntriesService.create(entryData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
    },
  });



  const handleStart = () => {
    if (timerRunning) {
      // Stop timer
      onTimerStop();
      return;
    }

    // Start timer - need description and optionally project
    if (!description.trim()) {
      alert('Please enter a description');
      return;
    }

    onTimerStart(description.trim(), selectedProjectId || undefined);
  };

  const handleCustomerChange = (customerId: string) => {
    setSelectedCustomerId(customerId);
    // Clear project selection when customer changes
    setSelectedProjectId('');
    setLocation('');
  };

  const handleProjectChange = async (projectId: string) => {
    setSelectedProjectId(projectId);
    
    if (!projectId) {
      setLocation('');
      return;
    }
    
    // Try to get the last used location for this user and project
    if (user?.id) {
      const lastLocation = await timeEntriesService.getLastLocation(user.id, projectId);
      if (lastLocation) {
        setLocation(lastLocation);
        return;
      }
    }
    
    // Fallback to project default location if no previous entry found
    const project = projects?.find((p: any) => p.id === projectId);
    if (project?.location) {
      setLocation(project.location);
    } else {
      setLocation('');
    }
  };

  const handleStop = async () => {
    if (!currentEntry) {
      onTimerStop();
      return;
    }
    
    // Get elapsed time from display (format: H:MM:SS)
    const parts = timerDisplay.split(':');
    const hours = parseFloat(parts[0]) + parseFloat(parts[1]) / 60 + parseFloat(parts[2]) / 3600;
    
    if (hours === 0) {
      onTimerStop();
      return;
    }
    
    // Get project rate - fetch if not already loaded
    let projectRate = 0;
    let projectName = '';
    
    if (currentEntry.projectId && projects) {
      const project = projects.find((p: any) => p.id === currentEntry.projectId);
      if (project) {
        projectRate = project.rate || 0;
        projectName = project.name;
      }
    }

    // Get project data if needed
    if (!projects && currentEntry.projectId) {
      try {
        const project = await projectsService.getById(currentEntry.projectId);
        projectRate = project.rate || 0;
        projectName = project.name;
      } catch (e) {
        // Project not found, use default rate
      }
    }

    // Create time entry using actual timer start time
    const now = new Date();
    let startTime: Date;
    let endTime = new Date();
    
    if (timerStartTime) {
      // Use the actual start time from when timer began
      startTime = new Date(timerStartTime);
      // End time is now
      endTime = new Date();
    } else {
      // Fallback: calculate backwards from current time
      startTime = new Date();
      startTime.setHours(startTime.getHours() - Math.floor(hours));
      startTime.setMinutes(startTime.getMinutes() - Math.round((hours % 1) * 60));
      startTime.setSeconds(0, 0);
    }

    // Format date in local timezone (YYYY-MM-DD) to match calendar display
    const year = startTime.getFullYear();
    const month = String(startTime.getMonth() + 1).padStart(2, '0');
    const day = String(startTime.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    // No project = internal time, not billable
    const isBillable = currentEntry.projectId ? true : false;
    
    try {
      await createTimeEntryMutation.mutateAsync({
        projectId: currentEntry.projectId || null,
        date: dateStr, // Use date from startTime to ensure correct day
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        hours: hours,
        rate: projectRate,
        billable: isBillable,
        rateType: isBillable ? 'Shop Time' : 'Internal',
        description: currentEntry.description,
        location: location || null, // Include location for service tickets
      });

      // Stop timer after saving
      onTimerStop();

      // Reset form
      setDescription('');
      setSelectedCustomerId('');
      setSelectedProjectId('');
      setLocation('');
      
      // Navigate to week view (which will show today's week)
      // The entry will appear in the correct time slot
      navigate('/calendar');
    } catch (error: any) {
      console.error('Error creating time entry:', error);
      alert(error instanceof Error ? error.message : 'Failed to save time entry');
      // Still stop the timer
      onTimerStop();
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !timerRunning) {
      e.preventDefault();
      handleStart();
    }
  };

  return (
    <div style={{
      height: '64px',
      backgroundColor: 'var(--bg-primary)',
      borderBottom: '1px solid var(--border-color)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 24px',
      position: 'fixed',
      top: 0,
      left: '240px',
      right: 0,
      zIndex: 100,
      boxShadow: 'var(--shadow-sm)',
    }}>

      {/* Center - Timer Input */}
      <div style={{ flex: 1, maxWidth: '600px', margin: '0 auto', position: 'relative' }}>
        {timerRunning && currentEntry ? (
          <div style={{
            padding: '10px 15px',
            borderRadius: '6px',
            backgroundColor: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            fontSize: '14px',
            color: 'var(--text-primary)',
          }}>
            <div style={{ fontWeight: '500' }}>{currentEntry.description}</div>
            {currentEntry.projectName && (
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                {currentEntry.projectName}
              </div>
            )}
          </div>
        ) : (
          <>
            <input
              type="text"
              placeholder="What are you working on?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyPress={handleKeyPress}
              style={{
                width: '100%',
                padding: '12px 16px',
                border: '1px solid var(--border-color)',
                borderRadius: '10px',
                fontSize: '14px',
                backgroundColor: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                transition: 'all 0.2s ease',
              }}
            />
          </>
        )}
      </div>

      {/* Right side - Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginLeft: '20px' }}>
        {/* Customer Selector */}
        {!timerRunning && (
          <SearchableSelect
            options={customers?.map((customer: any) => ({
              value: customer.id,
              label: customer.name,
            })) || []}
            value={selectedCustomerId}
            onChange={handleCustomerChange}
            placeholder="Search customers..."
            emptyOption={{ value: '', label: 'Select Customer' }}
            style={{ width: '150px' }}
          />
        )}

        {/* Project Selector - only show when customer selected */}
        {!timerRunning && selectedCustomerId && (
          <SearchableSelect
            options={filteredProjects.map((project: any) => ({
              value: project.id,
              label: project.project_number ? `${project.project_number} - ${project.name}` : project.name,
            }))}
            value={selectedProjectId}
            onChange={handleProjectChange}
            placeholder="Search projects..."
            emptyOption={{ value: '', label: 'Select Project' }}
            style={{ width: '150px' }}
          />
        )}

        {/* Location input - only shown when project selected */}
        {!timerRunning && selectedProjectId && (
          <input
            type="text"
            placeholder="Location..."
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            style={{
              width: '120px',
              padding: '8px 10px',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              fontSize: '14px',
              backgroundColor: 'var(--bg-primary)',
              color: 'var(--text-primary)',
            }}
          />
        )}

        <button
          className="theme-toggle"
          onClick={toggleTheme}
          style={{
            background: 'none',
            border: 'none',
            fontSize: '20px',
            cursor: 'pointer',
            padding: '5px',
          }}
          title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
        >
          {theme === 'light' ? '🌙' : '☀️'}
        </button>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 16px',
          backgroundColor: timerRunning ? 'rgba(239, 68, 68, 0.1)' : 'var(--bg-secondary)',
          borderRadius: '8px',
          fontSize: '15px',
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
          fontWeight: '600',
          color: timerRunning ? 'var(--error-color)' : 'var(--text-primary)',
          border: timerRunning ? '1px solid rgba(239, 68, 68, 0.2)' : '1px solid transparent',
          transition: 'all 0.2s ease',
        }}>
          {timerDisplay}
        </div>

        <button
          onClick={() => {
            if (timerRunning) {
              handleStop();
            } else {
              handleStart();
            }
          }}
          disabled={!timerRunning && !description.trim()}
          style={{
            backgroundColor: timerRunning ? 'var(--error-color)' : 'var(--primary-color)',
            color: 'white',
            border: 'none',
            borderRadius: '50%',
            width: '44px',
            height: '44px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: (!timerRunning && !description.trim()) ? 'not-allowed' : 'pointer',
            fontSize: '18px',
            transition: 'all 0.2s ease',
            opacity: (!timerRunning && !description.trim()) ? 0.5 : 1,
            boxShadow: 'var(--shadow-sm)',
          }}
          onMouseEnter={(e) => {
            if (!(!timerRunning && !description.trim())) {
              e.currentTarget.style.boxShadow = 'var(--shadow-md)';
              e.currentTarget.style.transform = 'translateY(-2px)';
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
            e.currentTarget.style.transform = 'translateY(0)';
          }}
          title={timerRunning ? 'Stop timer' : 'Start timer'}
        >
          {timerRunning ? '⏹' : '▶'}
        </button>


        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {/* Developer Role Switcher */}
          {isDeveloper && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              backgroundColor: 'var(--bg-secondary)',
              borderRadius: '6px',
              padding: '4px',
              border: '1px solid var(--border-color)',
            }}>
              <button
                onClick={() => setEffectiveRole('USER')}
                style={{
                  padding: '4px 10px',
                  fontSize: '12px',
                  fontWeight: '500',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  backgroundColor: effectiveRole === 'USER' ? 'var(--primary-color)' : 'transparent',
                  color: effectiveRole === 'USER' ? 'white' : 'var(--text-secondary)',
                  transition: 'all 0.15s ease',
                }}
                title="Switch to User mode"
              >
                User
              </button>
              <button
                onClick={() => setEffectiveRole('ADMIN')}
                style={{
                  padding: '4px 10px',
                  fontSize: '12px',
                  fontWeight: '500',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  backgroundColor: effectiveRole === 'ADMIN' ? 'var(--primary-color)' : 'transparent',
                  color: effectiveRole === 'ADMIN' ? 'white' : 'var(--text-secondary)',
                  transition: 'all 0.15s ease',
                }}
                title="Switch to Admin mode"
              >
                Admin
              </button>
            </div>
          )}
          <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
            {user?.firstName} {user?.lastName}
            {isDeveloper && (
              <span style={{ 
                fontSize: '10px', 
                marginLeft: '6px', 
                padding: '2px 6px', 
                backgroundColor: 'var(--warning-color)', 
                color: 'white', 
                borderRadius: '4px',
                fontWeight: '600',
              }}>
                DEV
              </span>
            )}
          </span>
        </div>
      </div>

    </div>
  );
}
