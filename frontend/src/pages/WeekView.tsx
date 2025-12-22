import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { timeEntriesService } from '../services/supabaseServices';

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

export default function WeekView() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [currentDate, setCurrentDate] = useState(new Date());
  
  // Get week start (Monday)
  const getWeekStart = (date: Date) => {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff));
  };

  const weekStart = getWeekStart(currentDate);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);

  const { data: timeEntries } = useQuery({
    queryKey: ['timeEntries', 'week', weekStart.toISOString()],
    queryFn: async () => {
      // In a real app, use a date range query
      const allEntries = await timeEntriesService.getAll();
      return allEntries?.filter((entry: any) => {
        const entryDate = new Date(entry.date);
        return entryDate >= weekStart && entryDate <= weekEnd;
      });
    },
  });

  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  
  // Generate days with dates
  const weekDays = days.map((day, index) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + index);
    return {
      name: day,
      date: d,
      displayDate: d.getDate(),
    };
  });

  // Calculate totals
  const getDayTotal = (date: Date) => {
    if (!timeEntries) return 0;
    const dateStr = date.toISOString().split('T')[0];
    return timeEntries
      .filter((e: any) => e.date === dateStr)
      .reduce((sum: number, e: any) => sum + Number(e.hours), 0);
  };

  const getWeekTotal = () => {
    if (!timeEntries) return 0;
    return timeEntries.reduce((sum: number, e: any) => sum + Number(e.hours), 0);
  };

  const navigateWeek = (direction: 'prev' | 'next') => {
    const newDate = new Date(currentDate);
    newDate.setDate(currentDate.getDate() + (direction === 'next' ? 7 : -7));
    setCurrentDate(newDate);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <button className="button" onClick={() => navigateWeek('prev')}>←</button>
          <h2>
            {weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - {weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </h2>
          <button className="button" onClick={() => navigateWeek('next')}>→</button>
        </div>
        <div className="card" style={{ padding: '10px 20px', backgroundColor: 'var(--primary-light)' }}>
          <strong>Total: {getWeekTotal().toFixed(2)} hrs</strong>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '10px' }}>
        {weekDays.map((day) => {
          const isToday = new Date().toDateString() === day.date.toDateString();
          const dayTotal = getDayTotal(day.date);
          const dateStr = day.date.toISOString().split('T')[0];
          
          return (
            <div key={day.name} className="card" style={{ 
              padding: '0', 
              overflow: 'hidden',
              border: isToday ? '2px solid var(--primary-color)' : '1px solid var(--border-color)'
            }}>
              <div style={{ 
                padding: '10px', 
                backgroundColor: 'var(--bg-secondary)', 
                borderBottom: '1px solid var(--border-color)',
                textAlign: 'center'
              }}>
                <div style={{ fontWeight: 'bold', marginBottom: '5px' }}>{day.name}</div>
                <div style={{ fontSize: '20px' }}>{day.displayDate}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '5px' }}>
                  {dayTotal.toFixed(2)} hrs
                </div>
              </div>
              
              <div style={{ padding: '10px', minHeight: '200px' }}>
                {timeEntries
                  ?.filter((e: any) => e.date === dateStr)
                  .map((entry: any) => (
                    <div 
                      key={entry.id}
                      style={{
                        padding: '8px',
                        marginBottom: '8px',
                        backgroundColor: 'var(--primary-light)',
                        borderRadius: '4px',
                        fontSize: '12px',
                        borderLeft: '3px solid var(--primary-color)'
                      }}
                    >
                      <div style={{ fontWeight: '600' }}>{entry.project?.name || 'No Project'}</div>
                      <div>{Number(entry.hours).toFixed(2)} hrs</div>
                      {entry.description && (
                        <div style={{ color: 'var(--text-secondary)', marginTop: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {entry.description}
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
