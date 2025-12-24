import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { timeEntriesService, projectsService } from '../services/supabaseServices';
import { supabase } from '../lib/supabaseClient';

interface TimeEntry {
  id: string;
  project_id?: string;
  date: string;
  start_time?: string;
  end_time?: string;
  hours: number;
  description?: string;
  project?: any;
}

interface Project {
  id: string;
  name: string;
  customer_id?: string;
  color?: string;
}

export default function WeekView() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [runningTimer, setRunningTimer] = useState<number>(0);
  const [currentProject, setCurrentProject] = useState<string>('Time Tracking Software');
  const [isTimerRunning, setIsTimerRunning] = useState(true);
  const [viewMode, setViewMode] = useState<'week' | 'calendar' | 'list' | 'timesheet'>('calendar');
  
  // Time entry modal state
  const [showTimeEntryModal, setShowTimeEntryModal] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<{
    date: Date;
    startTime: string;
    endTime: string;
  } | null>(null);
  const [newEntry, setNewEntry] = useState({
    description: '',
    project_id: '',
    hours: 0.25,
  });
  
  // Get week start (Monday)
  const getWeekStart = (date: Date) => {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff));
  };

  // Get week number
  const getWeekNumber = (date: Date) => {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return weekNo;
  };

  const weekStart = getWeekStart(currentDate);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);

  // Running timer effect
  useEffect(() => {
    if (isTimerRunning) {
      const interval = setInterval(() => {
        setRunningTimer(prev => prev + 1);
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [isTimerRunning]);

  const { data: timeEntries } = useQuery({
    queryKey: ['timeEntries', 'week', weekStart.toISOString()],
    queryFn: async () => {
      const allEntries = await timeEntriesService.getAll();
      return allEntries?.filter((entry: any) => {
        const entryDate = new Date(entry.date);
        return entryDate >= weekStart && entryDate <= weekEnd;
      });
    },
  });

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: projectsService.getAll,
  });

  const createTimeEntryMutation = useMutation({
    mutationFn: async (data: any) => {
      console.log('Creating time entry:', data);
      const result = await timeEntriesService.create(data);
      console.log('Time entry created:', result);
      return result;
    },
    onSuccess: (data) => {
      console.log('Time entry saved successfully:', data);
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
      setShowTimeEntryModal(false);
      setNewEntry({ description: '', project_id: '', hours: 0.25 });
      setSelectedSlot(null);
    },
    onError: (error: any) => {
      console.error('Error creating time entry:', error);
      alert('Error creating time entry: ' + (error.message || 'Unknown error'));
    },
  });

  const days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  
  // Generate time slots (24 hours)
  const timeSlots: string[] = [];
  for (let i = 0; i < 24; i++) {
    const hour = i === 0 ? 12 : i > 12 ? i - 12 : i;
    const ampm = i < 12 ? 'AM' : 'PM';
    timeSlots.push(`${hour}:00 ${ampm}`);
  }

  // Generate days with dates
  const weekDays = days.map((day, index) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + index);
    return {
      name: day,
      date: d,
      displayDate: d.getDate(),
      isToday: new Date().toDateString() === d.toDateString(),
    };
  });

  // Format time helper
  const formatTime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  // Calculate week total
  const getWeekTotal = () => {
    if (!timeEntries) return '00:00:00';
    const totalSeconds = timeEntries.reduce((sum: number, e: any) => sum + Number(e.hours) * 3600, 0);
    return formatTime(Math.floor(totalSeconds));
  };

  // Get day total
  const getDayTotal = (date: Date) => {
    if (!timeEntries) return '0:00:00';
    const dateStr = date.toISOString().split('T')[0];
    const totalSeconds = timeEntries
      .filter((e: any) => e.date === dateStr)
      .reduce((sum: number, e: any) => sum + Number(e.hours) * 3600, 0);
    return formatTime(Math.floor(totalSeconds));
  };

  // Get unique projects from entries
  const getProjectSummary = () => {
    if (!timeEntries || !projects) return [];
    const projectMap = new Map();
    
    timeEntries.forEach((entry: any) => {
      const projectId = entry.project_id || 'no-project';
      const project = projects.find((p: any) => p.id === projectId);
      const projectName = project?.name || '(NO PROJECT)';
      
      if (!projectMap.has(projectId)) {
        projectMap.set(projectId, {
          id: projectId,
          name: projectName,
          color: project?.color || '#666',
          hours: 0,
        });
      }
      projectMap.get(projectId).hours += Number(entry.hours);
    });

    return Array.from(projectMap.values());
  };

  const navigateWeek = (direction: 'prev' | 'next') => {
    const newDate = new Date(currentDate);
    newDate.setDate(currentDate.getDate() + (direction === 'next' ? 7 : -7));
    setCurrentDate(newDate);
  };

  // Handle clicking on a time slot quarter
  const handleQuarterClick = (date: Date, hour: number, quarter: number) => {
    const minutes = quarter * 15;
    const startHour = String(hour).padStart(2, '0');
    const startMin = String(minutes).padStart(2, '0');
    const endMin = String((minutes + 15) % 60).padStart(2, '0');
    const endHour = String(minutes + 15 >= 60 ? hour + 1 : hour).padStart(2, '0');
    
    setSelectedSlot({
      date,
      startTime: `${startHour}:${startMin}`,
      endTime: `${endHour}:${endMin}`,
    });
    setNewEntry({
      description: '',
      project_id: projects?.[0]?.id || '',
      hours: 0.25,
    });
    setShowTimeEntryModal(true);
  };

  // Handle submitting the new time entry
  const handleSubmitTimeEntry = async () => {
    if (!selectedSlot) return;
    
    const dateStr = selectedSlot.date.toISOString().split('T')[0];
    
    // For dev mode, we need to get or create a real user
    let actualUserId = user?.id;
    
    // If we're in dev mode with mock user, get the first real user from database
    if (user?.id === 'dev-admin-id') {
      try {
        const { data: users } = await supabase.from('users').select('id').limit(1);
        if (users && users.length > 0) {
          actualUserId = users[0].id;
        } else {
          alert('No users found in database. Please create a user first.');
          return;
        }
      } catch (error) {
        console.error('Error getting user:', error);
        alert('Error: Could not find a user. Please check your database setup.');
        return;
      }
    }
    
    const timeEntryData: any = {
      user_id: actualUserId,
      date: dateStr,
      start_time: `${dateStr}T${selectedSlot.startTime}:00`,
      end_time: `${dateStr}T${selectedSlot.endTime}:00`,
      hours: newEntry.hours,
      rate: 0, // Default rate, can be updated later
      description: newEntry.description || '',
      billable: true,
    };

    // Only add project_id if one is selected
    if (newEntry.project_id) {
      timeEntryData.project_id = newEntry.project_id;
    }

    console.log('Submitting time entry:', timeEntryData);
    createTimeEntryMutation.mutate(timeEntryData);
  };

  // Get time entry position and height for rendering on grid
  const getEntryStyle = (entry: any) => {
    if (!entry.start_time || !entry.end_time) return null;
    
    const [startHour, startMin] = entry.start_time.split(':').map(Number);
    const [endHour, endMin] = entry.end_time.split(':').map(Number);
    
    const startMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;
    const duration = endMinutes - startMinutes;
    
    const rowHeight = 60; // Each hour is 60px
    const top = (startMinutes / 60) * rowHeight;
    const height = (duration / 60) * rowHeight;
    
    return { top, height };
  };

  const projectColors = ['#4ecdc4', '#ff6b6b', '#ffd93d', '#a8e6cf', '#dda0dd'];

  return (
    <div style={{ height: 'calc(100vh - 80px)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        padding: '15px 20px',
        borderBottom: '1px solid var(--border-color)',
        backgroundColor: 'var(--bg-primary)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <button 
            className="button" 
            onClick={() => navigateWeek('prev')}
            style={{ padding: '5px 10px' }}
          >
            ‹
          </button>
          <div style={{ 
            padding: '8px 16px', 
            backgroundColor: 'var(--bg-secondary)', 
            borderRadius: '6px',
            border: '1px solid var(--border-color)'
          }}>
            <strong>This week</strong> · W{getWeekNumber(currentDate)}
          </div>
          <button 
            className="button" 
            onClick={() => navigateWeek('next')}
            style={{ padding: '5px 10px' }}
          >
            ›
          </button>
          <div style={{ marginLeft: '20px', color: 'var(--text-secondary)' }}>
            <span style={{ fontSize: '12px', textTransform: 'uppercase' }}>Week Total</span>
            <span style={{ marginLeft: '10px', fontWeight: 'bold', fontSize: '16px' }}>
              {getWeekTotal()}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          {/* View toggles */}
          <div style={{ display: 'flex', gap: '5px', marginRight: '20px' }}>
            <button
              className="button"
              onClick={() => setViewMode('week')}
              style={{
                backgroundColor: viewMode === 'week' ? 'var(--primary-color)' : 'transparent',
                color: viewMode === 'week' ? 'white' : 'var(--text-primary)',
                padding: '6px 12px',
                fontSize: '13px'
              }}
            >
              Week view
            </button>
            <button
              className="button"
              style={{
                backgroundColor: viewMode === 'calendar' ? '#c770f0' : 'transparent',
                color: viewMode === 'calendar' ? 'white' : 'var(--text-primary)',
                padding: '6px 12px',
                fontSize: '13px'
              }}
            >
              Calendar
            </button>
            <button
              className="button"
              onClick={() => navigate('/time-entries')}
              style={{
                backgroundColor: viewMode === 'list' ? 'var(--primary-color)' : 'transparent',
                color: viewMode === 'list' ? 'white' : 'var(--text-primary)',
                padding: '6px 12px',
                fontSize: '13px'
              }}
            >
              List view
            </button>
            <button
              className="button"
              onClick={() => navigate('/reports')}
              style={{
                backgroundColor: viewMode === 'timesheet' ? 'var(--primary-color)' : 'transparent',
                color: viewMode === 'timesheet' ? 'white' : 'var(--text-primary)',
                padding: '6px 12px',
                fontSize: '13px'
              }}
            >
              Timesheet
            </button>
          </div>

          {/* Running timer */}
          <div style={{
            backgroundColor: '#1a1a1a',
            padding: '8px 16px',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px'
          }}>
            <span style={{ color: 'white', fontFamily: 'monospace', fontSize: '16px' }}>
              {formatTime(runningTimer)}
            </span>
            <button
              onClick={() => setIsTimerRunning(!isTimerRunning)}
              style={{
                backgroundColor: '#ff6b6b',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                width: '32px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                fontSize: '18px'
              }}
            >
              ⬛
            </button>
          </div>
        </div>
      </div>

      {/* Project Summary Bars */}
      <div style={{ 
        display: 'flex', 
        gap: '20px', 
        padding: '15px 20px',
        borderBottom: '1px solid var(--border-color)',
        backgroundColor: 'var(--bg-primary)'
      }}>
        {getProjectSummary().map((proj, index) => (
          <div key={proj.id} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{
              width: '12px',
              height: '12px',
              borderRadius: '2px',
              backgroundColor: proj.color || projectColors[index % projectColors.length]
            }} />
            <span style={{ 
              fontSize: '13px', 
              textTransform: 'uppercase',
              fontWeight: '600',
              letterSpacing: '0.5px'
            }}>
              {proj.name}
            </span>
          </div>
        ))}
      </div>

      {/* Calendar Grid */}
      <div style={{ flex: 1, overflow: 'auto', backgroundColor: 'var(--bg-primary)' }}>
        <div style={{ display: 'flex', minWidth: 'min-content' }}>
          {/* Time column */}
          <div style={{ 
            width: '80px', 
            flexShrink: 0, 
            borderRight: '1px solid var(--border-color)',
            position: 'sticky',
            left: 0,
            backgroundColor: 'var(--bg-primary)',
            zIndex: 2
          }}>
            {/* Empty header cell */}
            <div style={{ 
              height: '80px', 
              borderBottom: '1px solid var(--border-color)',
              backgroundColor: 'var(--bg-secondary)'
            }} />
            
            {/* Time slots */}
            {timeSlots.map((time, index) => (
              <div
                key={index}
                style={{
                  height: '60px',
                  borderBottom: '1px solid var(--border-color)',
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'flex-end',
                  padding: '5px 10px',
                  fontSize: '11px',
                  color: 'var(--text-secondary)'
                }}
              >
                {time}
              </div>
            ))}
          </div>

          {/* Days columns */}
          {weekDays.map((day, dayIndex) => {
            const dateStr = day.date.toISOString().split('T')[0];
            const dayEntries = timeEntries?.filter((e: any) => e.date === dateStr) || [];

            return (
              <div
                key={dayIndex}
                style={{
                  flex: 1,
                  minWidth: '150px',
                  borderRight: dayIndex < 6 ? '1px solid var(--border-color)' : 'none',
                  position: 'relative'
                }}
              >
                {/* Day header */}
                <div style={{
                  height: '80px',
                  borderBottom: '1px solid var(--border-color)',
                  backgroundColor: day.isToday ? '#ff69b440' : 'var(--bg-secondary)',
                  padding: '10px',
                  textAlign: 'center'
                }}>
                  <div style={{ 
                    fontSize: '24px', 
                    fontWeight: 'bold',
                    color: day.isToday ? '#ff69b4' : 'var(--text-primary)'
                  }}>
                    {day.displayDate}
                  </div>
                  <div style={{ 
                    fontSize: '11px', 
                    textTransform: 'uppercase', 
                    marginTop: '4px',
                    fontWeight: '600',
                    letterSpacing: '0.5px'
                  }}>
                    {day.name}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    {getDayTotal(day.date)}
                  </div>
                </div>

                {/* Time grid with clickable quarters */}
                <div style={{ position: 'relative' }}>
                  {timeSlots.map((_, hourIndex) => (
                    <div
                      key={hourIndex}
                      style={{
                        height: '60px',
                        borderBottom: '1px solid var(--border-color)',
                        backgroundColor: hourIndex % 2 === 0 ? 'var(--bg-primary)' : 'var(--bg-secondary)',
                        display: 'flex',
                        flexDirection: 'column',
                        position: 'relative'
                      }}
                    >
                      {/* 4 clickable quarters (15-min each) */}
                      {[0, 1, 2, 3].map((quarter) => (
                        <div
                          key={quarter}
                          onClick={() => handleQuarterClick(day.date, hourIndex, quarter)}
                          style={{
                            flex: 1,
                            borderBottom: quarter < 3 ? '1px dashed rgba(128, 128, 128, 0.1)' : 'none',
                            cursor: 'pointer',
                            transition: 'background-color 0.2s',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = 'rgba(200, 112, 240, 0.15)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = 'transparent';
                          }}
                        />
                      ))}
                    </div>
                  ))}

                  {/* Time entries */}
                  {dayEntries.map((entry: any, entryIndex) => {
                    const style = getEntryStyle(entry);
                    if (!style) return null;

                    const project = projects?.find((p: any) => p.id === entry.project_id);
                    const color = project?.color || projectColors[entryIndex % projectColors.length];

                    return (
                      <div
                        key={entry.id}
                        style={{
                          position: 'absolute',
                          top: `${style.top}px`,
                          height: `${Math.max(style.height, 30)}px`,
                          left: '4px',
                          right: '4px',
                          backgroundColor: color,
                          borderRadius: '4px',
                          padding: '6px 8px',
                          fontSize: '12px',
                          color: 'white',
                          overflow: 'hidden',
                          cursor: 'pointer',
                          boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                          zIndex: 1
                        }}
                        onClick={() => navigate(`/calendar/${dateStr}`)}
                      >
                        <div style={{ fontWeight: '600' }}>{project?.name || currentProject}</div>
                        <div style={{ fontSize: '11px', marginTop: '2px' }}>
                          {entry.start_time?.slice(0, 5)} - {entry.end_time?.slice(0, 5)}
                        </div>
                        {entry.description && style.height > 50 && (
                          <div style={{ fontSize: '10px', marginTop: '2px', opacity: 0.9 }}>
                            {entry.description}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Time Entry Modal */}
      {showTimeEntryModal && selectedSlot && (
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
            zIndex: 1000,
          }}
          onClick={() => setShowTimeEntryModal(false)}
        >
          <div
            className="card"
            style={{
              width: '500px',
              padding: '0',
              backgroundColor: 'var(--bg-secondary)',
              position: 'relative',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button */}
            <button
              onClick={() => setShowTimeEntryModal(false)}
              style={{
                position: 'absolute',
                top: '15px',
                right: '15px',
                background: 'none',
                border: 'none',
                fontSize: '20px',
                cursor: 'pointer',
                color: 'var(--text-secondary)',
                padding: '5px',
              }}
            >
              ✕
            </button>

            <div style={{ padding: '20px' }}>
              <h3 style={{ marginBottom: '20px' }}>Add a description</h3>

              {/* Description input */}
              <textarea
                placeholder="What are you working on?"
                value={newEntry.description}
                onChange={(e) => setNewEntry({ ...newEntry, description: e.target.value })}
                style={{
                  width: '100%',
                  minHeight: '80px',
                  padding: '12px',
                  marginBottom: '20px',
                  backgroundColor: 'var(--bg-primary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  resize: 'vertical',
                }}
              />

              {/* Icon buttons */}
              <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
                <button
                  className="button"
                  style={{
                    padding: '8px 12px',
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                  }}
                  title="Project"
                >
                  📁
                </button>
                <button
                  className="button"
                  style={{
                    padding: '8px 12px',
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                  }}
                  title="Tags"
                >
                  🏷️
                </button>
                <button
                  className="button"
                  style={{
                    padding: '8px 12px',
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                  }}
                  title="Billable"
                >
                  💰
                </button>
              </div>

              {/* Time inputs */}
              <div style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '20px' }}>
                <input
                  type="time"
                  value={selectedSlot.startTime}
                  onChange={(e) => setSelectedSlot({ ...selectedSlot, startTime: e.target.value })}
                  style={{
                    padding: '10px',
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    color: 'var(--text-primary)',
                    fontSize: '14px',
                  }}
                />
                <span>→</span>
                <input
                  type="time"
                  value={selectedSlot.endTime}
                  onChange={(e) => {
                    setSelectedSlot({ ...selectedSlot, endTime: e.target.value });
                    // Calculate hours
                    const [startH, startM] = selectedSlot.startTime.split(':').map(Number);
                    const [endH, endM] = e.target.value.split(':').map(Number);
                    const hours = (endH * 60 + endM - (startH * 60 + startM)) / 60;
                    setNewEntry({ ...newEntry, hours });
                  }}
                  style={{
                    padding: '10px',
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    color: 'var(--text-primary)',
                    fontSize: '14px',
                  }}
                />
                <div
                  style={{
                    padding: '10px 15px',
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    fontSize: '14px',
                  }}
                >
                  {newEntry.hours.toFixed(2)}h
                </div>
              </div>

              {/* Project select */}
              <div className="form-group" style={{ marginBottom: '20px' }}>
                <label className="label">Project</label>
                <select
                  className="input"
                  value={newEntry.project_id}
                  onChange={(e) => setNewEntry({ ...newEntry, project_id: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '10px',
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    color: 'var(--text-primary)',
                  }}
                >
                  <option value="">No Project</option>
                  {projects?.map((project: any) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Add button */}
              <button
                className="button button-primary"
                onClick={handleSubmitTimeEntry}
                disabled={createTimeEntryMutation.isPending}
                style={{
                  width: '100%',
                  padding: '12px',
                  backgroundColor: '#c770f0',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '15px',
                  fontWeight: '600',
                  cursor: 'pointer',
                }}
              >
                {createTimeEntryMutation.isPending ? 'Adding...' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
