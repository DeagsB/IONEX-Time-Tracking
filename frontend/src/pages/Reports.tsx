import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';

interface TimeEntry {
  id: string;
  userId: string;
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
    email: string;
  };
}

export default function Reports() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('Summary');
  const [currentWeek, setCurrentWeek] = useState(() => {
    const today = new Date();
    const day = today.getDay();
    const diff = today.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(today.setDate(diff));
    return monday;
  });
  const [breakdownBy1, setBreakdownBy1] = useState('Members');
  const [breakdownBy2, setBreakdownBy2] = useState('Descriptions');

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
    queryKey: ['timeEntries', 'reports', weekStart.toISOString()],
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

  // Calculate metrics
  const getMetrics = () => {
    if (!timeEntries) return { totalHours: 0, billableHours: 0, amount: 0, avgDailyHours: 0 };
    
    const totalHours = timeEntries.reduce((sum: number, entry: TimeEntry) => sum + entry.hours, 0);
    const billableEntries = timeEntries.filter((e: TimeEntry) => e.billable);
    const billableHours = billableEntries.reduce((sum: number, entry: TimeEntry) => sum + entry.hours, 0);
    const amount = billableEntries.reduce((sum: number, entry: TimeEntry) => sum + (entry.hours * entry.rate), 0);
    const avgDailyHours = totalHours / 7;

    return { totalHours, billableHours, amount, avgDailyHours };
  };

  const metrics = getMetrics();

  // Daily totals
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
      return {
        day: dayNames[index],
        date: date.getDate(),
        month: date.getMonth() + 1,
        total,
      };
    });
  };

  const dailyTotals = getDailyTotals();
  const maxHours = Math.max(...dailyTotals.map(d => d.total), 1);

  // Member distribution
  const getMemberDistribution = () => {
    if (!timeEntries) return [];
    const memberHours: { [key: string]: { name: string; hours: number } } = {};
    
    timeEntries.forEach((entry: TimeEntry) => {
      const userId = entry.user?.id || entry.userId;
      const userName = entry.user ? `${entry.user.firstName} ${entry.user.lastName}` : 'Unknown';
      if (!memberHours[userId]) {
        memberHours[userId] = { name: userName, hours: 0 };
      }
      memberHours[userId].hours += entry.hours;
    });

    const total = Object.values(memberHours).reduce((sum, m) => sum + m.hours, 0);
    return Object.values(memberHours)
      .map(member => ({
        ...member,
        percentage: total > 0 ? (member.hours / total) * 100 : 0,
      }))
      .sort((a, b) => b.hours - a.hours);
  };

  const memberDistribution = getMemberDistribution();
  const totalHoursForDistribution = memberDistribution.reduce((sum, m) => sum + m.hours, 0);

  // Breakdown table data
  const getBreakdownData = () => {
    if (!timeEntries) return [];
    
    if (breakdownBy1 === 'Members' && breakdownBy2 === 'Descriptions') {
      const breakdown: { [key: string]: { [desc: string]: number } } = {};
      const memberDescCounts: { [key: string]: number } = {};
      
      timeEntries.forEach((entry: TimeEntry) => {
        const userName = entry.user ? `${entry.user.firstName} ${entry.user.lastName}` : 'Unknown';
        const desc = entry.description || 'No description';
        if (!breakdown[userName]) {
          breakdown[userName] = {};
          memberDescCounts[userName] = 0;
        }
        if (!breakdown[userName][desc]) {
          breakdown[userName][desc] = 0;
          memberDescCounts[userName]++;
        }
        breakdown[userName][desc] += entry.hours;
      });

      const result: Array<{ label: string; count: number; hours: number; percentage: number }> = [];
      const total = metrics.totalHours;

      Object.entries(breakdown).forEach(([member, descs]) => {
        const memberTotal = Object.values(descs).reduce((sum, h) => sum + h, 0);
        result.push({
          label: `${member} (${Object.keys(descs).length})`,
          count: Object.keys(descs).length,
          hours: memberTotal,
          percentage: total > 0 ? (memberTotal / total) * 100 : 0,
        });
      });

      return result.sort((a, b) => b.hours - a.hours);
    }
    
    // Default fallback
    return [];
  };

  const breakdownData = getBreakdownData();

  const formatTime = (hours: number) => {
    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);
    const s = Math.floor(((hours - h) * 60 - m) * 60);
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const getWeekNumber = (date: Date) => {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  };

  const weekNumber = getWeekNumber(weekStart);

  const navigateWeek = (direction: number) => {
    const newDate = new Date(currentWeek);
    newDate.setDate(currentWeek.getDate() + (direction * 7));
    setCurrentWeek(newDate);
  };

  const colors = ['#dc2626', '#ef4444', '#f59e0b', '#3b82f6', '#10b981'];

  return (
    <div>
      {/* Top Navigation Tabs */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottom: '1px solid var(--border-color)',
        marginBottom: '24px',
        paddingBottom: '0',
      }}>
        <div style={{ display: 'flex', gap: '32px', alignItems: 'center' }}>
          <h1 style={{ fontSize: '24px', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>Reports</h1>
          {['Summary', 'Detailed', 'Profitability', 'My reports'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '14px',
                color: activeTab === tab ? 'var(--primary-color)' : 'var(--text-secondary)',
                cursor: 'pointer',
                padding: '12px 0',
                borderBottom: activeTab === tab ? '2px solid var(--primary-color)' : '2px solid transparent',
                fontWeight: activeTab === tab ? '600' : '400',
                transition: 'all 0.2s ease',
                marginBottom: '-1px',
              }}
              onMouseEnter={(e) => {
                if (activeTab !== tab) {
                  e.currentTarget.style.color = 'var(--text-primary)';
                }
              }}
              onMouseLeave={(e) => {
                if (activeTab !== tab) {
                  e.currentTarget.style.color = 'var(--text-secondary)';
                }
              }}
            >
              {tab}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <select style={{
            padding: '8px 12px',
            backgroundColor: 'var(--bg-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            color: 'var(--text-primary)',
            fontSize: '14px',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}>
            <option>Rounding off</option>
          </select>
          <button style={{
            padding: '8px 16px',
            backgroundColor: 'var(--bg-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            color: 'var(--text-primary)',
            fontSize: '14px',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            fontWeight: '500',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
            e.currentTarget.style.borderColor = 'var(--border-color-hover)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--bg-primary)';
            e.currentTarget.style.borderColor = 'var(--border-color)';
          }}
          >
            Create invoice
          </button>
          <button style={{
            padding: '8px 16px',
            backgroundColor: 'var(--bg-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            color: 'var(--text-primary)',
            fontSize: '14px',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            fontWeight: '500',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
            e.currentTarget.style.borderColor = 'var(--border-color-hover)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--bg-primary)';
            e.currentTarget.style.borderColor = 'var(--border-color)';
          }}
          >
            Export
          </button>
          <button style={{
            padding: '8px 12px',
            backgroundColor: 'var(--bg-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            color: 'var(--text-primary)',
            fontSize: '14px',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            fontWeight: '500',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
            e.currentTarget.style.borderColor = 'var(--border-color-hover)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--bg-primary)';
            e.currentTarget.style.borderColor = 'var(--border-color)';
          }}
          >
            Settings
          </button>
          <button style={{
            padding: '8px 16px',
            backgroundColor: 'var(--bg-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            color: 'var(--text-primary)',
            fontSize: '14px',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            fontWeight: '500',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
            e.currentTarget.style.borderColor = 'var(--border-color-hover)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--bg-primary)';
            e.currentTarget.style.borderColor = 'var(--border-color)';
          }}
          >
            Save and share
          </button>
        </div>
      </div>

      {/* Filters Bar */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '30px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <button onClick={() => navigateWeek(-1)} style={{
            background: 'none',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            padding: '8px 12px',
            cursor: 'pointer',
            color: 'var(--text-primary)',
            transition: 'all 0.2s ease',
            fontSize: '16px',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
            e.currentTarget.style.borderColor = 'var(--border-color-hover)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.style.borderColor = 'var(--border-color)';
          }}
          >←</button>
          <button onClick={() => navigateWeek(1)} style={{
            background: 'none',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            padding: '8px 12px',
            cursor: 'pointer',
            color: 'var(--text-primary)',
            transition: 'all 0.2s ease',
            fontSize: '16px',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
            e.currentTarget.style.borderColor = 'var(--border-color-hover)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.style.borderColor = 'var(--border-color)';
          }}
          >→</button>
          <span style={{ fontSize: '16px', color: 'var(--text-primary)' }}>
            This week W{weekNumber}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {['Member', 'Client', 'Project', 'Tag', 'Description'].map((filter) => (
            <button key={filter} style={{
              padding: '8px 14px',
              backgroundColor: 'var(--bg-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              color: 'var(--text-primary)',
              fontSize: '14px',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              fontWeight: '500',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
              e.currentTarget.style.borderColor = 'var(--border-color-hover)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--bg-primary)';
              e.currentTarget.style.borderColor = 'var(--border-color)';
            }}
            >
              {filter}
            </button>
          ))}
          <button style={{
            padding: '8px 14px',
            backgroundColor: 'var(--bg-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            color: 'var(--text-primary)',
            fontSize: '14px',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            fontWeight: '500',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
            e.currentTarget.style.borderColor = 'var(--border-color-hover)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--bg-primary)';
            e.currentTarget.style.borderColor = 'var(--border-color)';
          }}
          >
            + Add filter
          </button>
        </div>
      </div>

      {/* Key Metrics */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '20px',
        marginBottom: '30px',
      }}>
        <div style={{
          backgroundColor: 'var(--bg-primary)',
          borderRadius: '12px',
          padding: '24px',
          border: '1px solid var(--border-color)',
          boxShadow: 'var(--shadow-sm)',
        }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
            Total Hours
          </div>
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: 'var(--text-primary)' }}>
            {formatTime(metrics.totalHours)}
          </div>
        </div>
        <div style={{
          backgroundColor: 'var(--bg-primary)',
          borderRadius: '12px',
          padding: '24px',
          border: '1px solid var(--border-color)',
          boxShadow: 'var(--shadow-sm)',
        }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
            Billable Hours
          </div>
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: 'var(--text-primary)' }}>
            {metrics.billableHours > 0 ? formatTime(metrics.billableHours) : '-'}
          </div>
        </div>
        <div style={{
          backgroundColor: 'var(--bg-primary)',
          borderRadius: '12px',
          padding: '24px',
          border: '1px solid var(--border-color)',
          boxShadow: 'var(--shadow-sm)',
        }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
            Amount
          </div>
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: 'var(--text-primary)' }}>
            {metrics.amount > 0 ? `$${metrics.amount.toFixed(2)}` : '-'}
          </div>
        </div>
        <div style={{
          backgroundColor: 'var(--bg-primary)',
          borderRadius: '12px',
          padding: '24px',
          border: '1px solid var(--border-color)',
          boxShadow: 'var(--shadow-sm)',
        }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
            Average Daily Hours
          </div>
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: 'var(--text-primary)' }}>
            {metrics.avgDailyHours.toFixed(2)} Hours
          </div>
        </div>
      </div>

      {activeTab === 'Summary' ? (
        <>
          {/* Charts Grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr',
            gap: '20px',
            marginBottom: '30px',
          }}>
            {/* Duration by day */}
            <div style={{
              backgroundColor: 'var(--bg-primary)',
              borderRadius: '8px',
              padding: '20px',
              border: '1px solid var(--border-color)',
            }}>
              <h3 style={{ margin: '0 0 20px 0', fontSize: '16px', fontWeight: '600', color: 'var(--text-primary)' }}>
                Duration by day
              </h3>
              <div style={{ height: '250px', position: 'relative', paddingLeft: '40px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'flex-end', height: '100%', paddingBottom: '30px' }}>
                  {dailyTotals.map((day, index) => {
                    const height = maxHours > 0 ? (day.total / maxHours) * 100 : 0;
                    return (
                      <div key={index} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '0 4px', position: 'relative' }}>
                        <div style={{
                          width: '100%',
                          backgroundColor: 'var(--primary-color)',
                          height: `${height}%`,
                          borderRadius: '4px 4px 0 0',
                          minHeight: day.total > 0 ? '4px' : '0',
                        }} title={`${day.month}/${day.date} - ${formatTime(day.total)}`}></div>
                        <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-secondary)', textAlign: 'center' }}>
                          <div>{day.day}</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{day.month}/{day.date}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ position: 'absolute', left: 0, top: 0, bottom: '30px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-tertiary)' }}>
                  {[0, 3.5, 7, 10.5, 14, 17.5].map((val) => (
                    <span key={val}>{val}h</span>
                  ))}
                </div>
                <div style={{ marginTop: '10px', fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ width: '20px', height: '3px', backgroundColor: 'var(--primary-color)' }}></div>
                  <span>Duration (m)</span>
                </div>
              </div>
            </div>

            {/* Member distribution */}
            <div style={{
              backgroundColor: 'var(--bg-primary)',
              borderRadius: '8px',
              padding: '20px',
              border: '1px solid var(--border-color)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600', color: 'var(--text-primary)' }}>
                  Member distribution
                </h3>
                <select style={{
                  padding: '4px 8px',
                  backgroundColor: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '4px',
                  color: 'var(--text-primary)',
                  fontSize: '12px',
                }}>
                  <option>Slice by: Members</option>
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '30px' }}>
                <div style={{ position: 'relative', width: '150px', height: '150px', flexShrink: 0 }}>
                  <svg width="150" height="150" style={{ transform: 'rotate(-90deg)' }}>
                    <circle
                      cx="75"
                      cy="75"
                      r="60"
                      fill="none"
                      stroke="var(--bg-secondary)"
                      strokeWidth="20"
                    />
                    {memberDistribution.map((member, index) => {
                      const circumference = 2 * Math.PI * 60;
                      let offset = 0;
                      for (let i = 0; i < index; i++) {
                        offset += (memberDistribution[i].percentage / 100) * circumference;
                      }
                      const strokeDasharray = `${(member.percentage / 100) * circumference} ${circumference}`;
                      return (
                        <circle
                          key={member.name}
                          cx="75"
                          cy="75"
                          r="60"
                          fill="none"
                          stroke={colors[index % colors.length]}
                          strokeWidth="20"
                          strokeDasharray={strokeDasharray}
                          strokeDashoffset={-offset}
                          strokeLinecap="round"
                        />
                      );
                    })}
                  </svg>
                  <div style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    textAlign: 'center',
                  }}>
                    <div style={{ fontSize: '20px', fontWeight: 'bold', color: 'var(--text-primary)' }}>
                      {formatTime(totalHoursForDistribution)}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                      MEMBER
                    </div>
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  {memberDistribution.map((member, index) => (
                    <div key={member.name} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                      <div style={{ width: '12px', height: '12px', backgroundColor: colors[index % colors.length], borderRadius: '50%' }}></div>
                      <div style={{ flex: 1, fontSize: '14px', color: 'var(--text-primary)' }}>
                        {member.name}
                      </div>
                      <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                        {member.percentage.toFixed(2)}%
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Breakdown Table */}
          <div style={{
            backgroundColor: 'var(--bg-primary)',
            borderRadius: '8px',
            padding: '20px',
            border: '1px solid var(--border-color)',
            position: 'relative',
          }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600', color: 'var(--text-primary)' }}>
              {breakdownBy1} and {breakdownBy2} breakdown
            </h3>
            <div style={{ display: 'flex', gap: '10px' }}>
              <select
                value={breakdownBy1}
                onChange={(e) => setBreakdownBy1(e.target.value)}
                style={{
                  padding: '6px 12px',
                  backgroundColor: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                }}
              >
                <option>Members</option>
                <option>Projects</option>
                <option>Clients</option>
              </select>
              <span style={{ color: 'var(--text-secondary)', lineHeight: '36px' }}>and</span>
              <select
                value={breakdownBy2}
                onChange={(e) => setBreakdownBy2(e.target.value)}
                style={{
                  padding: '6px 12px',
                  backgroundColor: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                }}
              >
                <option>Descriptions</option>
                <option>Projects</option>
                <option>Clients</option>
              </select>
            </div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                <th style={{ padding: '12px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  {breakdownBy1} | {breakdownBy2}
                </th>
                <th style={{ padding: '12px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  DURATION
                </th>
                <th style={{ padding: '12px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  DURATION %
                </th>
              </tr>
            </thead>
            <tbody>
              {breakdownData.map((row, index) => (
                <tr key={index} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '12px', fontSize: '14px', color: 'var(--text-primary)' }}>
                    {row.label}
                  </td>
                  <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', color: 'var(--text-primary)' }}>
                    {formatTime(row.hours)}
                  </td>
                  <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', color: 'var(--text-primary)' }}>
                    {row.percentage.toFixed(2)}%
                  </td>
                </tr>
              ))}
              <tr style={{ borderTop: '2px solid var(--border-color)', fontWeight: '600' }}>
                <td style={{ padding: '12px', fontSize: '14px', color: 'var(--text-primary)' }}>
                  TOTAL
                </td>
                <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', color: 'var(--text-primary)' }}>
                  {formatTime(metrics.totalHours)}
                </td>
                <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', color: 'var(--text-primary)' }}>
                  100%
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        </>
      ) : activeTab === 'Detailed' ? (
        /* Detailed Table View */
        <div style={{ position: 'relative' }}>
          <div style={{
            backgroundColor: 'var(--bg-primary)',
            borderRadius: '8px',
            padding: '20px',
            border: '1px solid var(--border-color)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600', color: 'var(--text-primary)' }}>
                Time entries from this week
              </h3>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
                    <th style={{ padding: '12px', width: '40px' }}>
                      <input type="checkbox" style={{ cursor: 'pointer' }} />
                    </th>
                    <th style={{ padding: '12px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', cursor: 'pointer' }}>
                      DESCRIPTION <span style={{ marginLeft: '4px' }}>▼</span>
                    </th>
                    <th style={{ padding: '12px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', cursor: 'pointer' }}>
                      DURATION <span style={{ marginLeft: '4px' }}>▼</span>
                    </th>
                    <th style={{ padding: '12px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', cursor: 'pointer' }}>
                      MEMBER <span style={{ marginLeft: '4px' }}>▼</span>
                    </th>
                    <th style={{ padding: '12px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', cursor: 'pointer' }}>
                      PROJECT <span style={{ marginLeft: '4px' }}>▼</span>
                    </th>
                    <th style={{ padding: '12px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', cursor: 'pointer' }}>
                      TAGS <span style={{ marginLeft: '4px' }}>▼</span>
                    </th>
                    <th style={{ padding: '12px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', cursor: 'pointer' }}>
                      TIME | DATE <span style={{ marginLeft: '4px' }}>▼</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {timeEntries && timeEntries.length > 0 ? (
                    [...timeEntries].sort((a: TimeEntry, b: TimeEntry) => {
                      const dateA = new Date(a.date).getTime();
                      const dateB = new Date(b.date).getTime();
                      if (dateA !== dateB) return dateB - dateA;
                      const timeA = a.startTime ? new Date(a.startTime).getTime() : 0;
                      const timeB = b.startTime ? new Date(b.startTime).getTime() : 0;
                      return timeB - timeA;
                    }).map((entry: TimeEntry) => {
                      const startTime = entry.startTime ? new Date(entry.startTime) : null;
                      const endTime = entry.endTime ? new Date(entry.endTime) : null;
                      const entryDate = new Date(entry.date);
                      const userName = entry.user ? `${entry.user.firstName} ${entry.user.lastName}` : 'Unknown';
                      const projectName = entry.project?.name || '';
                      const projectColor = entry.projectId ? colors[projects?.findIndex((p: any) => p.id === entry.projectId) % colors.length] : '#6c757d';

                      return (
                        <tr key={entry.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                          <td style={{ padding: '12px' }}>
                            <input type="checkbox" style={{ cursor: 'pointer' }} />
                          </td>
                          <td style={{ padding: '12px', fontSize: '14px', color: 'var(--text-primary)' }}>
                            {entry.description || 'Add description'}
                          </td>
                          <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', color: 'var(--text-primary)' }}>
                            {formatTime(entry.hours)}
                          </td>
                          <td style={{ padding: '12px', fontSize: '14px', color: 'var(--text-primary)' }}>
                            {userName}
                          </td>
                          <td style={{ padding: '12px', fontSize: '14px', color: 'var(--text-primary)' }}>
                            {projectName && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <div style={{ width: '8px', height: '8px', backgroundColor: projectColor, borderRadius: '50%' }}></div>
                                <span style={{ maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {projectName}
                                </span>
                              </div>
                            )}
                            {!projectName && <span style={{ color: 'var(--text-secondary)' }}>-</span>}
                          </td>
                          <td style={{ padding: '12px', fontSize: '14px', color: 'var(--text-secondary)' }}>
                            -
                          </td>
                          <td style={{ padding: '12px', fontSize: '14px', color: 'var(--text-primary)' }}>
                            {startTime && endTime ? (
                              <span>
                                {startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - {endTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} {entryDate.toLocaleDateString([], { month: '2-digit', day: '2-digit', year: 'numeric' })}
                              </span>
                            ) : (
                              <span>
                                {entryDate.toLocaleDateString([], { month: '2-digit', day: '2-digit', year: 'numeric' })}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={7} style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '14px' }}>
                        No time entries found for this week
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <button style={{
            position: 'absolute',
            top: '20px',
            right: '20px',
            padding: '10px 20px',
            backgroundColor: 'var(--primary-color)',
            border: 'none',
            borderRadius: '6px',
            color: 'white',
            fontSize: '14px',
            fontWeight: '500',
            cursor: 'pointer',
          }}>
            + Add entry
          </button>
        </div>
      ) : (
        <div style={{
          backgroundColor: 'var(--bg-primary)',
          borderRadius: '8px',
          padding: '40px',
          border: '1px solid var(--border-color)',
          textAlign: 'center',
          color: 'var(--text-secondary)',
        }}>
          {activeTab} view coming soon...
        </div>
      )}
    </div>
  );
}
