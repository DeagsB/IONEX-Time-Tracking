import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTimer } from '../context/TimerContext';
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
  const { timerRunning, timerStartTime, currentEntry } = useTimer();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [currentProject, setCurrentProject] = useState<string>('Time Tracking Software');
  const [viewMode, setViewMode] = useState<'week' | 'calendar' | 'list' | 'timesheet'>('calendar');
  const [currentTime, setCurrentTime] = useState(Date.now());
  
  // Zoom level: number of divisions per hour (2=halves, 4=quarters, 5=fifths, 6=sixths, etc.)
  const [divisionsPerHour, setDivisionsPerHour] = useState(4);
  
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

  // Get week display label
  const getWeekLabel = () => {
    const today = new Date();
    const todayWeekStart = getWeekStart(today);
    const currentWeekStart = weekStart;
    
    // Check if current displayed week is this week
    if (currentWeekStart.toDateString() === todayWeekStart.toDateString()) {
      return 'This week';
    }
    
    // Check if current displayed week is last week
    const lastWeekStart = new Date(todayWeekStart);
    lastWeekStart.setDate(todayWeekStart.getDate() - 7);
    if (currentWeekStart.toDateString() === lastWeekStart.toDateString()) {
      return 'Last week';
    }
    
    // Otherwise show date range: "08 - 14 Dec 2025"
    const startDay = weekStart.getDate();
    const endDay = weekEnd.getDate();
    const startMonth = weekStart.toLocaleDateString('en-US', { month: 'short' });
    const endMonth = weekEnd.toLocaleDateString('en-US', { month: 'short' });
    const year = weekEnd.getFullYear();
    
    // If same month
    if (startMonth === endMonth) {
      return `${String(startDay).padStart(2, '0')} - ${String(endDay).padStart(2, '0')} ${startMonth} ${year}`;
    } else {
      // If different months
      return `${String(startDay).padStart(2, '0')} ${startMonth} - ${String(endDay).padStart(2, '0')} ${endMonth} ${year}`;
    }
  };

  const weekStart = getWeekStart(currentDate);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);

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

  // Zoom controls
  // Update current time every second for running timer display
  useEffect(() => {
    if (timerRunning) {
      const interval = setInterval(() => {
        setCurrentTime(Date.now());
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [timerRunning]);

  const zoomIn = () => {
    if (divisionsPerHour < 12) {
      setDivisionsPerHour(prev => {
        const newValue = prev + 1;
        console.log(`🔍 Zoom IN: ${prev} → ${newValue} divisions per hour (${60/newValue} min blocks)`);
        return newValue;
      });
    }
  };

  const zoomOut = () => {
    if (divisionsPerHour > 2) {
      setDivisionsPerHour(prev => {
        const newValue = prev - 1;
        console.log(`🔍 Zoom OUT: ${prev} → ${newValue} divisions per hour (${60/newValue} min blocks)`);
        return newValue;
      });
    }
  };

  // Handle clicking on a time slot division
  const handleSlotClick = (date: Date, hour: number, division: number) => {
    const minutesPerDivision = 60 / divisionsPerHour;
    const startMinutes = division * minutesPerDivision;
    const endMinutes = (division + 1) * minutesPerDivision;
    
    const startHour = String(hour).padStart(2, '0');
    const startMin = String(Math.floor(startMinutes)).padStart(2, '0');
    const endMin = String(Math.floor(endMinutes) % 60).padStart(2, '0');
    const endHour = String(endMinutes >= 60 ? hour + 1 : hour).padStart(2, '0');
    
    setSelectedSlot({
      date,
      startTime: `${startHour}:${startMin}`,
      endTime: `${endHour}:${endMin}`,
    });
    setNewEntry({
      description: '',
      project_id: projects?.[0]?.id || '',
      hours: minutesPerDivision / 60,
    });
    setShowTimeEntryModal(true);
  };

  // Handle submitting the new time entry
  const handleSubmitTimeEntry = async () => {
    if (!selectedSlot) return;
    
    // Format date in local timezone (YYYY-MM-DD)
    const year = selectedSlot.date.getFullYear();
    const month = String(selectedSlot.date.getMonth() + 1).padStart(2, '0');
    const day = String(selectedSlot.date.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    
    // Use the dev user ID directly
    const actualUserId = user?.id || '235d854a-1b7d-4e00-a5a4-43835c85c086';
    
    // Create Date objects with local time, then convert to ISO with timezone
    const [startHour, startMin] = selectedSlot.startTime.split(':').map(Number);
    const [endHour, endMin] = selectedSlot.endTime.split(':').map(Number);
    
    const startDate = new Date(year, selectedSlot.date.getMonth(), selectedSlot.date.getDate(), startHour, startMin);
    const endDate = new Date(year, selectedSlot.date.getMonth(), selectedSlot.date.getDate(), endHour, endMin);
    
    // Convert to ISO string (includes timezone offset)
    const startDateTime = startDate.toISOString();
    const endDateTime = endDate.toISOString();
    
    const timeEntryData: any = {
      user_id: actualUserId,
      date: dateStr,
      start_time: startDateTime,
      end_time: endDateTime,
      hours: newEntry.hours,
      rate: 0, // Default rate, can be updated later
      description: newEntry.description || '',
      billable: true,
    };

    // Only add project_id if one is selected
    if (newEntry.project_id) {
      timeEntryData.project_id = newEntry.project_id;
    }

    console.log('Submitting time entry (with timezone):', timeEntryData);
    console.log('  Local time clicked:', selectedSlot.startTime, '-', selectedSlot.endTime);
    console.log('  ISO timestamps:', startDateTime, endDateTime);
    createTimeEntryMutation.mutate(timeEntryData);
  };

  // Get time entry position and height for rendering on grid
  const getEntryStyle = (entry: any) => {
    if (!entry.start_time || !entry.end_time) return null;
    
    // Parse ISO timestamp or HH:MM format
    const parseTime = (timeStr: string) => {
      // If it's an ISO timestamp (contains 'T' or space), extract time portion
      if (timeStr.includes('T') || timeStr.includes(' ')) {
        const date = new Date(timeStr);
        return {
          hour: date.getHours(),
          minute: date.getMinutes()
        };
      }
      // Otherwise parse as HH:MM format
      const [hour, minute] = timeStr.split(':').map(Number);
      return { hour, minute };
    };
    
    const startTime = parseTime(entry.start_time);
    const endTime = parseTime(entry.end_time);
    
    const startMinutes = startTime.hour * 60 + startTime.minute;
    const endMinutes = endTime.hour * 60 + endTime.minute;
    const duration = endMinutes - startMinutes;
    
    const rowHeight = 60; // Each hour is 60px
    const top = (startMinutes / 60) * rowHeight;
    const height = (duration / 60) * rowHeight;
    
    return { top, height };
  };

  const projectColors = ['#4ecdc4', '#ff6b6b', '#ffd93d', '#a8e6cf', '#dda0dd'];

  // Format time for display (handles both ISO timestamps and HH:MM format)
  const formatTimeDisplay = (timeStr: string) => {
    if (!timeStr) return '';
    // If it's an ISO timestamp, extract time portion
    if (timeStr.includes('T') || timeStr.includes(' ')) {
      const date = new Date(timeStr);
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return `${hours}:${minutes}`;
    }
    // Otherwise return first 5 chars (HH:MM)
    return timeStr.slice(0, 5);
  };

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
            style={{ 
              padding: '5px 10px',
              backgroundColor: 'transparent',
              border: 'none',
              fontSize: '20px',
              cursor: 'pointer'
            }}
          >
            ‹
          </button>
          <div style={{ 
            padding: '8px 16px', 
            backgroundColor: 'var(--bg-secondary)', 
            borderRadius: '6px',
            border: '1px solid var(--border-color)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            minWidth: '220px'
          }}>
            <span>📅</span>
            <strong>{getWeekLabel()}</strong>
            <span style={{ color: 'var(--text-secondary)' }}>· W{getWeekNumber(currentDate)}</span>
          </div>
          <button 
            className="button" 
            onClick={() => navigateWeek('next')}
            style={{ 
              padding: '5px 10px',
              backgroundColor: 'transparent',
              border: 'none',
              fontSize: '20px',
              cursor: 'pointer'
            }}
          >
            ›
          </button>
          <button
            className="button"
            onClick={() => setCurrentDate(new Date())}
            style={{
              padding: '6px 12px',
              fontSize: '13px',
              backgroundColor: 'var(--bg-primary)',
              border: '1px solid var(--border-color)'
            }}
            title="Go to current week"
          >
            ✕
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
          <div style={{ display: 'flex', gap: '5px' }}>
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
            {/* Zoom controls in header */}
            <div style={{ 
              height: '50px', 
              borderBottom: '1px solid var(--border-color)',
              backgroundColor: 'var(--bg-secondary)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px'
            }}>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    console.log('Zoom OUT button clicked, current:', divisionsPerHour);
                    zoomOut();
                  }}
                  disabled={divisionsPerHour <= 2}
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '4px',
                    border: '1px solid var(--border-color)',
                    backgroundColor: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    cursor: divisionsPerHour <= 2 ? 'not-allowed' : 'pointer',
                    opacity: divisionsPerHour <= 2 ? 0.5 : 1,
                    fontSize: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                  }}
                  title={`Zoom out (larger blocks) - Current: ${60/divisionsPerHour}min`}
                >
                  −
                </button>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    console.log('Zoom IN button clicked, current:', divisionsPerHour);
                    zoomIn();
                  }}
                  disabled={divisionsPerHour >= 12}
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '4px',
                    border: '1px solid var(--border-color)',
                    backgroundColor: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    cursor: divisionsPerHour >= 12 ? 'not-allowed' : 'pointer',
                    opacity: divisionsPerHour >= 12 ? 0.5 : 1,
                    fontSize: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                  }}
                  title={`Zoom in (smaller blocks) - Current: ${60/divisionsPerHour}min`}
                >
                  +
                </button>
              </div>
              <div style={{ fontSize: '9px', color: 'var(--text-secondary)', fontWeight: '600' }}>
                {Math.round(60/divisionsPerHour)}m
              </div>
            </div>
            
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
            // Format date in local timezone (YYYY-MM-DD)
            const year = day.date.getFullYear();
            const month = String(day.date.getMonth() + 1).padStart(2, '0');
            const dayNum = String(day.date.getDate()).padStart(2, '0');
            const dateStr = `${year}-${month}-${dayNum}`;
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
                {/* Day header - compact layout */}
                <div style={{
                  height: '50px',
                  borderBottom: '1px solid var(--border-color)',
                  backgroundColor: day.isToday ? '#c770f050' : 'var(--bg-secondary)',
                  padding: '8px 12px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                  gap: '2px'
                }}>
                  <div style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '8px',
                    fontSize: '14px',
                  }}>
                    <span style={{ 
                      fontSize: '18px', 
                      fontWeight: 'bold',
                      color: day.isToday ? '#c770f0' : 'var(--text-primary)'
                    }}>
                      {day.displayDate}
                    </span>
                    <span style={{ 
                      fontSize: '11px', 
                      textTransform: 'uppercase', 
                      fontWeight: '600',
                      letterSpacing: '0.5px',
                      color: 'var(--text-secondary)'
                    }}>
                      {day.name}
                    </span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                    {getDayTotal(day.date)}
                  </div>
                </div>

                {/* Time grid with clickable divisions */}
                <div key={`grid-${divisionsPerHour}`} style={{ position: 'relative' }}>
                  {timeSlots.map((_, hourIndex) => (
                    <div
                      key={`hour-${hourIndex}-${divisionsPerHour}`}
                      style={{
                        height: '60px',
                        borderBottom: '1px solid var(--border-color)',
                        backgroundColor: hourIndex % 2 === 0 ? 'var(--bg-primary)' : 'var(--bg-secondary)',
                        display: 'flex',
                        flexDirection: 'column',
                        position: 'relative'
                      }}
                    >
                      {/* Clickable divisions based on zoom level */}
                      {Array.from({ length: divisionsPerHour }).map((_, divisionIndex) => (
                        <div
                          key={`div-${hourIndex}-${divisionIndex}-${divisionsPerHour}`}
                          onClick={() => handleSlotClick(day.date, hourIndex, divisionIndex)}
                          style={{
                            flex: 1,
                            borderBottom: divisionIndex < divisionsPerHour - 1 ? '1px dashed rgba(128, 128, 128, 0.1)' : 'none',
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
                        {/* Description - main text (if exists) */}
                        {entry.description && (
                          <div style={{ fontWeight: '600', fontSize: '11px', marginBottom: '2px' }}>
                            {entry.description}
                          </div>
                        )}
                        
                        {/* Project name */}
                        <div style={{ fontSize: '10px', opacity: 0.9 }}>
                          {project?.name || '(No Project)'}
                        </div>
                        
                        {/* Time range (only show if there's enough space) */}
                        {style.height > 45 && (
                          <div style={{ fontSize: '10px', marginTop: '2px', opacity: 0.8 }}>
                            {formatTimeDisplay(entry.start_time)} - {formatTimeDisplay(entry.end_time)}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Running timer indicator */}
                  {timerRunning && timerStartTime && day.isToday && (() => {
                    const startDate = new Date(timerStartTime);
                    const startHour = startDate.getHours();
                    const startMin = startDate.getMinutes();
                    const startMinutes = startHour * 60 + startMin;

                    const now = new Date(currentTime);
                    const endHour = now.getHours();
                    const endMin = now.getMinutes();
                    const endMinutes = endHour * 60 + endMin;

                    const duration = endMinutes - startMinutes;
                    const rowHeight = 60;
                    const top = (startMinutes / 60) * rowHeight;
                    const height = Math.max((duration / 60) * rowHeight, 30);

                    const timerProject = projects?.find((p: any) => p.id === currentEntry?.projectId);

                    return (
                      <div
                        key="running-timer"
                        style={{
                          position: 'absolute',
                          top: `${top}px`,
                          height: `${height}px`,
                          left: '4px',
                          right: '4px',
                          backgroundColor: '#ff6b6b',
                          borderRadius: '4px',
                          padding: '6px 8px',
                          fontSize: '12px',
                          color: 'white',
                          overflow: 'hidden',
                          boxShadow: '0 2px 8px rgba(255, 107, 107, 0.4)',
                          zIndex: 2,
                          border: '2px solid #ff5252',
                          animation: 'pulse 2s ease-in-out infinite'
                        }}
                      >
                        {/* Timer icon + Description (main text) */}
                        <div style={{ fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}>
                          <span style={{ fontSize: '10px' }}>⏱️</span>
                          {currentEntry?.description || 'Timer Running'}
                        </div>
                        
                        {/* Project name */}
                        <div style={{ fontSize: '10px', marginTop: '2px', opacity: 0.9 }}>
                          {timerProject?.name || '(No Project)'}
                        </div>
                        
                        {/* Time range (only if there's space) */}
                        {height > 45 && (
                          <div style={{ fontSize: '10px', marginTop: '2px', opacity: 0.8 }}>
                            {String(startHour).padStart(2, '0')}:{String(startMin).padStart(2, '0')} - Now
                          </div>
                        )}
                      </div>
                    );
                  })()}
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
