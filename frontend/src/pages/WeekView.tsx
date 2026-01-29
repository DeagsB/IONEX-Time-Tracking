import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTimer } from '../context/TimerContext';
import { useDemoMode } from '../context/DemoModeContext';
import { timeEntriesService, projectsService, employeesService, customersService } from '../services/supabaseServices';
import SearchableSelect from '../components/SearchableSelect';
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
  const { user, isAdmin } = useAuth();
  const { timerRunning, timerStartTime, currentEntry, updateStartTime, updateTimerEntry, stopTimer } = useTimer();
  const { isDemoMode } = useDemoMode();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [currentDate, setCurrentDate] = useState(new Date());
  
  // Get viewUserId from query params (for admins viewing another employee's calendar)
  const viewUserId = searchParams.get('viewUserId');
  // Only allow admins to view other users' calendars
  const effectiveUserId = (isAdmin && viewUserId) ? viewUserId : user?.id;
  const [currentProject, setCurrentProject] = useState<string>('Time Tracking Software');
  const [viewMode, setViewMode] = useState<'week' | 'list' | 'timesheet'>('week');
  const [currentTime, setCurrentTime] = useState(Date.now());
  
  // Zoom level: number of divisions per hour (2=halves, 4=quarters, 5=fifths, 6=sixths, etc.)
  const [divisionsPerHour, setDivisionsPerHour] = useState(4);
  
  // Row height: height of each hour row in pixels (default 60px, can be adjusted)
  const [rowHeight, setRowHeight] = useState(60);
  
  // Week picker popup state
  const [showWeekPicker, setShowWeekPicker] = useState(false);
  const [pickerDate, setPickerDate] = useState(new Date());
  
  // Time entry modal state (for creating new entries)
  const [showTimeEntryModal, setShowTimeEntryModal] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<{
    date: Date;
    startTime: string;
    endTime: string;
  } | null>(null);
  const [newEntry, setNewEntry] = useState({
    description: '',
    customer_id: '', // No customer = Internal time
    project_id: '',
    hours: 0.25,
    billable: false, // Determined by rate_type (Internal = not billable)
    rate_type: 'Internal', // Default to Internal since no customer is default
    location: '', // Work location - different locations create separate service tickets
  });

  // Edit existing entry modal state
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingEntry, setEditingEntry] = useState<any>(null);
  const [editedEntry, setEditedEntry] = useState({
    description: '',
    customer_id: '', // For filtering projects
    project_id: '',
    start_time: '',
    end_time: '',
    hours: 0,
    billable: true,
    rate_type: 'Shop Time',
    location: '',
  });
  
  // Track mouse position for modal drag detection
  const [modalMouseDownPos, setModalMouseDownPos] = useState<{ x: number; y: number } | null>(null);

  // Drag resize state
  const [draggingEntry, setDraggingEntry] = useState<{
    entry: any;
    startY: number;
    originalHeight: number;
    originalEndTime: Date;
    previewHeight: number;
  } | null>(null);

  // Timer drag state (for adjusting start time)
  const [draggingTimer, setDraggingTimer] = useState<{
    startY: number;
    originalStartTime: number;
    dayContainerTop: number;
  } | null>(null);

  // Header visibility state (hide on scroll down, show on scroll up)
  const [headerVisible, setHeaderVisible] = useState(true);
  const lastScrollTop = useRef(0);

  // Ref for scrollable calendar container
  const calendarScrollRef = useRef<HTMLDivElement>(null);

  // Update end time and hours in real-time for running timer in edit modal
  useEffect(() => {
    if (showEditModal && editingEntry?.isRunningTimer && timerStartTime) {
      const interval = setInterval(() => {
        const now = new Date();
        const startDate = new Date(timerStartTime);
        const formatTime = (date: Date) => {
          return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
        };
        const durationMs = now.getTime() - startDate.getTime();
        const hours = durationMs / (1000 * 60 * 60);
        
        setEditedEntry(prev => ({
          ...prev,
          end_time: formatTime(now),
          hours: hours,
        }));
      }, 1000); // Update every second
      
      return () => clearInterval(interval);
    }
  }, [showEditModal, editingEntry?.isRunningTimer, timerStartTime]);
  
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

  // Fetch employee info if viewing another employee's calendar
  const { data: viewedEmployee } = useQuery({
    queryKey: ['employee', viewUserId],
    queryFn: async () => {
      if (!viewUserId || !isAdmin) return null;
      const { data, error } = await supabase
        .from('users')
        .select('id, first_name, last_name, email')
        .eq('id', viewUserId)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!viewUserId && isAdmin,
  });

  const { data: timeEntries, refetch: refetchTimeEntries } = useQuery({
    queryKey: ['timeEntries', 'week', weekStart.toISOString(), isDemoMode, effectiveUserId],
    queryFn: async () => {
      // Filter by effectiveUserId (current user's ID, or viewUserId if admin is viewing another employee)
      const allEntries = await timeEntriesService.getAll(isDemoMode, effectiveUserId);
      return allEntries?.filter((entry: any) => {
        const entryDate = new Date(entry.date + 'T00:00:00'); // Ensure local time comparison
        const weekStartDate = new Date(weekStart);
        weekStartDate.setHours(0, 0, 0, 0);
        const weekEndDate = new Date(weekEnd);
        weekEndDate.setHours(23, 59, 59, 999);
        return entryDate >= weekStartDate && entryDate <= weekEndDate;
      });
    },
  });

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => projectsService.getAll(),
  });

  const { data: customers } = useQuery({
    queryKey: ['customers'],
    queryFn: () => customersService.getAll(),
  });

  // Fetch current user's employee record to check department
  const { data: currentEmployee } = useQuery({
    queryKey: ['currentEmployee', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const employees = await employeesService.getAll();
      return employees?.find((emp: any) => emp.user_id === user.id) || null;
    },
    enabled: !!user?.id,
  });

  const isPanelShop = currentEmployee?.department === 'Panel Shop';

  // For Panel Shop employees, billable is always false (they only have Shop Time)
  // For other employees, billable is determined by rate_type (Internal = not billable)

  const createTimeEntryMutation = useMutation({
    mutationFn: async (data: any) => {
      console.log('Creating time entry:', data);
      const result = await timeEntriesService.create(data);
      console.log('Time entry created:', result);
      return result;
    },
    onSuccess: async (data) => {
      console.log('Time entry saved successfully:', data);
      // Invalidate and refetch all timeEntries queries to ensure entries appear immediately
      await queryClient.invalidateQueries({ queryKey: ['timeEntries'], exact: false });
      await refetchTimeEntries();
      setShowTimeEntryModal(false);
      setNewEntry({ description: '', customer_id: '', project_id: '', hours: 0.25, billable: false, rate_type: 'Internal', location: '' });
      setSelectedSlot(null);
    },
    onError: (error: any) => {
      console.error('Error creating time entry:', error);
      alert('Error creating time entry: ' + (error.message || 'Unknown error'));
    },
  });

  const updateTimeEntryMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      console.log('Updating time entry:', id, data);
      const result = await timeEntriesService.update(id, data);
      console.log('Time entry updated:', result);
      return result;
    },
    onSuccess: async () => {
      console.log('Time entry updated successfully');
      // Invalidate and refetch all timeEntries queries to ensure entries appear immediately
      await queryClient.invalidateQueries({ queryKey: ['timeEntries'], exact: false });
      await refetchTimeEntries();
      setShowEditModal(false);
      setEditingEntry(null);
    },
    onError: (error: any) => {
      console.error('Error updating time entry:', error);
      alert('Error updating time entry: ' + (error.message || 'Unknown error'));
    },
  });

  const deleteTimeEntryMutation = useMutation({
    mutationFn: async (id: string) => {
      console.log('Deleting time entry:', id);
      await timeEntriesService.delete(id);
    },
    onSuccess: async () => {
      console.log('Time entry deleted successfully');
      // Invalidate and refetch all timeEntries queries to ensure entries update immediately
      await queryClient.invalidateQueries({ queryKey: ['timeEntries'], exact: false });
      await refetchTimeEntries();
      setShowEditModal(false);
      setEditingEntry(null);
    },
    onError: (error: any) => {
      console.error('Error deleting time entry:', error);
      alert('Error deleting time entry: ' + (error.message || 'Unknown error'));
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
    // Format date in local time (YYYY-MM-DD) to match entry.date format
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
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

  // Scroll to 8:00am on component mount
  useEffect(() => {
    if (calendarScrollRef.current) {
      // 8:00am = hour 8, each hour is rowHeight px tall
      // Header is 50px, so scroll to position 8:00am at the top
      const scrollPosition = 8 * rowHeight - 50;
      calendarScrollRef.current.scrollTop = scrollPosition;
      lastScrollTop.current = scrollPosition;
    }
  }, []); // Run once on mount

  // Handle scroll to hide/show header
  useEffect(() => {
    const scrollContainer = calendarScrollRef.current;
    if (!scrollContainer) return;

    const handleScroll = () => {
      const currentScrollTop = scrollContainer.scrollTop;
      const scrollDifference = currentScrollTop - lastScrollTop.current;
      
      // Hide header when scrolling down, show when scrolling up
      // Add threshold to avoid flickering on small movements
      if (scrollDifference > 5 && headerVisible) {
        setHeaderVisible(false);
      } else if (scrollDifference < -5 && !headerVisible) {
        setHeaderVisible(true);
      }
      
      lastScrollTop.current = currentScrollTop;
    };

    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    return () => scrollContainer.removeEventListener('scroll', handleScroll);
  }, [headerVisible]);

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

  // Increase row height (makes calendar boxes taller for more detail)
  const increaseRowHeight = () => {
    setRowHeight(prev => Math.min(prev + 20, 200)); // Max 200px per hour
  };

  // Decrease row height (makes calendar boxes shorter to see more of the day)
  const decreaseRowHeight = () => {
    setRowHeight(prev => Math.max(prev - 20, 40)); // Min 40px per hour
  };

  // Handle clicking on a time slot division
  const handleSlotClick = (date: Date, hour: number, division: number) => {
    // Prevent creating entries when viewing another employee's calendar
    if (viewUserId && isAdmin) {
      alert('You cannot create entries for other employees. Switch to your own calendar to create entries.');
      return;
    }
    
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
        customer_id: '',
        project_id: '',
        hours: minutesPerDivision / 60,
        billable: false, // No customer = Internal = not billable
        rate_type: 'Internal',
        location: '',
      });
    setShowTimeEntryModal(true);
  };

  // Handle submitting the new time entry
  const handleSubmitTimeEntry = async () => {
    if (!selectedSlot) return;
    
    // Validate hours are within reasonable range (0 to 24)
    if (newEntry.hours <= 0 || newEntry.hours > 24) {
      alert('Hours must be between 0 and 24');
      return;
    }
    
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
    
    // Check for overnight entry (end time is earlier than start time)
    const isOvernight = (endHour * 60 + endMin) < (startHour * 60 + startMin);
    
    if (isOvernight) {
      // Split into two entries: one for day 1 (until midnight) and one for day 2 (from midnight)
      const midnightDate = new Date(year, selectedSlot.date.getMonth(), selectedSlot.date.getDate() + 1, 0, 0);
      const endDate = new Date(year, selectedSlot.date.getMonth(), selectedSlot.date.getDate() + 1, endHour, endMin);
      
      // Calculate hours for each part
      const hoursDay1 = (midnightDate.getTime() - startDate.getTime()) / (1000 * 60 * 60);
      const hoursDay2 = (endDate.getTime() - midnightDate.getTime()) / (1000 * 60 * 60);
      
      // Format day 2 date string
      const day2Month = String(midnightDate.getMonth() + 1).padStart(2, '0');
      const day2Day = String(midnightDate.getDate()).padStart(2, '0');
      const dateStrDay2 = `${midnightDate.getFullYear()}-${day2Month}-${day2Day}`;
      
      // No project = internal time, not billable
      const isBillableOvernight = isPanelShop ? false : (newEntry.project_id ? newEntry.billable : false);
      const rateTypeOvernight = isPanelShop ? 'Shop Time' : (newEntry.project_id ? newEntry.rate_type : 'Internal');
      
      // Entry 1: Start time to midnight on day 1
      const entry1: any = {
        user_id: actualUserId,
        date: dateStr,
        start_time: startDate.toISOString(),
        end_time: midnightDate.toISOString(),
        hours: hoursDay1,
        rate: 0,
        description: newEntry.description ? `${newEntry.description} (overnight 1/2)` : '(overnight 1/2)',
        billable: isBillableOvernight,
        rate_type: rateTypeOvernight,
        is_demo: isDemoMode,
        location: newEntry.location || null,
        customer_id: newEntry.customer_id || null,
        project_id: newEntry.project_id || null,
      };

      // Entry 2: Midnight to end time on day 2
      const entry2: any = {
        user_id: actualUserId,
        date: dateStrDay2,
        start_time: midnightDate.toISOString(),
        end_time: endDate.toISOString(),
        hours: hoursDay2,
        rate: 0,
        description: newEntry.description ? `${newEntry.description} (overnight 2/2)` : '(overnight 2/2)',
        billable: isBillableOvernight,
        rate_type: rateTypeOvernight,
        is_demo: isDemoMode,
        location: newEntry.location || null,
        customer_id: newEntry.customer_id || null,
        project_id: newEntry.project_id || null,
      };
      
      console.log('Submitting overnight entry split into two:');
      console.log('  Entry 1 (Day 1):', entry1);
      console.log('  Entry 2 (Day 2):', entry2);
      
      // Submit both entries
      createTimeEntryMutation.mutate(entry1);
      createTimeEntryMutation.mutate(entry2);
    } else {
      // Normal entry (same day)
      const endDate = new Date(year, selectedSlot.date.getMonth(), selectedSlot.date.getDate(), endHour, endMin);
      
      // No project = internal time, not billable
      const isBillable = isPanelShop ? false : (newEntry.project_id ? newEntry.billable : false);
      
      const timeEntryData: any = {
        user_id: actualUserId,
        date: dateStr,
        start_time: startDate.toISOString(),
        end_time: endDate.toISOString(),
        hours: newEntry.hours,
        rate: 0,
        description: newEntry.description || '',
        billable: isBillable,
        rate_type: isPanelShop ? 'Shop Time' : (newEntry.project_id ? newEntry.rate_type : 'Internal'),
        is_demo: isDemoMode,
        location: newEntry.location || null,
      };

      if (newEntry.project_id) {
        timeEntryData.project_id = newEntry.project_id;
      }

      console.log('Submitting time entry (with timezone):', timeEntryData);
      console.log('  Local time clicked:', selectedSlot.startTime, '-', selectedSlot.endTime);
      console.log('  ISO timestamps:', startDate.toISOString(), endDate.toISOString());
      createTimeEntryMutation.mutate(timeEntryData);
    }
  };

  // Handle clicking on an existing time entry to edit it
  const handleEntryClick = (entry: any, event: React.MouseEvent) => {
    event.stopPropagation();
    // Prevent editing entries when viewing another employee's calendar
    if (viewUserId && isAdmin) {
      alert('You cannot edit entries for other employees. Switch to your own calendar to edit entries.');
      return;
    }
    setEditingEntry(entry);
    
    // Parse the times for display
    const parseTime = (timeStr: string) => {
      if (timeStr.includes('T') || timeStr.includes(' ')) {
        const date = new Date(timeStr);
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      }
      return timeStr.slice(0, 5);
    };
    
    // Look up the customer_id from the project
    const entryProject = projects?.find((p: any) => p.id === entry.project_id);
    
    setEditedEntry({
      description: entry.description || '',
      customer_id: entryProject?.customer_id || '',
      project_id: entry.project_id || '',
      start_time: parseTime(entry.start_time),
      end_time: parseTime(entry.end_time),
      hours: entry.hours || 0,
      billable: entry.billable !== undefined ? entry.billable : true,
      rate_type: entry.rate_type || 'Shop Time',
      location: entry.location || '',
    });
    setShowEditModal(true);
  };

  // Handle clicking on the running timer to edit it
  const handleTimerClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!timerRunning || !timerStartTime || !currentEntry) return;
    
    // Create a temporary entry object from the timer state
    const now = new Date();
    const startDate = new Date(timerStartTime);
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    
    // Format times for display
    const formatTime = (date: Date) => {
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    };
    
    // Calculate hours
    const durationMs = now.getTime() - startDate.getTime();
    const hours = durationMs / (1000 * 60 * 60);
    
    const timerEntry = {
      id: null, // No id means it's a running timer
      isRunningTimer: true, // Flag to identify running timer
      description: currentEntry.description || '',
      project_id: currentEntry.projectId || '',
      start_time: startDate.toISOString(),
      end_time: now.toISOString(),
      hours: hours,
      date: dateStr,
      billable: true,
      rate_type: 'Shop Time',
    };
    
    setEditingEntry(timerEntry);
    // Look up the customer_id from the project
    const timerProject = projects?.find((p: any) => p.id === currentEntry.projectId);
    
    setEditedEntry({
      description: currentEntry.description || '',
      customer_id: timerProject?.customer_id || '',
      project_id: currentEntry.projectId || '',
      start_time: formatTime(startDate),
      end_time: formatTime(now),
      hours: hours,
      billable: true,
      rate_type: 'Shop Time',
      location: (currentEntry as any).location || '',
    });
    setShowEditModal(true);
  };

  // Handle saving edited time entry
  const handleSaveEdit = () => {
    if (!editingEntry) return;
    
    // Parse times to calculate hours for validation
    const [startH, startM] = editedEntry.start_time.split(':').map(Number);
    const [endH, endM] = editedEntry.end_time.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    
    // Handle overnight entries (end time is earlier than start time)
    let calculatedHours;
    if (endMinutes < startMinutes) {
      // Overnight entry: add 24 hours worth of minutes
      calculatedHours = (endMinutes + 24 * 60 - startMinutes) / 60;
    } else {
      calculatedHours = (endMinutes - startMinutes) / 60;
    }
    
    // Validate hours are within reasonable range (0 to 24)
    if (calculatedHours <= 0 || calculatedHours > 24) {
      alert('Hours must be between 0 and 24');
      return;
    }
    
    // Check if this is a running timer (no id)
    if (editingEntry.isRunningTimer || !editingEntry.id) {
      // Update the timer context instead of creating/updating a database entry
      const selectedProject = projects?.find((p: any) => p.id === editedEntry.project_id);
      updateTimerEntry(
        editedEntry.description,
        editedEntry.project_id || undefined,
        selectedProject?.name
      );
      
      // If start time was changed, update it
      if (timerStartTime) {
        const [startHour, startMin] = editedEntry.start_time.split(':').map(Number);
        const today = new Date();
        const newStartTime = new Date(
          today.getFullYear(),
          today.getMonth(),
          today.getDate(),
          startHour,
          startMin
        );
        // Only update if the time actually changed
        if (newStartTime.getTime() !== timerStartTime) {
          updateStartTime(newStartTime.getTime());
        }
      }
      
      setShowEditModal(false);
      setEditingEntry(null);
      return;
    }
    
    // Parse the date from the original entry - handle both string and Date formats
    // If it's a string like "2024-01-15", parse it carefully to avoid timezone issues
    let entryDate: Date;
    if (typeof editingEntry.date === 'string') {
      // Parse YYYY-MM-DD format in local timezone
      const [year, month, day] = editingEntry.date.split('-').map(Number);
      entryDate = new Date(year, month - 1, day);
    } else {
      entryDate = new Date(editingEntry.date);
    }
    
    const year = entryDate.getFullYear();
    const month = String(entryDate.getMonth() + 1).padStart(2, '0');
    const day = String(entryDate.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    
    // Parse edited times
    const [startHour, startMin] = editedEntry.start_time.split(':').map(Number);
    const [endHour, endMin] = editedEntry.end_time.split(':').map(Number);
    
    // Check for overnight entry (end time is earlier than start time)
    const isOvernight = (endHour * 60 + endMin) < (startHour * 60 + startMin);
    
    // Create Date objects with local time
    const startDate = new Date(year, entryDate.getMonth(), entryDate.getDate(), startHour, startMin);
    
    if (isOvernight) {
      // Split into two entries: delete original, create two new ones
      const midnightDate = new Date(year, entryDate.getMonth(), entryDate.getDate() + 1, 0, 0);
      const endDate = new Date(year, entryDate.getMonth(), entryDate.getDate() + 1, endHour, endMin);
      
      // Calculate hours for each part
      const hoursDay1 = (midnightDate.getTime() - startDate.getTime()) / (1000 * 60 * 60);
      const hoursDay2 = (endDate.getTime() - midnightDate.getTime()) / (1000 * 60 * 60);
      
      // Format day 2 date string
      const day2Month = String(midnightDate.getMonth() + 1).padStart(2, '0');
      const day2Day = String(midnightDate.getDate()).padStart(2, '0');
      const dateStrDay2 = `${midnightDate.getFullYear()}-${day2Month}-${day2Day}`;
      
      // Get user ID from the original entry
      const actualUserId = editingEntry.user_id || user?.id || '235d854a-1b7d-4e00-a5a4-43835c85c086';
      
      // Entry 1: Start time to midnight on day 1
      const entry1: any = {
        user_id: actualUserId,
        date: dateStr,
        start_time: startDate.toISOString(),
        end_time: midnightDate.toISOString(),
        hours: hoursDay1,
        rate: editingEntry.rate || 0,
        description: editedEntry.description ? `${editedEntry.description} (overnight 1/2)` : '(overnight 1/2)',
        billable: isPanelShop ? false : editedEntry.billable,
        rate_type: isPanelShop ? 'Shop Time' : editedEntry.rate_type,
        is_demo: editingEntry.is_demo || isDemoMode,
        location: editedEntry.location || null,
        customer_id: editedEntry.customer_id || null,
        project_id: editedEntry.project_id || null,
      };

      // Entry 2: Midnight to end time on day 2
      const entry2: any = {
        user_id: actualUserId,
        date: dateStrDay2,
        start_time: midnightDate.toISOString(),
        end_time: endDate.toISOString(),
        hours: hoursDay2,
        rate: editingEntry.rate || 0,
        description: editedEntry.description ? `${editedEntry.description} (overnight 2/2)` : '(overnight 2/2)',
        billable: isPanelShop ? false : editedEntry.billable,
        rate_type: isPanelShop ? 'Shop Time' : editedEntry.rate_type,
        is_demo: editingEntry.is_demo || isDemoMode,
        location: editedEntry.location || null,
        customer_id: editedEntry.customer_id || null,
        project_id: editedEntry.project_id || null,
      };
      
      console.log('Editing overnight entry - splitting into two:');
      console.log('  Deleting original:', editingEntry.id);
      console.log('  Creating Entry 1 (Day 1):', entry1);
      console.log('  Creating Entry 2 (Day 2):', entry2);
      
      // Delete original and create two new entries
      deleteTimeEntryMutation.mutate(editingEntry.id);
      createTimeEntryMutation.mutate(entry1);
      createTimeEntryMutation.mutate(entry2);
      
      setShowEditModal(false);
      setEditingEntry(null);
    } else {
      // Normal entry (same day)
      const endDate = new Date(year, entryDate.getMonth(), entryDate.getDate(), endHour, endMin);
      
      // Calculate hours
      const durationMs = endDate.getTime() - startDate.getTime();
      const hours = durationMs / (1000 * 60 * 60);
      
      const updateData: any = {
        description: editedEntry.description,
        start_time: startDate.toISOString(),
        end_time: endDate.toISOString(),
        hours: hours,
        date: dateStr,
        billable: isPanelShop ? false : editedEntry.billable,
        rate_type: isPanelShop ? 'Shop Time' : editedEntry.rate_type,
        location: editedEntry.location || null,
        customer_id: editedEntry.customer_id || null,
        project_id: editedEntry.project_id || null,
      };
      
      updateTimeEntryMutation.mutate({ id: editingEntry.id, data: updateData });
    }
  };

  // Handle deleting time entry
  const handleDeleteEntry = () => {
    if (!editingEntry) return;
    
    // If it's a running timer, stop it instead of deleting
    if (editingEntry.isRunningTimer || !editingEntry.id) {
      if (window.confirm('Are you sure you want to stop and discard this timer?')) {
        stopTimer();
        setShowEditModal(false);
        setEditingEntry(null);
      }
      return;
    }
    
    if (window.confirm('Are you sure you want to delete this time entry?')) {
      deleteTimeEntryMutation.mutate(editingEntry.id);
    }
  };

  // Handle drag start for resizing entry
  const handleDragStart = (e: React.MouseEvent, entry: any, entryStyle: { top: number; height: number }) => {
    e.stopPropagation();
    e.preventDefault();
    
    if (!entry.start_time || !entry.end_time) return;
    
    const parseTime = (timeStr: string) => {
      if (timeStr.includes('T') || timeStr.includes(' ')) {
        const date = new Date(timeStr);
        return { hour: date.getHours(), minute: date.getMinutes() };
      }
      const [hour, minute] = timeStr.split(':').map(Number);
      return { hour, minute };
    };
    
    const endTime = parseTime(entry.end_time);
    // Create end time date from entry's end_time (which is already an ISO string)
    const originalEndTime = entry.end_time.includes('T') 
      ? new Date(entry.end_time)
      : new Date(entry.date + 'T' + String(endTime.hour).padStart(2, '0') + ':' + String(endTime.minute).padStart(2, '0') + ':00');
    
    setDraggingEntry({
      entry,
      startY: e.clientY,
      originalHeight: entryStyle.height,
      originalEndTime,
      previewHeight: entryStyle.height,
    });
  };

  // Handle timer drag start (adjusting start time)
  const handleTimerDragStart = (e: React.MouseEvent, dayContainer: HTMLElement) => {
    e.stopPropagation();
    e.preventDefault();
    
    if (!timerStartTime) return;
    
    const rect = dayContainer.getBoundingClientRect();
    setDraggingTimer({
      startY: e.clientY,
      originalStartTime: timerStartTime,
      dayContainerTop: rect.top,
    });
  };

  // Handle timer drag move and end
  useEffect(() => {
    if (!draggingTimer) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Calculate deltaY relative to the original drag start position
      const deltaY = e.clientY - draggingTimer.startY;
      const minutesPerPixel = 60 / rowHeight;
      const minutesDelta = deltaY * minutesPerPixel;
      
      // Calculate new start time based on original start time
      // Dragging DOWN (positive deltaY) = move start time LATER (add minutes)
      // Dragging UP (negative deltaY) = move start time EARLIER (subtract minutes)
      const newStartTime = new Date(draggingTimer.originalStartTime);
      const currentMinutes = newStartTime.getMinutes();
      const currentHours = newStartTime.getHours();
      
      // Calculate total minutes from midnight, adjust by delta, then convert back
      const totalMinutesFromMidnight = currentHours * 60 + currentMinutes;
      const newTotalMinutes = totalMinutesFromMidnight + minutesDelta;
      
      // Round to nearest 15-minute increment
      const roundedTotalMinutes = Math.round(newTotalMinutes / 15) * 15;
      
      // Convert back to hours and minutes
      const newHours = Math.floor(roundedTotalMinutes / 60);
      const newMinutes = roundedTotalMinutes % 60;
      
      // Handle negative minutes (going before midnight) or hours > 24
      if (roundedTotalMinutes < 0) {
        return; // Don't allow going before midnight
      }
      if (newHours >= 24) {
        return; // Don't allow going past midnight
      }
      
      newStartTime.setHours(newHours, newMinutes, 0, 0);
      
      // Don't allow start time to be in the future
      const now = Date.now();
      if (newStartTime.getTime() > now) {
        return;
      }
      
      // Update the timer start time
      updateStartTime(newStartTime.getTime());
    };

    const handleMouseUp = () => {
      setDraggingTimer(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingTimer, rowHeight, updateStartTime]);

  // Handle drag move for resizing entry
  useEffect(() => {
    if (!draggingEntry) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = e.clientY - draggingEntry.startY;
      const minutesPerPixel = 60 / rowHeight; // 1 minute per pixel
      
      // Calculate new height (minimum 30px)
      const newHeight = Math.max(30, draggingEntry.originalHeight + deltaY);
      
      // Round to nearest 15-minute increment
      const totalMinutes = (newHeight / rowHeight) * 60;
      const roundedMinutes = Math.round(totalMinutes / 15) * 15;
      const roundedHeight = (roundedMinutes / 60) * rowHeight;
      
      setDraggingEntry({
        ...draggingEntry,
        previewHeight: Math.max(30, roundedHeight),
      });
    };

    const handleMouseUp = async () => {
      if (!draggingEntry) return;
      
      const totalMinutes = (draggingEntry.previewHeight / rowHeight) * 60;
      const roundedMinutes = Math.round(totalMinutes / 15) * 15;
      
      // Calculate new end time based on rounded minutes
      const startTime = new Date(draggingEntry.entry.start_time);
      const newEndTime = new Date(startTime);
      newEndTime.setMinutes(startTime.getMinutes() + roundedMinutes);
      
      // Use existing entry date (already in YYYY-MM-DD format)
      const dateStr = draggingEntry.entry.date;
      
      // Calculate new hours
      const newHours = roundedMinutes / 60;
      
      // Update the entry
      const updateData: any = {
        end_time: newEndTime.toISOString(),
        hours: newHours,
        date: dateStr,
      };
      
      updateTimeEntryMutation.mutate({ id: draggingEntry.entry.id, data: updateData });
      
      setDraggingEntry(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingEntry, updateTimeEntryMutation]);

  // Get time entry position and height for rendering on grid
  const getEntryStyle = (entry: any) => {
    if (!entry.start_time || !entry.end_time) return null;
    
    // Parse ISO timestamp or HH:MM format
    const parseTimeWithDate = (timeStr: string) => {
      // If it's an ISO timestamp (contains 'T' or space), extract time and date
      if (timeStr.includes('T') || timeStr.includes(' ')) {
        const date = new Date(timeStr);
        return {
          hour: date.getHours(),
          minute: date.getMinutes(),
          dateStr: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        };
      }
      // Otherwise parse as HH:MM format
      const [hour, minute] = timeStr.split(':').map(Number);
      return { hour, minute, dateStr: entry.date };
    };
    
    const startTime = parseTimeWithDate(entry.start_time);
    const endTime = parseTimeWithDate(entry.end_time);
    
    const startMinutes = startTime.hour * 60 + startTime.minute;
    let endMinutes = endTime.hour * 60 + endTime.minute;
    
    // If the end time is on a different day than the entry's date, 
    // treat it as extending to midnight (24:00 = 1440 minutes)
    if (endTime.dateStr !== entry.date) {
      endMinutes = 24 * 60; // Midnight = end of day
    }
    
    const duration = endMinutes - startMinutes;
    
    // Use state rowHeight instead of hardcoded 60
    const top = (startMinutes / 60) * rowHeight;
    // Calculate height precisely to stop at the end time line (not overlap it)
    const height = (duration / 60) * rowHeight;
    
    return { top, height, startMinutes, endMinutes };
  };

  // Check if two time ranges overlap
  const doEntriesOverlap = (entry1: any, entry2: any) => {
    const style1 = getEntryStyle(entry1);
    const style2 = getEntryStyle(entry2);
    if (!style1 || !style2) return false;
    
    // Check if time ranges overlap
    return !(style1.endMinutes <= style2.startMinutes || style2.endMinutes <= style1.startMinutes);
  };

  // Calculate overlap position for an entry within a group of overlapping entries
  const getOverlapPosition = (entry: any, allEntries: any[], entryIndex: number) => {
    // Find all entries that overlap with this one
    const overlappingEntries = allEntries.filter((e, idx) => 
      idx !== entryIndex && doEntriesOverlap(entry, e)
    );
    
    if (overlappingEntries.length === 0) {
      // No overlap, use default position
      return { left: '4px', right: '4px', topOffset: 0, zIndex: 10 };
    }
    
    // Find the index of this entry within the overlapping group
    // Sort overlapping entries by start time to determine lane assignment
    const allOverlapping = [entry, ...overlappingEntries];
    const sortedOverlapping = allOverlapping.sort((a, b) => {
      const styleA = getEntryStyle(a);
      const styleB = getEntryStyle(b);
      if (!styleA || !styleB) return 0;
      return styleA.startMinutes - styleB.startMinutes;
    });
    
    const positionInGroup = sortedOverlapping.findIndex(e => e.id === entry.id);
    const lane = positionInGroup % 2; // Alternate between left (0) and right (1)
    
    // Position based on lane
    if (lane === 0) {
      // Left lane - slightly to the left and up
      return { 
        left: '4px', 
        right: '52%', // Leave space for right lane
        topOffset: -3, // Move up 3px
        zIndex: 10 + positionInGroup 
      };
    } else {
      // Right lane - slightly to the right and down
      return { 
        left: '48%', // Start from middle
        right: '4px', 
        topOffset: 3, // Move down 3px
        zIndex: 10 + positionInGroup 
      };
    }
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
      {/* Banner when viewing another employee's calendar */}
      {viewUserId && isAdmin && viewedEmployee && (
        <div style={{
          backgroundColor: 'var(--warning-color)',
          color: 'white',
          padding: '12px 20px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: '14px',
          fontWeight: '500'
        }}>
          <span>
            Viewing calendar for: <strong>{viewedEmployee.first_name} {viewedEmployee.last_name}</strong> ({viewedEmployee.email})
          </span>
          <button
            onClick={() => {
              navigate('/calendar');
            }}
            style={{
              padding: '6px 12px',
              backgroundColor: 'rgba(255, 255, 255, 0.2)',
              border: '1px solid rgba(255, 255, 255, 0.3)',
              borderRadius: '4px',
              color: 'white',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            View My Calendar
          </button>
        </div>
      )}
      
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
          <div style={{ position: 'relative' }}>
            <div 
              onClick={() => {
                setPickerDate(new Date(currentDate));
                setShowWeekPicker(!showWeekPicker);
              }}
              style={{ 
                padding: '8px 16px', 
                backgroundColor: 'var(--bg-secondary)', 
              borderRadius: '6px',
                border: '1px solid var(--border-color)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                minWidth: '220px',
              cursor: 'pointer',
                userSelect: 'none'
              }}
            >
              <span>📅</span>
              <strong>{getWeekLabel()}</strong>
              <span style={{ color: 'var(--text-secondary)' }}>· W{getWeekNumber(currentDate)}</span>
            </div>
            
            {/* Week Picker Popup */}
            {showWeekPicker && (
              <div style={{
                position: 'absolute',
                top: '100%',
                left: '0',
                marginTop: '8px',
                backgroundColor: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
                padding: '16px',
                zIndex: 1000,
                minWidth: '280px'
              }}>
                {/* Month/Year Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      setPickerDate(new Date(pickerDate.getFullYear(), pickerDate.getMonth() - 1, 1));
                    }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', padding: '4px 8px' }}
                  >
                    ‹
          </button>
                  <strong style={{ fontSize: '14px' }}>
                    {pickerDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                  </strong>
          <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setPickerDate(new Date(pickerDate.getFullYear(), pickerDate.getMonth() + 1, 1));
                    }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', padding: '4px 8px' }}
                  >
                    ›
                  </button>
                </div>
                
                {/* Day Headers */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', marginBottom: '8px' }}>
                  {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(day => (
                    <div key={day} style={{ textAlign: 'center', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 'bold' }}>
                      {day}
                    </div>
                  ))}
                </div>
                
                {/* Calendar Grid */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' }}>
                  {(() => {
                    const year = pickerDate.getFullYear();
                    const month = pickerDate.getMonth();
                    const firstDay = new Date(year, month, 1);
                    const lastDay = new Date(year, month + 1, 0);
                    const startDay = (firstDay.getDay() + 6) % 7; // Monday = 0
                    const daysInMonth = lastDay.getDate();
                    
                    const cells = [];
                    
                    // Empty cells before first day
                    for (let i = 0; i < startDay; i++) {
                      cells.push(<div key={`empty-${i}`} style={{ height: '32px' }} />);
                    }
                    
                    // Day cells
                    for (let day = 1; day <= daysInMonth; day++) {
                      const cellDate = new Date(year, month, day);
                      const cellWeekStart = getWeekStart(cellDate);
                      const isSelectedWeek = cellWeekStart.toDateString() === weekStart.toDateString();
                      const isToday = cellDate.toDateString() === new Date().toDateString();
                      
                      cells.push(
                        <div
                          key={day}
                          onClick={(e) => {
                            e.stopPropagation();
                            setCurrentDate(cellDate);
                            setShowWeekPicker(false);
                          }}
            style={{
                            height: '32px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '13px',
              cursor: 'pointer',
                            borderRadius: '4px',
                            backgroundColor: isSelectedWeek ? 'var(--primary-color)' : 'transparent',
                            color: isSelectedWeek ? 'white' : 'var(--text-primary)',
                            border: isToday ? '2px solid #dc2626' : 'none',
                            fontWeight: isToday ? 'bold' : 'normal'
                          }}
                          onMouseEnter={(e) => {
                            if (!isSelectedWeek) {
                              e.currentTarget.style.backgroundColor = 'rgba(220, 38, 38, 0.15)';
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (!isSelectedWeek) {
                              e.currentTarget.style.backgroundColor = 'transparent';
                            }
                          }}
                        >
                          {day}
                        </div>
                      );
                    }
                    
                    return cells;
                  })()}
                </div>
                
                {/* Quick Actions */}
                <div style={{ display: 'flex', gap: '8px', marginTop: '12px', borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setCurrentDate(new Date());
                      setShowWeekPicker(false);
                    }}
                    className="button button-primary"
                    style={{ flex: 1, fontSize: '12px', padding: '8px' }}
                  >
                    This Week
          </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowWeekPicker(false);
                    }}
                    className="button button-secondary"
                    style={{ fontSize: '12px', padding: '8px' }}
                  >
                    Close
                  </button>
          </div>
        </div>
            )}
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
              Calendar View
            </button>
            <button
              className="button"
              onClick={() => setViewMode('list')}
              style={{
                backgroundColor: viewMode === 'list' ? 'var(--primary-color)' : 'transparent',
                color: viewMode === 'list' ? 'white' : 'var(--text-primary)',
                padding: '6px 12px',
                fontSize: '13px'
              }}
            >
              List view
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

      {/* List View */}
      {viewMode === 'list' && (
        <div style={{ flex: 1, overflow: 'auto', backgroundColor: 'var(--bg-primary)' }}>
          {timeEntries && timeEntries.length > 0 ? (
            (() => {
              // Group entries by date
              const entriesByDate = timeEntries.reduce((acc: any, entry: any) => {
                const date = entry.date;
                if (!acc[date]) {
                  acc[date] = [];
                }
                acc[date].push(entry);
                return acc;
              }, {});

              // Sort dates descending
              const sortedDates = Object.keys(entriesByDate).sort((a, b) => 
                new Date(b).getTime() - new Date(a).getTime()
              );

              return (
                <div style={{ padding: '20px' }}>
                  {sortedDates.map((dateStr) => {
                    const entries = entriesByDate[dateStr];
                    const date = new Date(dateStr);
                    const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
                    const dayNum = date.getDate();
                    const monthName = date.toLocaleDateString('en-US', { month: 'short' });
                    const year = date.getFullYear();
                    const isCurrentYear = year === new Date().getFullYear();
                    
                    // Calculate day total
                    const dayTotalSeconds = entries.reduce((sum: number, e: any) => sum + Number(e.hours) * 3600, 0);
                    const dayTotalHours = Math.floor(dayTotalSeconds / 3600);
                    const dayTotalMinutes = Math.floor((dayTotalSeconds % 3600) / 60);
                    const dayTotalSecs = dayTotalSeconds % 60;
                    const dayTotal = `${dayTotalHours}:${String(dayTotalMinutes).padStart(2, '0')}:${String(dayTotalSecs).padStart(2, '0')}`;

                    // Check for overlaps
                    const checkOverlap = (entry1: any, entry2: any) => {
                      if (!entry1.start_time || !entry1.end_time || !entry2.start_time || !entry2.end_time) return false;
                      const start1 = new Date(entry1.start_time).getTime();
                      const end1 = new Date(entry1.end_time).getTime();
                      const start2 = new Date(entry2.start_time).getTime();
                      const end2 = new Date(entry2.end_time).getTime();
                      return !(end1 <= start2 || end2 <= start1);
                    };

                    return (
                      <div key={dateStr} style={{ marginBottom: '30px' }}>
                        {/* Date header */}
                        <div style={{ 
                          display: 'flex', 
                          justifyContent: 'space-between', 
                          alignItems: 'center',
                          marginBottom: '15px',
                          paddingBottom: '10px',
                          borderBottom: '1px solid var(--border-color)'
                        }}>
                          <div style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-primary)' }}>
                            {dayName}, {dayNum} {monthName}{!isCurrentYear ? `, ${year}` : ''}
                          </div>
                          <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                            {dayTotal}
                          </div>
                        </div>

                        {/* Entries */}
                        {entries.map((entry: any) => {
                          const project = entry.project || projects?.find((p: any) => p.id === entry.project_id);
                          const hasOverlap = entries.some((e: any) => e.id !== entry.id && checkOverlap(entry, e));
                          
                          // Format times
                          const formatTimeDisplay = (timeStr: string) => {
                            if (!timeStr) return '';
                            const date = new Date(timeStr);
                            const hours = date.getHours();
                            const minutes = date.getMinutes();
                            const ampm = hours >= 12 ? 'PM' : 'AM';
                            const displayHours = hours % 12 || 12;
                            return `${displayHours}:${String(minutes).padStart(2, '0')} ${ampm}`;
                          };

                          // Format duration
                          const formatDuration = (hours: number) => {
                            const totalSeconds = Math.floor(hours * 3600);
                            const h = Math.floor(totalSeconds / 3600);
                            const m = Math.floor((totalSeconds % 3600) / 60);
                            const s = totalSeconds % 60;
                            return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
                          };

                          return (
                            <div 
                              key={entry.id}
                              onClick={(e) => handleEntryClick(entry, e)}
                              style={{
                                padding: '12px 0',
                                borderBottom: '1px solid var(--border-color)',
                                cursor: 'pointer',
                                transition: 'background-color 0.2s'
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.backgroundColor = 'rgba(220, 38, 38, 0.15)';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor = 'transparent';
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                                {/* Description */}
                                <div style={{ flex: 1 }}>
                                  <div style={{ 
                                    fontSize: '14px', 
                                    color: 'var(--text-primary)', 
                                    marginBottom: '4px',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis'
                                  }}>
                                    {entry.description || 'Add description'}
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                                    {project && (
                                      <>
                                        <div style={{
                                          width: '8px',
                                          height: '8px',
                                          borderRadius: '50%',
                                          backgroundColor: project.color || '#666',
                                          flexShrink: 0
                                        }} />
                                        <span>• {project.name}</span>
                                      </>
                                    )}
                                    {hasOverlap && (
                                      <span style={{
                                        backgroundColor: 'var(--bg-tertiary)',
                                        color: 'var(--text-secondary)',
                                        padding: '2px 8px',
                                        borderRadius: '12px',
                                        fontSize: '10px',
                                        fontWeight: '500'
                                      }}>
                                        OVERLAP
                                      </span>
                                    )}
                                  </div>
                                </div>
                                
                                {/* Times and duration */}
                                <div style={{ textAlign: 'right', fontSize: '12px', color: 'var(--text-secondary)' }}>
                                  {entry.start_time && entry.end_time && (
                                    <div style={{ marginBottom: '4px' }}>
                                      {formatTimeDisplay(entry.start_time)} - {formatTimeDisplay(entry.end_time)}
                                    </div>
                                  )}
                                  <div style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: '500' }}>
                                    {formatDuration(entry.hours)}
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              );
            })()
          ) : (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>
              No time entries found
            </div>
          )}
        </div>
      )}

      {/* Calendar Grid */}
      {viewMode !== 'list' && (
      <div ref={calendarScrollRef} style={{ flex: 1, overflow: 'auto', backgroundColor: 'var(--bg-primary)' }}>
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
              gap: '4px',
              position: 'sticky',
              top: 0,
              zIndex: 11,
              transform: headerVisible ? 'translateY(0)' : 'translateY(-50px)',
              transition: 'transform 0.2s ease-in-out',
            }}>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    decreaseRowHeight();
                  }}
                  disabled={rowHeight <= 40}
                style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '4px',
                    border: '1px solid var(--border-color)',
                    backgroundColor: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    cursor: rowHeight <= 40 ? 'not-allowed' : 'pointer',
                    opacity: rowHeight <= 40 ? 0.5 : 1,
                    fontSize: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                  }}
                  title={`Decrease row height - Current: ${rowHeight}px per hour`}
                >
                  −
                </button>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    increaseRowHeight();
                  }}
                  disabled={rowHeight >= 200}
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '4px',
                    border: '1px solid var(--border-color)',
                    backgroundColor: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    cursor: rowHeight >= 200 ? 'not-allowed' : 'pointer',
                    opacity: rowHeight >= 200 ? 0.5 : 1,
                    fontSize: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                  }}
                  title={`Increase row height - Current: ${rowHeight}px per hour`}
                >
                  +
                </button>
                </div>
              <div style={{ fontSize: '9px', color: 'var(--text-secondary)', fontWeight: '600' }}>
                {rowHeight}px
                </div>
        </div>

        {/* Time slots */}
            {timeSlots.map((time, index) => (
              <div
                key={index}
                style={{
                  height: `${rowHeight}px`,
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
                data-day-container
                style={{
                  flex: 1,
                  minWidth: '150px',
                  borderRight: dayIndex < 6 ? '1px solid var(--border-color)' : 'none',
                  position: 'relative',
                  overflow: 'visible'
                }}
              >
                {/* Day header - compact layout */}
                <div style={{
                  height: '50px',
                  borderBottom: '1px solid var(--border-color)',
                  backgroundColor: day.isToday ? '#dc262650' : 'var(--bg-secondary)',
                  padding: '8px 12px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                  gap: '2px',
                  position: 'sticky',
                  top: 0,
                  zIndex: 10,
                  transform: headerVisible ? 'translateY(0)' : 'translateY(-50px)',
                  transition: 'transform 0.2s ease-in-out',
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
                      color: day.isToday ? '#dc2626' : 'var(--text-primary)'
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
                <div key={`grid-${divisionsPerHour}`} style={{ position: 'relative', overflow: 'visible' }}>
                  {timeSlots.map((_, hourIndex) => (
                    <div
                      key={`hour-${hourIndex}-${divisionsPerHour}`}
                      style={{
                        height: `${rowHeight}px`,
                        borderBottom: '1px solid var(--border-color)',
                        backgroundColor: hourIndex % 2 === 0 ? 'var(--bg-primary)' : 'var(--bg-secondary)',
                        display: 'flex',
                        flexDirection: 'column',
                        position: 'relative',
                        overflow: 'visible'
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
                            pointerEvents: 'auto',
                            position: 'relative',
                            zIndex: 1
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

                    // Use project from entry relationship if available, otherwise fallback to projects list
                    const project = entry.project || projects?.find((p: any) => p.id === entry.project_id);
                    // Use project color if available, otherwise grey for no project
                    const color = entry.project_id && project?.color ? project.color : '#808080';
                    
                    // Use preview height if dragging this entry
                    const isDragging = draggingEntry?.entry.id === entry.id;
                    const displayHeight = isDragging && draggingEntry ? draggingEntry.previewHeight : Math.max(style.height, 30);
                    
                    // Calculate overlap position
                    const overlapPos = getOverlapPosition(entry, dayEntries, entryIndex);
                    const topPosition = style.top + overlapPos.topOffset;
                    
                    // Adjust height to stop exactly at the time line (subtract 2px to account for border and ensure no overlap)
                    const adjustedHeight = Math.max(displayHeight - 2, 28);
                  
                  return (
                    <div
                      key={entry.id}
                      style={{
                        position: 'absolute',
                          top: `${topPosition}px`,
                          height: `${adjustedHeight}px`,
                        left: overlapPos.left,
                        right: overlapPos.right,
                        backgroundColor: color,
                        borderRadius: '4px',
                        padding: '6px 8px',
                        fontSize: '12px',
                          color: 'white',
                        overflow: 'hidden',
                        cursor: 'pointer',
                          boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                          zIndex: isDragging ? 20 : overlapPos.zIndex,
                          pointerEvents: 'auto',
                          boxSizing: 'border-box'
                        }}
                        onClick={(e) => {
                          // Don't open edit modal if clicking on drag handle
                          if ((e.target as HTMLElement).closest('.drag-handle')) {
                            return;
                          }
                          handleEntryClick(entry, e);
                        }}
                      >
                        {/* Description - main text (if exists) */}
                        {entry.description && (
                          <div style={{ 
                            fontWeight: '600', 
                            fontSize: '11px', 
                            marginBottom: '2px',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }}>
                            {entry.description}
                      </div>
                        )}
                        
                        {/* Project name */}
                        <div style={{ fontSize: '10px', opacity: 0.9 }}>
                          {project?.name || '(No Project)'}
                      </div>
                        
                        {/* Time range (only show if there's enough space) */}
                        {displayHeight > 45 && (
                          <div style={{ fontSize: '10px', marginTop: '2px', opacity: 0.8 }}>
                            {formatTimeDisplay(entry.start_time)} - {formatTimeDisplay(entry.end_time)}
                        </div>
                      )}
                        
                        {/* Drag handle - three line icon at bottom middle */}
                        <div
                          className="drag-handle"
                          style={{
                            position: 'absolute',
                            bottom: '2px',
                            left: '50%',
                            transform: 'translateX(-50%)',
                            width: '24px',
                            height: '12px',
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'center',
                            alignItems: 'center',
                            gap: '2px',
                            cursor: 'ns-resize',
                            opacity: 0.7,
                            transition: 'opacity 0.2s',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.opacity = '1';
                            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                            e.currentTarget.style.borderRadius = '3px';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.opacity = '0.7';
                            e.currentTarget.style.background = 'transparent';
                          }}
                          onMouseDown={(e) => handleDragStart(e, entry, style)}
                        >
                          <div style={{ width: '16px', height: '2px', backgroundColor: 'white', borderRadius: '1px' }} />
                          <div style={{ width: '16px', height: '2px', backgroundColor: 'white', borderRadius: '1px' }} />
                          <div style={{ width: '16px', height: '2px', backgroundColor: 'white', borderRadius: '1px' }} />
                      </div>
                    </div>
                  );
                })}

                  {/* Running timer indicator */}
                  {timerRunning && timerStartTime && day.isToday && (() => {
                    const startDate = new Date(timerStartTime);
                    const now = new Date(currentTime);
                    
                    // Check if timer started on a previous day (midnight rollover)
                    const timerStartDay = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
                    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                    const startedOnPreviousDay = timerStartDay < today;
                    
                    // If timer started on previous day, show it starting from midnight (00:00)
                    const displayStartHour = startedOnPreviousDay ? 0 : startDate.getHours();
                    const displayStartMin = startedOnPreviousDay ? 0 : startDate.getMinutes();
                    const startMinutes = displayStartHour * 60 + displayStartMin;

                    const endHour = now.getHours();
                    const endMin = now.getMinutes();
                    const endMinutes = endHour * 60 + endMin;

                    const duration = endMinutes - startMinutes;
                    const top = (startMinutes / 60) * rowHeight;
                    const height = Math.max((duration / 60) * rowHeight, 30);

                    const timerProject = projects?.find((p: any) => p.id === currentEntry?.projectId);

                    return (
                      <div
                        key="running-timer"
                        onClick={handleTimerClick}
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
                          zIndex: 11,
                          border: '2px solid #ff5252',
                          animation: draggingTimer ? 'none' : 'pulse 2s ease-in-out infinite',
                          pointerEvents: 'auto',
                          cursor: draggingTimer ? 'grabbing' : 'pointer'
                        }}
                      >
                        {/* Draggable handle at the top */}
                        <div
                          onMouseDown={(e) => {
                            e.stopPropagation(); // Prevent click event when dragging
                            const dayContainer = e.currentTarget.closest('[data-day-container]') as HTMLElement;
                            if (dayContainer) {
                              handleTimerDragStart(e, dayContainer);
                            }
                          }}
                          onClick={(e) => e.stopPropagation()} // Prevent click when clicking handle
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            height: '12px',
                            cursor: 'grab',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: 'rgba(255, 255, 255, 0.2)',
                            borderTopLeftRadius: '4px',
                            borderTopRightRadius: '4px',
                            zIndex: 12
                          }}
                          title="Drag to adjust start time"
                        >
                          <div style={{ 
                            width: '40px', 
                            height: '3px', 
                            backgroundColor: 'white', 
                            borderRadius: '2px',
                            opacity: 0.8
                          }} />
                        </div>
                        
                        {/* Timer icon + Description (main text) */}
                        <div style={{ 
                          fontWeight: '600', 
                          display: 'flex', 
                          alignItems: 'center', 
                          gap: '4px', 
                          fontSize: '11px', 
                          marginTop: '12px',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis'
                        }}>
                          <span style={{ fontSize: '10px', flexShrink: 0 }}>⏱️</span>
                          <span style={{ 
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}>
                            {currentEntry?.description || 'Timer Running'}
                          </span>
              </div>
                        
                        {/* Project name */}
                        <div style={{ fontSize: '10px', marginTop: '2px', opacity: 0.9 }}>
                          {timerProject?.name || '(No Project)'}
          </div>
                        
                        {/* Time range (only if there's space) */}
                        {height > 45 && (
                          <div style={{ fontSize: '10px', marginTop: '2px', opacity: 0.8 }}>
                            {startedOnPreviousDay ? '(prev day) ' : ''}
                            {String(displayStartHour).padStart(2, '0')}:{String(displayStartMin).padStart(2, '0')} - Now
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
      )}

      {/* Time Entry Modal */}
      {showTimeEntryModal && selectedSlot && !(viewUserId && isAdmin) && (
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
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setModalMouseDownPos({ x: e.clientX, y: e.clientY });
            }
          }}
          onMouseUp={(e) => {
            if (e.target === e.currentTarget && modalMouseDownPos) {
              const moved = Math.abs(e.clientX - modalMouseDownPos.x) > 5 || Math.abs(e.clientY - modalMouseDownPos.y) > 5;
              if (!moved) {
                setShowTimeEntryModal(false);
              }
              setModalMouseDownPos(null);
            }
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
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
              <h3 style={{ marginBottom: '20px' }}>Add Time Entry</h3>

              {/* 1. Description input */}
              <div className="form-group" style={{ marginBottom: '20px' }}>
                <label className="label">Description</label>
                <textarea
                  placeholder="What are you working on?"
                  value={newEntry.description}
                  onChange={(e) => setNewEntry({ ...newEntry, description: e.target.value })}
                  style={{
                    width: '100%',
                    minHeight: '80px',
                    padding: '12px',
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    color: 'var(--text-primary)',
                    fontSize: '14px',
                    resize: 'none',
                  }}
                />
              </div>

              {/* 2. Time inputs */}
              <div className="form-group" style={{ marginBottom: '20px' }}>
                <label className="label">Time</label>
                <div style={{ display: 'flex', gap: '15px', alignItems: 'center' }}>
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
                      const startMinutes = startH * 60 + startM;
                      const endMinutes = endH * 60 + endM;
                      
                      // Handle overnight entries (end time is earlier than start time)
                      let hours;
                      if (endMinutes < startMinutes) {
                        hours = (endMinutes + 24 * 60 - startMinutes) / 60;
                      } else {
                        hours = (endMinutes - startMinutes) / 60;
                      }
                      
                      hours = Math.max(0, Math.min(24, hours));
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
                    {(() => {
                      const [startH, startM] = selectedSlot.startTime.split(':').map(Number);
                      const [endH, endM] = selectedSlot.endTime.split(':').map(Number);
                      const isOvernight = (endH * 60 + endM) < (startH * 60 + startM);
                      return isOvernight ? <span style={{ color: '#ff9800', marginLeft: '4px', fontSize: '11px' }}>(+1 day)</span> : null;
                    })()}
                  </div>
                </div>
              </div>

              {/* 3. Customer select (searchable) */}
              <div className="form-group" style={{ marginBottom: '20px' }}>
                <label className="label">Customer</label>
                <SearchableSelect
                  options={customers?.map((customer: any) => ({
                    value: customer.id,
                    label: customer.name,
                  })) || []}
                  value={newEntry.customer_id}
                  onChange={(customerId) => {
                    // No customer = no project, Internal rate type
                    if (!customerId) {
                      setNewEntry(prev => ({ 
                        ...prev, 
                        customer_id: '',
                        project_id: '',
                        location: '',
                        rate_type: 'Internal',
                        billable: false
                      }));
                    } else {
                      // Customer selected = billable work, clear project when customer changes
                      setNewEntry(prev => ({ 
                        ...prev, 
                        customer_id: customerId,
                        project_id: '',
                        location: '',
                        rate_type: 'Shop Time',
                        billable: true
                      }));
                    }
                  }}
                  placeholder="Search customers..."
                  emptyOption={{ value: '', label: 'No Customer (Internal)' }}
                />
              </div>

              {/* 4. Project select (only shown when customer is selected, searchable, with color indicator) */}
              {newEntry.customer_id && (
                <div className="form-group" style={{ marginBottom: '20px' }}>
                  <label className="label">Project</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{
                      backgroundColor: projects?.find((p: any) => p.id === newEntry.project_id)?.color || '#666',
                      width: '14px',
                      height: '14px',
                      borderRadius: '50%',
                      flexShrink: 0,
                    }} />
                    <div style={{ flex: 1 }}>
                      <SearchableSelect
                        key={`new-project-select-${newEntry.customer_id}`}
                        options={projects
                          ?.filter((project: any) => project.customer_id === newEntry.customer_id)
                          .map((project: any) => ({
                            value: project.id,
                            label: project.name,
                          })) || []}
                        value={newEntry.project_id}
                        onChange={async (projectId) => {
                          setNewEntry(prev => ({ ...prev, project_id: projectId }));
                          
                          if (!projectId) {
                            setNewEntry(prev => ({ ...prev, location: '' }));
                            return;
                          }
                          
                          // Try to get the last used location for this user and project
                          if (user?.id) {
                            const lastLocation = await timeEntriesService.getLastLocation(user.id, projectId);
                            if (lastLocation) {
                              setNewEntry(prev => ({ ...prev, location: lastLocation }));
                              return;
                            }
                          }
                          
                          // Fallback to project default location
                          const selectedProject = projects?.find((p: any) => p.id === projectId);
                          setNewEntry(prev => ({ 
                            ...prev, 
                            location: selectedProject?.location || ''
                          }));
                        }}
                        placeholder="Search projects..."
                        emptyOption={{ value: '', label: 'No Project' }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* 5. Location input (only shown when customer is selected - for service tickets) */}
              {newEntry.customer_id && (
                <div className="form-group" style={{ marginBottom: '20px' }}>
                  <label className="label">Location</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="Work location (e.g., Site A, Building 3)"
                    value={newEntry.location}
                    onChange={(e) => setNewEntry({ ...newEntry, location: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '10px',
                      backgroundColor: 'var(--bg-primary)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      color: 'var(--text-primary)',
                    }}
                  />
                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px', display: 'block' }}>
                    Different locations create separate service tickets
                  </span>
                </div>
              )}

              {/* 6. Rate Type dropdown - only shown when customer selected (otherwise Internal) */}
              {!isPanelShop && newEntry.customer_id && (
                <div className="form-group" style={{ marginBottom: '20px' }}>
                  <label className="label">Rate Type</label>
                  <select
                    className="input"
                    value={newEntry.rate_type}
                    onChange={(e) => {
                      const rateType = e.target.value;
                      // Internal = not billable, everything else = billable
                      const isBillable = rateType !== 'Internal';
                      setNewEntry({ ...newEntry, rate_type: rateType, billable: isBillable });
                    }}
                    style={{
                      width: '100%',
                      padding: '10px',
                      backgroundColor: 'var(--bg-primary)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <option value="Internal">Internal</option>
                    <option value="Shop Time">Shop Time</option>
                    <option value="Shop Overtime">Shop Overtime</option>
                    <option value="Travel Time">Travel Time</option>
                    <option value="Field Time">Field Time</option>
                    <option value="Field Overtime">Field Overtime</option>
                  </select>
                </div>
              )}

              {/* Add button */}
              <button
                className="button button-primary"
                onClick={handleSubmitTimeEntry}
                disabled={createTimeEntryMutation.isPending}
                style={{
                  width: '100%',
                  padding: '12px',
                  backgroundColor: '#dc2626',
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

      {/* Edit Time Entry Modal */}
      {showEditModal && editingEntry && !(viewUserId && isAdmin) && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setModalMouseDownPos({ x: e.clientX, y: e.clientY });
            }
          }}
          onMouseUp={(e) => {
            if (e.target === e.currentTarget && modalMouseDownPos) {
              const moved = Math.abs(e.clientX - modalMouseDownPos.x) > 5 || Math.abs(e.clientY - modalMouseDownPos.y) > 5;
              if (!moved) {
                setShowEditModal(false);
              }
              setModalMouseDownPos(null);
            }
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div
            style={{
              backgroundColor: 'var(--bg-secondary)',
              borderRadius: '12px',
              padding: '25px',
              width: '500px',
              maxWidth: '90%',
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
              border: '1px solid var(--border-color)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div style={{ 
              display: 'flex', 
              justifyContent: 'space-between', 
              alignItems: 'center', 
              marginBottom: '20px',
              borderBottom: '1px solid var(--border-color)',
              paddingBottom: '15px',
            }}>
              <div>
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '5px' }}>
                  {editingEntry.isRunningTimer 
                    ? 'Running Timer'
                    : new Date(editingEntry.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                </div>
                {editingEntry.isRunningTimer && (
                  <div style={{ fontSize: '11px', color: '#ff6b6b', fontWeight: '600' }}>
                    ⏱️ Timer is currently running
                  </div>
                )}
              </div>
              <button
                onClick={() => setShowEditModal(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '24px',
                  cursor: 'pointer',
                  color: 'var(--text-secondary)',
                  padding: '0',
                  width: '30px',
                  height: '30px',
                }}
              >
                ✕
              </button>
            </div>

            <div>
              {/* 1. Description input */}
              <div className="form-group" style={{ marginBottom: '20px' }}>
                <label className="label">Description</label>
                <textarea
                  placeholder="What are you working on?"
                  value={editedEntry.description}
                  onChange={(e) => setEditedEntry({ ...editedEntry, description: e.target.value })}
                  style={{
                    width: '100%',
                    minHeight: '80px',
                    padding: '12px',
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    color: 'var(--text-primary)',
                    fontSize: '14px',
                    resize: 'none',
                  }}
                />
              </div>

              {/* 2. Time inputs */}
              <div className="form-group" style={{ marginBottom: '20px' }}>
                <label className="label">Time</label>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <input
                    type="time"
                    value={editedEntry.start_time}
                    onChange={(e) => {
                      setEditedEntry({ ...editedEntry, start_time: e.target.value });
                      // Recalculate hours
                      if (editedEntry.end_time) {
                        const [startH, startM] = e.target.value.split(':').map(Number);
                        const [endH, endM] = editedEntry.end_time.split(':').map(Number);
                        const hours = (endH * 60 + endM - (startH * 60 + startM)) / 60;
                        setEditedEntry({ ...editedEntry, start_time: e.target.value, hours });
                      }
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
                  <span style={{ color: 'var(--text-secondary)' }}>→</span>
                  <input
                    type="time"
                    value={editedEntry.end_time}
                    onChange={(e) => {
                      // Don't allow changing end time for running timer
                      if (editingEntry.isRunningTimer) return;
                      setEditedEntry({ ...editedEntry, end_time: e.target.value });
                      // Recalculate hours
                      if (editedEntry.start_time) {
                        const [startH, startM] = editedEntry.start_time.split(':').map(Number);
                        const [endH, endM] = e.target.value.split(':').map(Number);
                        const hours = (endH * 60 + endM - (startH * 60 + startM)) / 60;
                        setEditedEntry({ ...editedEntry, end_time: e.target.value, hours });
                      }
                    }}
                    disabled={editingEntry.isRunningTimer}
                    style={{
                      padding: '10px',
                      backgroundColor: editingEntry.isRunningTimer ? 'var(--bg-secondary)' : 'var(--bg-primary)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      color: editingEntry.isRunningTimer ? 'var(--text-secondary)' : 'var(--text-primary)',
                      fontSize: '14px',
                      cursor: editingEntry.isRunningTimer ? 'not-allowed' : 'text',
                    }}
                    title={editingEntry.isRunningTimer ? 'End time updates automatically while timer is running' : ''}
                  />
                  <div
                    style={{
                      padding: '10px 15px',
                      backgroundColor: 'var(--bg-primary)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      fontSize: '14px',
                      color: 'var(--text-primary)',
                      minWidth: '70px',
                      textAlign: 'center',
                    }}
                  >
                    {editedEntry.hours.toFixed(2)}h
                  </div>
                </div>
              </div>

              {/* 3. Customer select (searchable) */}
              <div className="form-group" style={{ marginBottom: '20px' }}>
                <label className="label">Customer</label>
                <SearchableSelect
                  options={customers?.map((customer: any) => ({
                    value: customer.id,
                    label: customer.name,
                  })) || []}
                  value={editedEntry.customer_id}
                  onChange={(customerId) => {
                    // No customer = no project, Internal rate type
                    if (!customerId) {
                      setEditedEntry(prev => ({ 
                        ...prev, 
                        customer_id: '',
                        project_id: '',
                        location: '',
                        rate_type: 'Internal',
                        billable: false
                      }));
                    } else {
                      // Customer selected = billable work, clear project when customer changes
                      setEditedEntry(prev => {
                        const newRateType = prev.rate_type === 'Internal' ? 'Shop Time' : prev.rate_type;
                        return { 
                          ...prev, 
                          customer_id: customerId,
                          project_id: '',
                          location: '',
                          rate_type: newRateType,
                          billable: newRateType !== 'Internal'
                        };
                      });
                    }
                  }}
                  placeholder="Search customers..."
                  emptyOption={{ value: '', label: 'No Customer (Internal)' }}
                />
              </div>

              {/* 4. Project select (searchable, with color indicator) - only when customer selected */}
              {editedEntry.customer_id && (
                <div className="form-group" style={{ marginBottom: '20px' }}>
                  <label className="label">Project</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{
                      backgroundColor: projects?.find((p: any) => p.id === editedEntry.project_id)?.color || '#666',
                      width: '14px',
                      height: '14px',
                      borderRadius: '50%',
                      flexShrink: 0,
                    }} />
                    <div style={{ flex: 1 }}>
                      <SearchableSelect
                        key={`project-select-${editedEntry.customer_id}`}
                        options={projects
                          ?.filter((project: any) => project.customer_id === editedEntry.customer_id)
                          .map((project: any) => ({
                            value: project.id,
                            label: project.name,
                          })) || []}
                        value={editedEntry.project_id}
                        onChange={async (projectId) => {
                          setEditedEntry(prev => ({ ...prev, project_id: projectId }));
                          
                          if (!projectId) {
                            setEditedEntry(prev => ({ ...prev, location: '' }));
                            return;
                          }
                          
                          // Try to get the last used location for this user and project
                          if (user?.id) {
                            const lastLocation = await timeEntriesService.getLastLocation(user.id, projectId);
                            if (lastLocation) {
                              setEditedEntry(prev => ({ ...prev, location: lastLocation }));
                              return;
                            }
                          }
                          
                          // Fallback to project default location
                          const selectedProject = projects?.find((p: any) => p.id === projectId);
                          setEditedEntry(prev => ({
                            ...prev,
                            location: selectedProject?.location || ''
                          }));
                        }}
                        placeholder="Search projects..."
                        emptyOption={{ value: '', label: 'No Project' }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* 5. Location input - only when customer selected */}
              {editedEntry.customer_id && (
                <div className="form-group" style={{ marginBottom: '20px' }}>
                  <label className="label">Location</label>
                  <input
                    type="text"
                    placeholder="Work location (e.g., Site A, Building 3)"
                    value={editedEntry.location}
                    onChange={(e) => setEditedEntry({ ...editedEntry, location: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '10px',
                      backgroundColor: 'var(--bg-primary)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      color: 'var(--text-primary)',
                      fontSize: '14px',
                    }}
                  />
                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px', display: 'block' }}>
                    Different locations create separate service tickets
                  </span>
                </div>
              )}

              {/* 6. Rate Type dropdown - only when customer selected, hidden for Panel Shop */}
              {!isPanelShop && editedEntry.customer_id && (
                <div className="form-group" style={{ marginBottom: '20px' }}>
                  <label className="label">Rate Type</label>
                  <select
                    className="input"
                    value={editedEntry.rate_type}
                    onChange={(e) => {
                      const rateType = e.target.value;
                      // Internal = not billable, everything else = billable
                      const isBillable = rateType !== 'Internal';
                      setEditedEntry({ ...editedEntry, rate_type: rateType, billable: isBillable });
                    }}
                    style={{
                      width: '100%',
                      padding: '10px',
                      backgroundColor: 'var(--bg-primary)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      color: 'var(--text-primary)',
                      fontSize: '14px',
                    }}
                  >
                    <option value="Internal">Internal</option>
                    <option value="Shop Time">Shop Time</option>
                    <option value="Shop Overtime">Shop Overtime</option>
                    <option value="Travel Time">Travel Time</option>
                    <option value="Field Time">Field Time</option>
                    <option value="Field Overtime">Field Overtime</option>
                  </select>
                </div>
              )}

              {/* Action buttons */}
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  className="button button-primary"
                  onClick={handleSaveEdit}
                  disabled={updateTimeEntryMutation.isPending}
                  style={{
                    flex: 1,
                    padding: '12px',
                    backgroundColor: '#dc2626',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '15px',
                    fontWeight: '600',
                    cursor: 'pointer',
                  }}
                >
                  {updateTimeEntryMutation.isPending ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={handleDeleteEntry}
                  disabled={deleteTimeEntryMutation.isPending}
                  style={{
                    padding: '12px 20px',
                    backgroundColor: 'transparent',
                    color: '#ff6b6b',
                    border: '1px solid #ff6b6b',
                    borderRadius: '6px',
                    fontSize: '15px',
                    fontWeight: '600',
                    cursor: 'pointer',
                  }}
                  title={editingEntry.isRunningTimer ? 'Stop timer' : 'Delete entry'}
                >
                  {editingEntry.isRunningTimer ? '⏹️' : (deleteTimeEntryMutation.isPending ? '...' : '🗑️')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
