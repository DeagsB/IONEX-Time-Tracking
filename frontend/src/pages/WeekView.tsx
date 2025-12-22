import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';

interface TimeEntry {
  id: string;
  projectId?: string;
  date: string;
  startTime?: string;
  endTime?: string;
  hours: number;
  rate: number;
  billable: boolean;
  description?: string;
  project?: {
    id: string;
    name: string;
    customer?: { name: string };
  };
}

export default function WeekView() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [currentWeek, setCurrentWeek] = useState(() => {
    const today = new Date();
    const day = today.getDay();
    const diff = today.getDate() - day + (day === 0 ? -6 : 1); // Adjust to Monday
    const monday = new Date(today.setDate(diff));
    return monday;
  });
  const [showEntryModal, setShowEntryModal] = useState(false);
  const [selectedTimeSlot, setSelectedTimeSlot] = useState<{
    date: Date;
    hour: number;
    quarter: number; // 0, 1, 2, or 3 (representing 15-min intervals)
  } | null>(null);
  const [entryForm, setEntryForm] = useState({
    description: '',
    projectId: '',
    startTime: '',
    endTime: '',
    hours: '0.25',
    billable: true,
  });

  const getWeekDates = () => {
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(currentWeek);
      date.setDate(currentWeek.getDate() + i);
      dates.push(date);
    }
    return dates;
  };

  const weekDates = getWeekDates();
  const weekStart = weekDates[0];
  const weekEnd = weekDates[6];
  weekEnd.setHours(23, 59, 59, 999);

  const { data: timeEntries } = useQuery({
    queryKey: ['timeEntries', 'week', weekStart.toISOString()],
    queryFn: async () => {
      const response = await axios.get(
        `/api/time-entries?startDate=${weekStart.toISOString()}&endDate=${weekEnd.toISOString()}`
      );
      return response.data || [];
    },
  });

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: async () => {
      const response = await axios.get('/api/projects');
      return response.data || [];
    },
  });

  const createTimeEntryMutation = useMutation({
    mutationFn: async (data: any) => {
      const response = await axios.post('/api/time-entries', data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
      setShowEntryModal(false);
      setSelectedTimeSlot(null);
      setEntryForm({
        description: '',
        projectId: '',
        startTime: '',
        endTime: '',
        hours: '0.25',
        billable: true,
      });
    },
  });

  const handleQuarterClick = (date: Date, hour: number, quarter: number) => {
    try {
      // Calculate start and end times based on quarter
      const startDate = new Date(date);
      startDate.setHours(hour, quarter * 15, 0, 0);
      
      const endDate = new Date(startDate);
      endDate.setMinutes(endDate.getMinutes() + 15); // Default to 15 minutes
      
      // Format for datetime-local input (YYYY-MM-DDTHH:mm)
      const formatDateTimeLocal = (d: Date) => {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const hours = String(d.getHours()).padStart(2, '0');
        const minutes = String(d.getMinutes()).padStart(2, '0');
        return `${year}-${month}-${day}T${hours}:${minutes}`;
      };
      
      setSelectedTimeSlot({ date, hour, quarter });
      setEntryForm({
        description: '',
        projectId: '',
        startTime: formatDateTimeLocal(startDate),
        endTime: formatDateTimeLocal(endDate),
        hours: '0.25', // 15 minutes = 0.25 hours
        billable: true,
      });
      setShowEntryModal(true);
    } catch (error) {
      console.error('Error in handleQuarterClick:', error);
    }
  };

  const calculateDuration = () => {
    if (!entryForm.startTime || !entryForm.endTime) return '0:00:00';
    try {
      const start = new Date(entryForm.startTime);
      const end = new Date(entryForm.endTime);
      
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return '0:00:00';
      }
      
      const diffMs = end.getTime() - start.getTime();
      if (diffMs <= 0) return '0:00:00';
      
      const totalSeconds = Math.floor(diffMs / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    } catch (error) {
      console.error('Error calculating duration:', error);
      return '0:00:00';
    }
  };

  const handleTimeChange = (field: 'startTime' | 'endTime', value: string) => {
    setEntryForm(prev => {
      const updated = { ...prev, [field]: value };
      
      // Recalculate hours when times change
      if (updated.startTime && updated.endTime) {
        try {
          const start = new Date(updated.startTime);
          const end = new Date(updated.endTime);
          
          if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
            const diffMs = end.getTime() - start.getTime();
            if (diffMs > 0) {
              const hoursDecimal = diffMs / (1000 * 60 * 60);
              updated.hours = hoursDecimal.toFixed(2);
            }
          }
        } catch (error) {
          console.error('Error calculating hours:', error);
        }
      }
      
      return updated;
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!selectedTimeSlot) return;
    
    try {
      // Parse datetime-local format to Date objects
      const start = new Date(entryForm.startTime);
      const end = new Date(entryForm.endTime);
      
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        alert('Invalid date/time values');
        return;
      }
      
      const project = projects?.find((p: any) => p.id === entryForm.projectId);
      const rate = project?.rate || 0;

      createTimeEntryMutation.mutate({
        projectId: entryForm.projectId || null,
        date: selectedTimeSlot.date.toISOString().split('T')[0],
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        hours: parseFloat(entryForm.hours) || 0,
        rate: rate,
        billable: entryForm.billable,
        description: entryForm.description,
      });
    } catch (error) {
      console.error('Error submitting form:', error);
      alert('Error creating time entry. Please check the console for details.');
    }
  };

  const getTimeEntriesForDate = (date: Date) => {
    if (!timeEntries) return [];
    const dateStr = date.toISOString().split('T')[0];
    return timeEntries.filter((entry: TimeEntry) => {
      const entryDate = new Date(entry.date).toISOString().split('T')[0];
      return entryDate === dateStr;
    });
  };

  const getTotalHoursForDate = (date: Date) => {
    const entries = getTimeEntriesForDate(date);
    return entries.reduce((sum: number, entry: TimeEntry) => sum + entry.hours, 0);
  };

  const getWeekTotal = () => {
    if (!timeEntries) return 0;
    return timeEntries.reduce((sum: number, entry: TimeEntry) => sum + entry.hours, 0);
  };

  const formatTime = (hours: number) => {
    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);
    const s = Math.floor(((hours - h) * 60 - m) * 60);
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const getProjectColor = (projectId?: string) => {
    if (!projectId) return '#6c757d';
    const colors = ['#10b981', '#dc2626', '#3b82f6', '#f59e0b', '#ef4444', '#06b6d4'];
    const index = projects?.findIndex((p: any) => p.id === projectId) || 0;
    return colors[index % colors.length];
  };

  const navigateWeek = (direction: number) => {
    const newDate = new Date(currentWeek);
    newDate.setDate(currentWeek.getDate() + (direction * 7));
    setCurrentWeek(newDate);
  };

  const goToToday = () => {
    const today = new Date();
    const day = today.getDay();
    const diff = today.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(today.setDate(diff));
    setCurrentWeek(monday);
  };

  const getWeekNumber = (date: Date) => {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  };

  const weekNumber = getWeekNumber(weekStart);
  const weekTotal = getWeekTotal();

  // Time slots from 8 AM to 11 PM
  const timeSlots = [];
  for (let hour = 8; hour <= 23; hour++) {
    timeSlots.push(hour);
  }

  const getEntryPosition = (entry: TimeEntry, dayIndex: number) => {
    if (!entry.startTime) return null; // Need start time to position
    
    const start = new Date(entry.startTime);
    const end = entry.endTime ? new Date(entry.endTime) : new Date(start.getTime() + entry.hours * 3600000);
    
    // Check which day this entry belongs to
    const entryDate = start.toDateString();
    const dayDate = weekDates[dayIndex].toDateString();
    
    // If entry doesn't belong to this day, skip it
    if (entryDate !== dayDate) {
      return null;
    }
    
    const startHour = start.getHours() + start.getMinutes() / 60;
    const endHour = end.getHours() + end.getMinutes() / 60;
    
    // Only show entries between 8 AM and 11 PM
    if (startHour < 8 || startHour >= 24) {
      return null;
    }
    
    // Clamp end hour to visible range
    const visibleEndHour = Math.min(endHour, 24);
    
    const slotHeight = 60; // Height of each hour slot in pixels
    const top = (startHour - 8) * slotHeight;
    const height = Math.max((visibleEndHour - startHour) * slotHeight, 40); // Minimum height of 40px
    
    return { top, height };
  };

  const dayNames = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  return (
    <div>
      {/* Week Navigation */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '20px',
        padding: '15px 20px',
        backgroundColor: 'var(--bg-primary)',
        borderRadius: '8px',
        border: '1px solid var(--border-color)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <button
            onClick={() => navigateWeek(-1)}
            style={{
              background: 'none',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              padding: '6px 12px',
              cursor: 'pointer',
              color: 'var(--text-primary)',
            }}
          >
            ←
          </button>
          <button
            onClick={() => navigateWeek(1)}
            style={{
              background: 'none',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              padding: '6px 12px',
              cursor: 'pointer',
              color: 'var(--text-primary)',
            }}
          >
            →
          </button>
          <div style={{ fontSize: '16px', fontWeight: '500', color: 'var(--text-primary)' }}>
            This week W{weekNumber}
          </div>
        </div>
        <div style={{ fontSize: '16px', fontWeight: '600', color: 'var(--text-primary)' }}>
          WEEK TOTAL {formatTime(weekTotal)}
        </div>
        <button
          onClick={goToToday}
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: '6px',
            padding: '6px 12px',
            cursor: 'pointer',
            color: 'var(--text-primary)',
            fontSize: '14px',
          }}
        >
          Today
        </button>
      </div>

      {/* Project Categories */}
      {projects && projects.length > 0 && (
        <div style={{
          marginBottom: '10px',
          display: 'flex',
          gap: '10px',
          flexWrap: 'wrap',
        }}>
          {projects.slice(0, 3).map((project: any, index: number) => (
            <div
              key={project.id}
              style={{
                height: '4px',
                backgroundColor: getProjectColor(project.id),
                flex: '1',
                minWidth: '200px',
                borderRadius: '2px',
              }}
              title={`${project.name} • ${project.customer?.name || 'No Customer'}`}
            />
          ))}
        </div>
      )}

      {/* Calendar Grid */}
      <div style={{
        backgroundColor: 'var(--bg-primary)',
        borderRadius: '8px',
        border: '1px solid var(--border-color)',
        overflow: 'hidden',
      }}>
        {/* Header with day names */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '80px repeat(7, 1fr)',
          borderBottom: '2px solid var(--border-color)',
        }}>
          <div style={{ padding: '15px', fontWeight: '600', color: 'var(--text-secondary)' }}></div>
          {weekDates.map((date, index) => {
            const isToday = date.toDateString() === new Date().toDateString();
            const totalHours = getTotalHoursForDate(date);
            return (
              <div
                key={index}
                style={{
                  padding: '15px',
                  textAlign: 'center',
                  borderRight: index < 6 ? '1px solid var(--border-color)' : 'none',
                  backgroundColor: isToday ? 'rgba(139, 92, 246, 0.1)' : 'transparent',
                }}
              >
                <div style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '4px' }}>
                  {dayNames[index]}
                </div>
                <div style={{ fontSize: '20px', fontWeight: 'bold', color: 'var(--text-primary)', marginBottom: '4px' }}>
                  {date.getDate()}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  {formatTime(totalHours)}
                </div>
              </div>
            );
          })}
        </div>

        {/* Time slots */}
        <div style={{ position: 'relative', minHeight: '960px' }}>
          {/* Time labels */}
          <div style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: '80px',
            borderRight: '1px solid var(--border-color)',
          }}>
            {timeSlots.map((hour) => (
              <div
                key={hour}
                style={{
                  height: '60px',
                  padding: '5px 10px',
                  fontSize: '12px',
                  color: 'var(--text-secondary)',
                  borderBottom: '1px solid var(--border-color)',
                }}
              >
                {hour === 12 ? '12:00 PM' : hour > 12 ? `${hour - 12}:00 PM` : `${hour === 0 ? 12 : hour}:00 AM`}
              </div>
            ))}
          </div>

          {/* Day columns */}
          <div style={{
            marginLeft: '80px',
            display: 'grid',
            gridTemplateColumns: 'repeat(7, 1fr)',
            position: 'relative',
          }}>
            {weekDates.map((date, dayIndex) => (
              <div
                key={dayIndex}
                style={{
                  minHeight: '960px',
                  borderRight: dayIndex < 6 ? '1px solid var(--border-color)' : 'none',
                  position: 'relative',
                }}
              >
                {/* Time slot grid lines with clickable quarters */}
                {timeSlots.map((hour) => {
                  const hourStart = (hour - 8) * 60; // Top position in pixels
                  return (
                    <div key={hour} style={{ position: 'relative', height: '60px' }}>
                      {/* Quarter dividers and clickable areas */}
                      {[0, 1, 2, 3].map((quarter) => (
                        <div
                          key={quarter}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleQuarterClick(date, hour, quarter);
                          }}
                          style={{
                            position: 'absolute',
                            top: `${quarter * 15}px`,
                            left: 0,
                            right: 0,
                            height: '15px',
                            cursor: 'pointer',
                            borderBottom: quarter < 3 ? '1px dashed rgba(128, 128, 128, 0.2)' : '1px solid var(--border-color)',
                            transition: 'background-color 0.1s',
                            zIndex: 1, // Below time entries but clickable
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = 'rgba(139, 92, 246, 0.1)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = 'transparent';
                          }}
                          title={`Click to add time entry starting at ${hour}:${quarter * 15 === 0 ? '00' : quarter * 15}`}
                        />
                      ))}
                    </div>
                  );
                })}

                {/* Time entries */}
                {getTimeEntriesForDate(date).map((entry: TimeEntry) => {
                  const position = getEntryPosition(entry, dayIndex);
                  if (!position) return null; // Entry doesn't belong to this day or time range
                  
                  const color = getProjectColor(entry.projectId);
                  const startTime = entry.startTime ? new Date(entry.startTime) : null;
                  const endTime = entry.endTime ? new Date(entry.endTime) : null;
                  
                  return (
                    <div
                      key={entry.id}
                      style={{
                        position: 'absolute',
                        left: '4px',
                        right: '4px',
                        top: `${position.top}px`,
                        height: `${position.height}px`,
                        backgroundColor: color,
                        borderRadius: '4px',
                        padding: '6px 8px',
                        color: 'white',
                        fontSize: '12px',
                        overflow: 'hidden',
                        cursor: 'pointer',
                        zIndex: 10,
                      }}
                      title={`${entry.description || 'No description'} - ${entry.project?.name || 'No Project'} - ${startTime ? startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''} to ${endTime ? endTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}`}
                    >
                      <div style={{ fontWeight: '600', marginBottom: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {entry.description || 'No description'}
                      </div>
                      <div style={{ fontSize: '11px', opacity: 0.9 }}>
                        {entry.project?.name || 'No Project'}
                        {entry.project?.customer && ` • ${entry.project.customer.name}`}
                      </div>
                      {startTime && endTime && (
                        <div style={{ fontSize: '10px', opacity: 0.8, marginTop: '2px' }}>
                          {startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - {endTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      )}
                      <div style={{ fontSize: '11px', opacity: 0.8, marginTop: '2px' }}>
                        {formatTime(entry.hours)}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Time Entry Modal */}
      {showEntryModal && selectedTimeSlot && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 1000,
          }}
          onClick={() => setShowEntryModal(false)}
        >
          <div
            style={{
              backgroundColor: 'var(--bg-primary)',
              borderRadius: '8px',
              padding: '24px',
              width: '500px',
              maxWidth: '90vw',
              border: '1px solid var(--border-color)',
              boxShadow: '0 4px 6px var(--shadow)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, color: 'var(--text-primary)' }}>Add Time Entry</h3>
              <button
                onClick={() => setShowEntryModal(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '24px',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  padding: 0,
                  width: '30px',
                  height: '30px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                ×
              </button>
            </div>

            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: '20px' }}>
                <input
                  type="text"
                  placeholder="Add a description"
                  value={entryForm.description}
                  onChange={(e) => setEntryForm(prev => ({ ...prev, description: e.target.value }))}
                  required
                  autoFocus
                  style={{
                    width: '100%',
                    padding: '12px',
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    fontSize: '14px',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              {/* Icons row */}
              <div style={{ display: 'flex', gap: '15px', marginBottom: '20px' }}>
                <button
                  type="button"
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: '20px',
                    cursor: 'pointer',
                    color: 'var(--text-secondary)',
                    padding: '8px',
                  }}
                  title="Select project (use dropdown below)"
                >
                  📁
                </button>
                <button
                  type="button"
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: '20px',
                    cursor: 'pointer',
                    color: 'var(--text-secondary)',
                    padding: '8px',
                  }}
                  title="Add tags (coming soon)"
                >
                  🏷️
                </button>
                <button
                  type="button"
                  onClick={() => setEntryForm(prev => ({ ...prev, billable: !prev.billable }))}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: '20px',
                    cursor: 'pointer',
                    color: entryForm.billable ? 'var(--primary-color)' : 'var(--text-secondary)',
                    padding: '8px',
                  }}
                  title={entryForm.billable ? 'Billable' : 'Not billable'}
                >
                  💰
                </button>
              </div>

              {/* Project selector */}
              <div style={{ marginBottom: '20px' }}>
                <select
                  value={entryForm.projectId}
                  onChange={(e) => setEntryForm(prev => ({ ...prev, projectId: e.target.value }))}
                  style={{
                    width: '100%',
                    padding: '10px',
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    fontSize: '14px',
                    color: 'var(--text-primary)',
                  }}
                >
                  <option value="">No project</option>
                  {projects?.map((project: any) => (
                    <option key={project.id} value={project.id}>
                      {project.name} {project.customer && `• ${project.customer.name}`}
                    </option>
                  ))}
                </select>
              </div>

              {/* Time selection */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '15px', marginBottom: '20px' }}>
                <input
                  type="datetime-local"
                  value={entryForm.startTime}
                  onChange={(e) => handleTimeChange('startTime', e.target.value)}
                  required
                  style={{
                    flex: 1,
                    padding: '10px',
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    fontSize: '14px',
                    color: 'var(--text-primary)',
                  }}
                />
                <span style={{ color: 'var(--text-secondary)', fontSize: '18px' }}>→</span>
                <input
                  type="datetime-local"
                  value={entryForm.endTime}
                  onChange={(e) => handleTimeChange('endTime', e.target.value)}
                  required
                  style={{
                    flex: 1,
                    padding: '10px',
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    fontSize: '14px',
                    color: 'var(--text-primary)',
                  }}
                />
                <div style={{
                  padding: '10px 15px',
                  backgroundColor: 'var(--bg-primary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px',
                  fontSize: '14px',
                  fontFamily: 'monospace',
                  color: 'var(--text-primary)',
                  minWidth: '80px',
                  textAlign: 'center',
                }}>
                  {calculateDuration()}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button
                  type="button"
                  onClick={() => setShowEntryModal(false)}
                  style={{
                    padding: '10px 20px',
                    backgroundColor: 'transparent',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    fontSize: '14px',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{
                    padding: '10px 20px',
                    backgroundColor: 'var(--primary-color)',
                    border: 'none',
                    borderRadius: '6px',
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: '14px',
                    fontWeight: '500',
                  }}
                  disabled={createTimeEntryMutation.isPending}
                >
                  {createTimeEntryMutation.isPending ? 'Adding...' : 'Add'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

