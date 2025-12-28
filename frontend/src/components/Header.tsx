import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useDemoMode } from '../context/DemoModeContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { projectsService } from '../services/supabaseServices';
import { useNavigate } from 'react-router-dom';

interface HeaderProps {
  onTimerStart: (description: string, projectId?: string) => void;
  onTimerStop: () => void;
  timerRunning: boolean;
  timerDisplay: string;
  currentEntry: { description: string; projectId?: string; projectName?: string } | null;
  timerStartTime: number | null;
}

export default function Header({ onTimerStart, onTimerStop, timerRunning, timerDisplay, currentEntry, timerStartTime }: HeaderProps) {
  const { user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { isDemoMode } = useDemoMode();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [description, setDescription] = useState('');
  const [showProjectSelect, setShowProjectSelect] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => projectsService.getAll(),
  });

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
        description: data.description || null,
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
    setShowProjectSelect(false);
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
    const today = new Date();
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

    try {
      await createTimeEntryMutation.mutateAsync({
        projectId: currentEntry.projectId || null,
        date: today.toISOString().split('T')[0],
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        hours: hours,
        rate: projectRate,
        billable: true,
        description: currentEntry.description,
      });

      // Stop timer after saving
      onTimerStop();

      // Reset form
      setDescription('');
      setSelectedProjectId('');
      setShowProjectSelect(false);
      
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
      {/* Left side - Title */}
      <div style={{ marginRight: '24px' }}>
        <span style={{
          fontSize: '16px',
          fontWeight: 'bold',
          color: 'var(--text-primary)',
        }}>
          IONEX Time Tracking
        </span>
      </div>

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
            {showProjectSelect && projects && (
              <div style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                marginTop: '5px',
                backgroundColor: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '12px',
                boxShadow: 'var(--shadow-lg)',
                zIndex: 1000,
                maxHeight: '200px',
                overflowY: 'auto',
              }}>
                <div
                  style={{
                    padding: '10px 16px',
                    fontSize: '12px',
                    fontWeight: '600',
                    color: 'var(--text-secondary)',
                    borderBottom: '1px solid var(--border-color)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedProjectId('');
                    setShowProjectSelect(false);
                  }}
                >
                  No project
                </div>
                {projects.map((project: any) => (
                  <div
                    key={project.id}
                    style={{
                      padding: '10px 16px',
                      cursor: 'pointer',
                      fontSize: '14px',
                      color: 'var(--text-primary)',
                      backgroundColor: selectedProjectId === project.id ? 'var(--primary-light)' : 'transparent',
                      transition: 'background-color 0.15s ease',
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedProjectId(project.id);
                      setShowProjectSelect(false);
                    }}
                    onMouseEnter={(e) => {
                      if (selectedProjectId !== project.id) {
                        e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (selectedProjectId !== project.id) {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }
                    }}
                  >
                    {project.name}
                    {project.customer && <span style={{ color: 'var(--text-secondary)', marginLeft: '8px' }}>• {project.customer.name}</span>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Right side - Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '15px', marginLeft: '20px' }}>
        {!timerRunning && (
          <button
            onClick={() => setShowProjectSelect(!showProjectSelect)}
            style={{
              background: 'none',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              padding: '8px 12px',
              cursor: 'pointer',
              color: 'var(--text-primary)',
              fontSize: '16px',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
              e.currentTarget.style.borderColor = 'var(--border-color-hover)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
              e.currentTarget.style.borderColor = 'var(--border-color)';
            }}
            title="Select project"
          >
            💰
          </button>
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

        <button
          style={{
            background: 'none',
            border: 'none',
            fontSize: '20px',
            cursor: 'pointer',
            color: 'var(--text-primary)',
            padding: '5px',
          }}
          title="Add new entry"
          onClick={() => navigate('/calendar')}
        >
          +
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', paddingLeft: '15px', borderLeft: '1px solid var(--border-color)' }}>
          <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
            {user?.firstName} {user?.lastName}
          </span>
        </div>
      </div>
    </div>
  );
}
