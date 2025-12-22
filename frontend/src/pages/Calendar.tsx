import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { projectsService } from '../services/supabaseServices';
import { useAuth } from '../context/AuthContext';

interface TimerState {
  isRunning: boolean;
  startTime: number | null;
  elapsed: number;
  projectId: string | null;
}

export default function Calendar() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [currentDate, setCurrentDate] = useState(new Date());

  const [timer, setTimer] = useState<TimerState>({
    isRunning: false,
    startTime: null,
    elapsed: 0,
    projectId: null,
  });

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => projectsService.getAll(),
  });

  const { data: timeEntries } = useQuery({
    queryKey: ['timeEntries', 'calendar'],
    queryFn: async () => {
      const start = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
      const end = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);
      const response = await axios.get(
        `/api/time-entries?startDate=${start.toISOString()}&endDate=${end.toISOString()}`
      );
      return response.data;
    },
  });


  // Timer logic
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (timer.isRunning && timer.startTime) {
      interval = setInterval(() => {
        const elapsed = Date.now() - timer.startTime!;
        setTimer((prev) => ({ ...prev, elapsed }));
      }, 100);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [timer.isRunning, timer.startTime]);

  const startTimer = (projectId: string) => {
    if (!projectId) return;
    setTimer({
      isRunning: true,
      startTime: Date.now() - timer.elapsed,
      elapsed: timer.elapsed,
      projectId,
    });
  };

  const pauseTimer = () => {
    setTimer((prev) => ({ ...prev, isRunning: false }));
  };

  const resumeTimer = () => {
    if (!timer.projectId) return;
    setTimer((prev) => ({
      ...prev,
      isRunning: true,
      startTime: Date.now() - prev.elapsed,
    }));
  };

  const stopTimer = async () => {
    if (!timer.projectId) return;
    
    const hours = timer.elapsed / (1000 * 60 * 60); // Convert ms to hours
    const today = new Date().toISOString().split('T')[0];
    
    // Navigate to today's detail page with timer data
    navigate(`/calendar/${today}?timer=${timer.elapsed}&projectId=${timer.projectId}`);
    
    setTimer({
      isRunning: false,
      startTime: null,
      elapsed: 0,
      projectId: null,
    });
  };

  const resetTimer = () => {
    setTimer({
      isRunning: false,
      startTime: null,
      elapsed: 0,
      projectId: null,
    });
  };

  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const handleDateClick = (date: Date) => {
    const dateStr = date.toISOString().split('T')[0];
    navigate(`/calendar/${dateStr}`);
  };

  // Calendar generation
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startingDayOfWeek = firstDay.getDay();

  const days = [];
  // Empty cells for days before month starts
  for (let i = 0; i < startingDayOfWeek; i++) {
    days.push(null);
  }
  // Days of the month
  for (let day = 1; day <= daysInMonth; day++) {
    days.push(new Date(year, month, day));
  }

  const getTimeEntriesForDate = (date: Date) => {
    if (!timeEntries) return [];
    const dateStr = date.toISOString().split('T')[0];
    return timeEntries.filter((entry: any) => {
      const entryDate = new Date(entry.date).toISOString().split('T')[0];
      return entryDate === dateStr;
    });
  };

  const navigateMonth = (direction: number) => {
    setCurrentDate(new Date(year, month + direction, 1));
  };

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2>Calendar Time Entry</h2>
      </div>

      {/* Timer Section */}
      <div className="card" style={{ marginBottom: '20px' }}>
        <h3 style={{ marginBottom: '15px' }}>Time Tracker</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '32px', fontFamily: 'monospace', fontWeight: 'bold' }}>
            {formatTime(timer.elapsed)}
          </div>
          
          <div style={{ display: 'flex', gap: '10px', flex: 1 }}>
            {!timer.isRunning && timer.elapsed === 0 && (
              <>
                <select
                  className="input"
                  style={{ width: '200px' }}
                  value={timer.projectId || ''}
                  onChange={(e) => setTimer((prev) => ({ ...prev, projectId: e.target.value }))}
                >
                  <option value="">Select Project</option>
                  {projects?.map((project: any) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
                <button
                  className="button button-primary"
                  onClick={() => timer.projectId && startTimer(timer.projectId)}
                  disabled={!timer.projectId}
                >
                  ▶️ Start
                </button>
              </>
            )}
            
            {timer.isRunning && (
              <button className="button button-secondary" onClick={pauseTimer}>
                ⏸️ Pause
              </button>
            )}
            
            {!timer.isRunning && timer.elapsed > 0 && (
              <>
                <button className="button button-primary" onClick={resumeTimer}>
                  ▶️ Resume
                </button>
                <button className="button button-secondary" onClick={stopTimer}>
                  ⏹️ Stop & Save
                </button>
                <button className="button button-danger" onClick={resetTimer}>
                  🔄 Reset
                </button>
              </>
            )}
          </div>
        </div>
        {timer.projectId && (
          <div style={{ marginTop: '10px', color: 'var(--text-secondary)' }}>
            Project: {projects?.find((p: any) => p.id === timer.projectId)?.name || 'Unknown'}
          </div>
        )}
      </div>

      {/* Calendar */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <button className="button button-secondary" onClick={() => navigateMonth(-1)}>
            ← Previous
          </button>
          <h3>{monthNames[month]} {year}</h3>
          <button className="button button-secondary" onClick={() => navigateMonth(1)}>
            Next →
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '8px' }}>
          {weekDays.map((day) => (
            <div key={day} style={{ textAlign: 'center', fontWeight: 'bold', padding: '10px', color: 'var(--text-secondary)' }}>
              {day}
            </div>
          ))}
          
          {days.map((date, index) => {
            if (!date) {
              return <div key={`empty-${index}`}></div>;
            }
            
            const entries = getTimeEntriesForDate(date);
            const totalHours = entries.reduce((sum: number, entry: any) => sum + entry.hours, 0);
            const isToday = date.toDateString() === new Date().toDateString();
            
            return (
              <div
                key={date.toDateString()}
                onClick={() => handleDateClick(date)}
                style={{
                  minHeight: '100px',
                  padding: '8px',
                  border: `2px solid ${isToday ? '#28a745' : 'var(--border-color)'}`,
                  borderRadius: '4px',
                  cursor: 'pointer',
                  backgroundColor: 'var(--bg-primary)',
                  transition: 'background-color 0.2s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--bg-primary)';
                }}
              >
                <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>
                  {date.getDate()}
                </div>
                {entries.length > 0 && (
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    <div>{totalHours.toFixed(1)}h</div>
                    <div>{entries.length} {entries.length === 1 ? 'entry' : 'entries'}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

    </div>
  );
}

