import { useQuery } from '@tanstack/react-query';
import { timeEntriesService } from '../services/supabaseServices';
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
  user?: {
    id: string;
    firstName: string;
    lastName: string;
  };
}

export default function Dashboard() {
  const { user } = useAuth();
  
  // Get this week's date range
  const getWeekDates = () => {
    const today = new Date();
    const day = today.getDay();
    const diff = today.getDate() - day + (day === 0 ? -6 : 1); // Adjust to Monday
    const monday = new Date(today.setDate(diff));
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(monday);
      date.setDate(monday.getDate() + i);
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

  const { data: employees } = useQuery({
    queryKey: ['employees'],
    queryFn: async () => {
      if (user?.role !== 'ADMIN') return [];
      const response = await axios.get('/api/employees');
      return response.data || [];
    },
    enabled: user?.role === 'ADMIN',
  });

  // Calculate daily totals for this week
  const getDailyTotals = () => {
    if (!timeEntries) return [];
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return weekDates.map((date, index) => {
      const dateStr = date.toISOString().split('T')[0];
      const entries = timeEntries.filter((entry: TimeEntry) => {
        const entryDate = new Date(entry.date).toISOString().split('T')[0];
        return entryDate === dateStr;
      });
      const total = entries.reduce((sum: number, entry: TimeEntry) => sum + entry.hours, 0);
      const billable = entries.filter((e: TimeEntry) => e.billable).reduce((sum: number, entry: TimeEntry) => sum + entry.hours, 0);
      return {
        day: dayNames[index],
        date: date.getDate(),
        month: date.getMonth() + 1,
        total,
        billable,
        nonBillable: total - billable,
      };
    });
  };

  const dailyTotals = getDailyTotals();
  const maxHours = Math.max(...dailyTotals.map(d => d.total), 1);

  // Get top projects
  const getTopProjects = () => {
    if (!timeEntries || !projects) return [];
    const projectHours: { [key: string]: number } = {};
    
    timeEntries.forEach((entry: TimeEntry) => {
      const projectId = entry.projectId || 'none';
      if (!projectHours[projectId]) {
        projectHours[projectId] = 0;
      }
      projectHours[projectId] += entry.hours;
    });

    return Object.entries(projectHours)
      .map(([projectId, hours]) => {
        const project = projects.find((p: any) => p.id === projectId);
        return {
          id: projectId,
          name: project?.name || 'No Project',
          hours,
        };
      })
      .sort((a, b) => b.hours - a.hours)
      .slice(0, 5);
  };

  const topProjects = getTopProjects();

  // Get team activity
  const getTeamActivity = () => {
    if (!timeEntries || !employees) return { tracking: 0, total: 0, members: [] };
    
    const memberHours: { [key: string]: { hours: number; name: string } } = {};
    
    employees.forEach((emp: any) => {
      memberHours[emp.userId] = {
        hours: 0,
        name: `${emp.user?.firstName || ''} ${emp.user?.lastName || ''}`.trim() || 'Unknown',
      };
    });

    timeEntries.forEach((entry: TimeEntry) => {
      const userId = entry.user?.id || '';
      if (memberHours[userId]) {
        memberHours[userId].hours += entry.hours;
      }
    });

    const members = Object.values(memberHours);
    const tracking = members.filter(m => m.hours > 0).length;
    
    return {
      tracking,
      total: members.length,
      members: members.sort((a, b) => b.hours - a.hours),
    };
  };

  const teamActivity = getTeamActivity();
  const trackingPercentage = teamActivity.total > 0 ? Math.round((teamActivity.tracking / teamActivity.total) * 100) : 0;

  const formatTime = (hours: number) => {
    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);
    const s = Math.floor(((hours - h) * 60 - m) * 60);
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const formatDate = (month: number, date: number) => {
    return `${month}/${date}`;
  };

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: '30px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
          <div>
            <h1 style={{ fontSize: '32px', fontWeight: 'bold', color: 'var(--text-primary)', margin: 0, marginBottom: '4px' }}>
              {user?.role === 'ADMIN' ? 'Admin Overview' : 'Overview'}
            </h1>
            <p style={{ fontSize: '16px', color: 'var(--text-secondary)', margin: 0 }}>
              {user?.role === 'ADMIN' ? 'Set up your organization and keep your team on track' : 'Track your time and manage your projects'}
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            {user?.role === 'ADMIN' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>Set as default view</span>
                  <label style={{ position: 'relative', display: 'inline-block', width: '44px', height: '24px' }}>
                    <input type="checkbox" style={{ opacity: 0, width: 0, height: 0 }} />
                    <span style={{
                      position: 'absolute',
                      cursor: 'pointer',
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      backgroundColor: '#ccc',
                      transition: '0.3s',
                      borderRadius: '24px',
                    }}>
                      <span style={{
                        position: 'absolute',
                        content: '""',
                        height: '18px',
                        width: '18px',
                        left: '3px',
                        bottom: '3px',
                        backgroundColor: 'white',
                        transition: '0.3s',
                        borderRadius: '50%',
                      }}></span>
                    </span>
                  </label>
                </div>
                <button style={{
                  padding: '8px 16px',
                  backgroundColor: 'var(--bg-primary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  fontSize: '14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}>
                  REFRESH CHARTS ⟳
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Grid Layout */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 1fr)',
        gap: '20px',
        marginBottom: '20px',
      }}>
        {/* This week summary */}
        <div style={{
          backgroundColor: 'var(--bg-primary)',
          borderRadius: '12px',
          padding: '24px',
          border: '1px solid var(--border-color)',
          boxShadow: 'var(--shadow-sm)',
          transition: 'box-shadow 0.2s ease',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '600', color: 'var(--text-primary)' }}>
              This week
            </h3>
            <a href="/reports" style={{ 
              fontSize: '13px', 
              color: 'var(--primary-color)', 
              textDecoration: 'none',
              fontWeight: '600',
              letterSpacing: '0.5px',
              transition: 'color 0.2s ease',
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = 'var(--primary-hover)'}
            onMouseLeave={(e) => e.currentTarget.style.color = 'var(--primary-color)'}
            >
              VIEW REPORTS →
            </a>
          </div>
          
          {/* Bar Chart */}
          <div style={{ height: '200px', position: 'relative', marginBottom: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'flex-end', height: '100%', paddingBottom: '30px' }}>
              {dailyTotals.map((day, index) => {
                const height = maxHours > 0 ? (day.total / maxHours) * 100 : 0;
                return (
                  <div key={index} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '0 4px' }}>
                    <div style={{
                      width: '100%',
                      backgroundColor: 'var(--primary-color)',
                      height: `${height}%`,
                      borderRadius: '6px 6px 0 0',
                      minHeight: day.total > 0 ? '4px' : '0',
                      transition: 'background-color 0.2s ease',
                    }}></div>
                    <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-secondary)', textAlign: 'center' }}>
                      <div>{day.day}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{day.date}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Y-axis labels */}
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: '30px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-tertiary)' }}>
              {[0, 3.5, 7, 10.5, 14, 17.5].map((val) => (
                <span key={val}>{val}h</span>
              ))}
            </div>
          </div>
          
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '12px', height: '12px', backgroundColor: 'var(--primary-color)', borderRadius: '3px' }}></div>
              <span>Total hours</span>
            </div>
          </div>
        </div>


        {/* Team activity */}
        {user?.role === 'ADMIN' && (
          <div style={{
            backgroundColor: 'var(--bg-primary)',
            borderRadius: '8px',
            padding: '20px',
            border: '1px solid var(--border-color)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '600', color: 'var(--text-primary)' }}>
                Team activity
              </h3>
              <a href="/reports" style={{ fontSize: '14px', color: 'var(--primary-color)', textDecoration: 'none' }}>
                VIEW TEAM ACTIVITY
              </a>
            </div>
            
            {/* Donut Chart */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '30px', marginBottom: '20px' }}>
              <div style={{ position: 'relative', width: '120px', height: '120px' }}>
                <svg width="120" height="120" style={{ transform: 'rotate(-90deg)' }}>
                  <circle
                    cx="60"
                    cy="60"
                    r="50"
                    fill="none"
                    stroke="var(--bg-secondary)"
                    strokeWidth="12"
                  />
                  <circle
                    cx="60"
                    cy="60"
                    r="50"
                    fill="none"
                    stroke="var(--primary-color)"
                    strokeWidth="12"
                    strokeDasharray={`${(trackingPercentage / 100) * 314} 314`}
                    strokeLinecap="round"
                  />
                </svg>
                <div style={{
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  transform: 'translate(-50%, -50%)',
                  textAlign: 'center',
                }}>
                  <div style={{ fontSize: '24px', fontWeight: 'bold', color: 'var(--text-primary)' }}>
                    {trackingPercentage}%
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    {teamActivity.tracking} out of {teamActivity.total} members tracking
                  </div>
                </div>
              </div>
              
              <div style={{ flex: 1 }}>
                <div style={{ marginBottom: '16px' }}>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '8px', textTransform: 'uppercase' }}>
                    TRACKING
                  </div>
                  {teamActivity.members.filter(m => m.hours > 0).map((member, index) => (
                    <div key={index} style={{ fontSize: '14px', color: 'var(--text-primary)', marginBottom: '4px' }}>
                      {member.name}: {formatTime(member.hours)}
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '8px', textTransform: 'uppercase' }}>
                    NOT TRACKING
                  </div>
                  {teamActivity.members.filter(m => m.hours === 0).map((member, index) => (
                    <div key={index} style={{ fontSize: '14px', color: 'var(--text-primary)', marginBottom: '4px' }}>
                      {member.name}: {formatTime(0)}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Top projects */}
        <div style={{
          backgroundColor: 'var(--bg-primary)',
          borderRadius: '12px',
          padding: '24px',
          border: '1px solid var(--border-color)',
          boxShadow: 'var(--shadow-sm)',
          transition: 'box-shadow 0.2s ease',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '600', color: 'var(--text-primary)' }}>
              Top projects this week
            </h3>
            <a href="/reports" style={{ 
              fontSize: '13px', 
              color: 'var(--primary-color)', 
              textDecoration: 'none',
              fontWeight: '600',
              letterSpacing: '0.5px',
              transition: 'color 0.2s ease',
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = 'var(--primary-hover)'}
            onMouseLeave={(e) => e.currentTarget.style.color = 'var(--primary-color)'}
            >
              VIEW REPORTS →
            </a>
          </div>
          <div>
            {topProjects.map((project, index) => {
              const colors = ['#10b981', '#3b82f6', '#dc2626', '#f59e0b', '#ef4444'];
              const color = colors[index % colors.length];
              return (
                <div key={project.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                  <div style={{ width: '8px', height: '8px', backgroundColor: color, borderRadius: '50%', flexShrink: 0 }}></div>
                  <div style={{ flex: 1, fontSize: '14px', color: 'var(--text-primary)' }}>
                    {project.name}
                  </div>
                  <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                    {formatTime(project.hours)}
                  </div>
                </div>
              );
            })}
            {topProjects.length === 0 && (
              <div style={{ fontSize: '14px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                No time tracked to projects this week
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Row - Time tracked to projects */}
      {user?.role === 'ADMIN' && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr',
          gap: '20px',
          marginBottom: '20px',
          maxWidth: '50%',
        }}>
          <div style={{
            backgroundColor: 'var(--bg-primary)',
            borderRadius: '8px',
            padding: '20px',
            border: '1px solid var(--border-color)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '600', color: 'var(--text-primary)' }}>
                Time tracked to projects
              </h3>
              <a href="/reports" style={{ fontSize: '14px', color: 'var(--primary-color)', textDecoration: 'none' }}>
                VIEW REPORTS
              </a>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', marginBottom: '20px' }}>
              <div style={{ position: 'relative', width: '150px', height: '150px' }}>
                <svg width="150" height="150" style={{ transform: 'rotate(-90deg)' }}>
                  <circle
                    cx="75"
                    cy="75"
                    r="65"
                    fill="none"
                    stroke="var(--bg-secondary)"
                    strokeWidth="14"
                  />
                  <circle
                    cx="75"
                    cy="75"
                    r="65"
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth="14"
                    strokeDasharray="400 400"
                    strokeLinecap="round"
                  />
                </svg>
                <div style={{
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  transform: 'translate(-50%, -50%)',
                  textAlign: 'center',
                  fontSize: '32px',
                  fontWeight: 'bold',
                  color: 'var(--text-primary)',
                }}>
                  98%
                </div>
              </div>
            </div>
            <a href="/projects" style={{ fontSize: '14px', color: 'var(--primary-color)', textDecoration: 'none', display: 'block', textAlign: 'center' }}>
              SET UP REQUIRED FIELDS
            </a>
          </div>
        </div>
      )}

      {/* Footer */}
    </div>
  );
}
