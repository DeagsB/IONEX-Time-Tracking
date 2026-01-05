import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useDemoMode } from '../context/DemoModeContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { projectsService, customersService } from '../services/supabaseServices';
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
  const [projectSearch, setProjectSearch] = useState('');
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [selectedProjectName, setSelectedProjectName] = useState<string>('');
  const [showCreateProjectModal, setShowCreateProjectModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [shouldAutoStart, setShouldAutoStart] = useState(false);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const projectDropdownRef = useRef<HTMLDivElement>(null);

  const { data: projects } = useQuery({
    queryKey: ['projects', user?.id],
    queryFn: () => projectsService.getAll(user?.id),
  });

  const { data: customers } = useQuery({
    queryKey: ['customers', user?.id],
    queryFn: () => customersService.getAll(user?.id),
  });

  // Filter projects based on search input
  const filteredProjects = projects?.filter((project: any) =>
    project.name.toLowerCase().includes(projectSearch.toLowerCase())
  ) || [];

  // Check if we should show "Create new project" option
  const showCreateOption = projectSearch.trim().length > 0 && filteredProjects.length === 0;

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

  const createProjectMutation = useMutation({
    mutationFn: async (projectName: string) => {
      if (!user?.id) throw new Error('User not authenticated.');
      const projectData: any = {
        name: projectName,
        status: 'active',
        color: '#4ecdc4',
        is_demo: isDemoMode,
      };
      return await projectsService.create(projectData, user.id);
    },
    onSuccess: (newProject) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setSelectedProjectId(newProject.id);
      setSelectedProjectName(newProject.name);
      setProjectSearch(newProject.name);
      setShowCreateProjectModal(false);
      setNewProjectName('');
      setShowProjectDropdown(false);
      
      // Auto-start timer if user clicked start before creating project
      if (shouldAutoStart && description.trim()) {
        setShouldAutoStart(false);
        onTimerStart(description.trim(), newProject.id);
      }
    },
  });

  // Handle clicking outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        projectDropdownRef.current &&
        !projectDropdownRef.current.contains(event.target as Node) &&
        projectInputRef.current &&
        !projectInputRef.current.contains(event.target as Node)
      ) {
        setShowProjectDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

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

    // If there's project search text but no selected project, try to create it
    if (projectSearch.trim() && !selectedProjectId && showCreateOption) {
      setNewProjectName(projectSearch.trim());
      setShouldAutoStart(true);
      setShowCreateProjectModal(true);
      return;
    }

    onTimerStart(description.trim(), selectedProjectId || undefined);
    setShowProjectDropdown(false);
    // Project name will be available through currentEntry once timer starts
  };

  const handleCreateProject = () => {
    if (newProjectName.trim()) {
      createProjectMutation.mutate(newProjectName.trim());
    }
  };

  const handleProjectSelect = (project: any) => {
    setSelectedProjectId(project.id);
    setSelectedProjectName(project.name);
    setProjectSearch(project.name);
    setShowProjectDropdown(false);
  };

  const handleClearProject = () => {
    setSelectedProjectId('');
    setSelectedProjectName('');
    setProjectSearch('');
    setShowProjectDropdown(false);
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

    try {
      await createTimeEntryMutation.mutateAsync({
        projectId: currentEntry.projectId || null,
        date: dateStr, // Use date from startTime to ensure correct day
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
      setSelectedProjectName('');
      setProjectSearch('');
      setShowProjectDropdown(false);
      
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
            {selectedProjectName && !currentEntry?.projectName && (
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                {selectedProjectName}
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
      <div style={{ display: 'flex', alignItems: 'center', gap: '15px', marginLeft: '20px' }}>
        {!timerRunning && (
          <div style={{ position: 'relative', width: '200px' }}>
            <input
              ref={projectInputRef}
              type="text"
              placeholder="Select project..."
              value={projectSearch}
              onChange={(e) => {
                setProjectSearch(e.target.value);
                setShowProjectDropdown(true);
                if (!e.target.value) {
                  setSelectedProjectId('');
                  setSelectedProjectName('');
                }
              }}
              onFocus={() => setShowProjectDropdown(true)}
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                fontSize: '14px',
                backgroundColor: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                transition: 'all 0.2s ease',
              }}
            />
            {showProjectDropdown && (filteredProjects.length > 0 || showCreateOption || !projectSearch) && (
              <div
                ref={projectDropdownRef}
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  right: 0,
                  marginTop: '5px',
                  backgroundColor: 'var(--bg-primary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '8px',
                  boxShadow: 'var(--shadow-lg)',
                  zIndex: 1000,
                  maxHeight: '250px',
                  overflowY: 'auto',
                }}
              >
                {!projectSearch && (
                  <div
                    style={{
                      padding: '10px 16px',
                      fontSize: '12px',
                      fontWeight: '600',
                      color: 'var(--text-secondary)',
                      borderBottom: '1px solid var(--border-color)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                      cursor: 'pointer',
                    }}
                    onClick={handleClearProject}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                  >
                    No project
                  </div>
                )}
                {filteredProjects.map((project: any) => (
                  <div
                    key={project.id}
                    style={{
                      padding: '10px 16px',
                      cursor: 'pointer',
                      fontSize: '14px',
                      color: 'var(--text-primary)',
                      backgroundColor: selectedProjectId === project.id ? 'var(--primary-light)' : 'transparent',
                      transition: 'background-color 0.15s ease',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                    }}
                    onClick={() => handleProjectSelect(project)}
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
                    <div
                      style={{
                        backgroundColor: project.color || '#666',
                        width: '12px',
                        height: '12px',
                        borderRadius: '50%',
                        flexShrink: 0,
                      }}
                    />
                    <div style={{ flex: 1 }}>
                      {project.name}
                      {project.customer && (
                        <span style={{ color: 'var(--text-secondary)', marginLeft: '8px' }}>
                          • {project.customer.name}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {showCreateOption && (
                  <div
                    style={{
                      padding: '10px 16px',
                      cursor: 'pointer',
                      fontSize: '14px',
                      color: 'var(--primary-color)',
                      borderTop: '1px solid var(--border-color)',
                      backgroundColor: 'var(--primary-light)',
                      fontWeight: '500',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                    onClick={() => {
                      setNewProjectName(projectSearch.trim());
                      setShowCreateProjectModal(true);
                      setShowProjectDropdown(false);
                    }}
                  >
                    <span>+</span>
                    <span>Create "{projectSearch.trim()}"</span>
                  </div>
                )}
              </div>
            )}
          </div>
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
          <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
            {user?.firstName} {user?.lastName}
          </span>
        </div>
      </div>

      {/* Create Project Modal */}
      {showCreateProjectModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
          }}
          onClick={() => {
            setShowCreateProjectModal(false);
            setNewProjectName('');
            setShouldAutoStart(false);
          }}
        >
          <div
            style={{
              backgroundColor: 'var(--bg-primary)',
              borderRadius: '12px',
              padding: '24px',
              maxWidth: '400px',
              width: '90%',
              boxShadow: 'var(--shadow-lg)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: '18px', fontWeight: '600', marginBottom: '16px', color: 'var(--text-primary)' }}>
              Create New Project
            </h3>
            <input
              type="text"
              placeholder="Project name"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter' && newProjectName.trim()) {
                  handleCreateProject();
                }
              }}
              autoFocus
              style={{
                width: '100%',
                padding: '10px 12px',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                fontSize: '14px',
                backgroundColor: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                marginBottom: '20px',
              }}
            />
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  setShowCreateProjectModal(false);
                  setNewProjectName('');
                  setShouldAutoStart(false);
                }}
                style={{
                  padding: '8px 16px',
                  backgroundColor: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleCreateProject}
                disabled={!newProjectName.trim() || createProjectMutation.isPending}
                style={{
                  padding: '8px 16px',
                  backgroundColor: 'var(--primary-color)',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: newProjectName.trim() && !createProjectMutation.isPending ? 'pointer' : 'not-allowed',
                  fontSize: '14px',
                  opacity: newProjectName.trim() && !createProjectMutation.isPending ? 1 : 0.5,
                }}
              >
                {createProjectMutation.isPending ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
