import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';
import { timeEntriesService, projectsService, serviceTicketsService } from '../services/supabaseServices';
import { getEntryHoursOnDate } from '../utils/timeEntryUtils';

interface TimeEntry {
  id: string;
  date?: string;
  project_id?: string;
  start_time?: string;
  end_time?: string;
  hours: number;
  rate: number;
  billable: boolean;
  description?: string;
  project?: any;
}

interface DragState {
  isDragging: boolean;
  draggedEntryId: string | null;
  startHour: number | null;
}

interface MarqueeState {
  isSelecting: boolean;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

export default function DayDetail() {
  const { date } = useParams<{ date: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isDemoMode } = useDemoMode();
  const queryClient = useQueryClient();
  
  const [selectedDate] = useState(date ? new Date(date) : new Date());
  
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null);
  const [showEntryForm, setShowEntryForm] = useState(false);
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const [selectedEntries, setSelectedEntries] = useState<Set<string>>(new Set());
  const [dragState, setDragState] = useState<DragState>({
    isDragging: false,
    draggedEntryId: null,
    startHour: null,
  });
  const [dropTargetHour, setDropTargetHour] = useState<number | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState>({
    isSelecting: false,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
  });
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const entryRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [formData, setFormData] = useState({
    project_id: '',
    hours: '1',
    description: '',
    start_time: '',
    end_time: '',
  });

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => projectsService.getAll(),
  });

  const { data: timeEntries } = useQuery({
    queryKey: ['timeEntries', 'day', date, user?.id],
    queryFn: async () => {
      const entries = await timeEntriesService.getAll(undefined, user?.id);
      if (!date || !entries) return [];
      // Include entries that have any hours on this date (overnight rollover from previous day)
      return entries.filter((entry: any) => getEntryHoursOnDate(entry, date) > 0);
    },
  });

  const createEntryMutation = useMutation({
    mutationFn: async (data: any) => {
      if (!user) throw new Error("No user");
      
      const entryData: any = {
        user_id: user.id,
        project_id: data.project_id || null,
        date: date,
        start_time: data.start_time || null,
        end_time: data.end_time || null,
        hours: parseFloat(data.hours),
        rate: 0, // Should fetch project rate
        billable: true,
        description: data.description || null,
        is_demo: isDemoMode, // Mark as demo entry if in demo mode
      };
      
      // Get project rate if project selected
      if (data.project_id && projects) {
        const project = projects.find((p: any) => p.id === data.project_id);
        if (project) entryData.rate = project.rate;
      }
      
      return await timeEntriesService.create(entryData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
      setShowEntryForm(false);
      resetForm();
    },
  });

  const updateEntryMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      return await timeEntriesService.update(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
      setEditingEntry(null);
      resetForm();
    },
  });

  const deleteEntryMutation = useMutation({
    mutationFn: async (payload: { id: string; entry?: any }) => {
      const { id, entry } = payload;
      await timeEntriesService.delete(id);
      if (entry?.project_id && entry?.project?.customer?.id) {
        const dateStr = typeof entry.date === 'string' ? entry.date : new Date(entry.date).toISOString().split('T')[0];
        await serviceTicketsService.deleteTicketIfNoTimeEntriesFor({
          date: dateStr,
          userId: entry.user_id,
          customerId: entry.project.customer.id,
          projectId: entry.project_id,
          location: entry.location,
          approver: entry.approver,
          po_afe: entry.po_afe,
          cc: (entry as any).cc,
        }, isDemoMode);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
      queryClient.invalidateQueries({ queryKey: ['billableEntries'] });
      queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
    },
  });

  const bulkMoveMutation = useMutation({
    mutationFn: async ({ entryIds, hourOffset }: { entryIds: string[]; hourOffset: number }) => {
      // Move entries by adjusting their start_time and end_time
      const updates = [];
      for (const entryId of entryIds) {
        const entry = timeEntries?.find((e: any) => e.id === entryId);
        if (!entry) continue;
        
        const updateData: any = {};
        
        if (entry.start_time) {
          const newStart = new Date(entry.start_time);
          newStart.setHours(newStart.getHours() + hourOffset);
          updateData.start_time = newStart.toISOString();
        }
        if (entry.end_time) {
          const newEnd = new Date(entry.end_time);
          newEnd.setHours(newEnd.getHours() + hourOffset);
          updateData.end_time = newEnd.toISOString();
        }
        
        if (Object.keys(updateData).length > 0) {
          updates.push(timeEntriesService.update(entryId, updateData));
        }
      }
      return Promise.all(updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
      setSelectedEntries(new Set());
    },
  });

  const resetForm = () => {
    setFormData({
      project_id: '',
      hours: '1',
      description: '',
      start_time: '',
      end_time: '',
    });
    setEditingEntry(null);
    setSelectedHour(null);
  };

  // Selection handlers
  const clearSelection = () => {
    setSelectedEntries(new Set());
  };

  // Bulk delete handler
  const handleBulkDelete = async () => {
    setIsDeleting(true);
    const entriesToDelete = timeEntries?.filter((e: any) => selectedEntries.has(e.id)) || [];
    
    for (const entry of entriesToDelete) {
      try {
        await timeEntriesService.delete(entry.id);
        if (entry?.project_id && entry?.project?.customer?.id) {
          const dateStr = typeof entry.date === 'string' ? entry.date : new Date(entry.date).toISOString().split('T')[0];
          await serviceTicketsService.deleteTicketIfNoTimeEntriesFor({
            date: dateStr,
            userId: entry.user_id,
            customerId: entry.project.customer.id,
            projectId: entry.project_id,
            location: entry.location,
            approver: entry.approver,
            po_afe: entry.po_afe,
            cc: entry.cc,
          }, isDemoMode);
        }
      } catch (error) {
        console.error('Error deleting entry:', error);
      }
    }
    
    queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
    queryClient.invalidateQueries({ queryKey: ['billableEntries'] });
    queryClient.invalidateQueries({ queryKey: ['existingServiceTickets'] });
    setSelectedEntries(new Set());
    setShowBulkDeleteConfirm(false);
    setIsDeleting(false);
  };

  // Marquee selection handlers
  const handleMarqueeStart = (event: React.MouseEvent) => {
    // Only start marquee if clicking on empty space (not on an entry)
    if ((event.target as HTMLElement).closest('[data-entry-id]')) {
      return;
    }
    
    const gridRect = gridRef.current?.getBoundingClientRect();
    if (!gridRect) return;
    
    const x = event.clientX - gridRect.left;
    const y = event.clientY - gridRect.top + (gridRef.current?.scrollTop || 0);
    
    setMarquee({
      isSelecting: true,
      startX: x,
      startY: y,
      currentX: x,
      currentY: y,
    });
    
    // Clear previous selection when starting new marquee
    setSelectedEntries(new Set());
  };

  const handleMarqueeMove = (event: React.MouseEvent) => {
    if (!marquee.isSelecting) return;
    
    const gridRect = gridRef.current?.getBoundingClientRect();
    if (!gridRect) return;
    
    const x = event.clientX - gridRect.left;
    const y = event.clientY - gridRect.top + (gridRef.current?.scrollTop || 0);
    
    setMarquee(prev => ({
      ...prev,
      currentX: x,
      currentY: y,
    }));
    
    // Calculate which entries are within the marquee
    const marqueeRect = {
      left: Math.min(marquee.startX, x),
      right: Math.max(marquee.startX, x),
      top: Math.min(marquee.startY, y),
      bottom: Math.max(marquee.startY, y),
    };
    
    const newSelection = new Set<string>();
    
    entryRefs.current.forEach((element, entryId) => {
      const entryRect = element.getBoundingClientRect();
      const gridRect = gridRef.current?.getBoundingClientRect();
      if (!gridRect) return;
      
      // Convert entry rect to grid-relative coordinates
      const entryRelative = {
        left: entryRect.left - gridRect.left,
        right: entryRect.right - gridRect.left,
        top: entryRect.top - gridRect.top + (gridRef.current?.scrollTop || 0),
        bottom: entryRect.bottom - gridRect.top + (gridRef.current?.scrollTop || 0),
      };
      
      // Check if rectangles overlap
      const overlaps = !(
        entryRelative.right < marqueeRect.left ||
        entryRelative.left > marqueeRect.right ||
        entryRelative.bottom < marqueeRect.top ||
        entryRelative.top > marqueeRect.bottom
      );
      
      if (overlaps) {
        newSelection.add(entryId);
      }
    });
    
    setSelectedEntries(newSelection);
  };

  const handleMarqueeEnd = () => {
    setMarquee(prev => ({
      ...prev,
      isSelecting: false,
    }));
  };

  // Single entry click handler
  const handleEntryClick = (entryId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    // Single click just selects this one entry (for dragging)
    setSelectedEntries(new Set([entryId]));
  };

  // Drag handlers
  const handleDragStart = (entryId: string, hour: number, event: React.DragEvent) => {
    // If dragging an unselected entry, select it first
    if (!selectedEntries.has(entryId)) {
      setSelectedEntries(new Set([entryId]));
    }
    
    setDragState({
      isDragging: true,
      draggedEntryId: entryId,
      startHour: hour,
    });
    
    // Set drag data
    event.dataTransfer.setData('text/plain', entryId);
    event.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (hour: number, event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTargetHour(hour);
  };

  const handleDragLeave = () => {
    setDropTargetHour(null);
  };

  const handleDrop = (targetHour: number, event: React.DragEvent) => {
    event.preventDefault();
    setDropTargetHour(null);
    
    if (dragState.startHour === null) return;
    
    const hourOffset = targetHour - dragState.startHour;
    if (hourOffset === 0) {
      setDragState({ isDragging: false, draggedEntryId: null, startHour: null });
      return;
    }
    
    // Move all selected entries
    const entriesToMove = Array.from(selectedEntries);
    if (entriesToMove.length > 0) {
      bulkMoveMutation.mutate({ entryIds: entriesToMove, hourOffset });
    }
    
    setDragState({ isDragging: false, draggedEntryId: null, startHour: null });
  };

  const handleDragEnd = () => {
    setDragState({ isDragging: false, draggedEntryId: null, startHour: null });
    setDropTargetHour(null);
  };

  const handleHourClick = (hour: number) => {
    setSelectedHour(hour);
    const startTime = new Date(selectedDate);
    startTime.setHours(hour, 0, 0, 0);
    const endTime = new Date(startTime);
    endTime.setHours(hour + 1);

    setFormData({
      ...formData,
      start_time: startTime.toTimeString().slice(0, 5),
      end_time: endTime.toTimeString().slice(0, 5),
      hours: '1',
    });
    setShowEntryForm(true);
  };

  const handleEditEntry = (entry: any) => {
    setEditingEntry(entry);
    const startTime = entry.start_time ? new Date(entry.start_time) : null;
    const endTime = entry.end_time ? new Date(entry.end_time) : null;

    setFormData({
      project_id: entry.project_id || '',
      hours: entry.hours.toString(),
      description: entry.description || '',
      start_time: startTime ? startTime.toTimeString().slice(0, 5) : '',
      end_time: endTime ? endTime.toTimeString().slice(0, 5) : '',
    });
    setShowEntryForm(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Construct ISO strings for start/end times if provided
    let startTimeISO = null;
    let endTimeISO = null;
    
    if (formData.start_time) {
      const start = new Date(selectedDate);
      const [sh, sm] = formData.start_time.split(':').map(Number);
      start.setHours(sh, sm, 0, 0);
      startTimeISO = start.toISOString();
    }
    
    if (formData.end_time) {
      const end = new Date(selectedDate);
      const [eh, em] = formData.end_time.split(':').map(Number);
      end.setHours(eh, em, 0, 0);
      endTimeISO = end.toISOString();
    }

    const data: any = {
      project_id: formData.project_id,
      hours: formData.hours,
      description: formData.description,
      start_time: startTimeISO,
      end_time: endTimeISO,
    };

    // When editing, ensure the date is preserved to prevent entry from disappearing
    if (editingEntry) {
      // Preserve the original date to avoid timezone issues
      // Use entry date if available, otherwise use the date from URL params
      data.date = editingEntry.date || date;
      updateEntryMutation.mutate({ id: editingEntry.id, data });
    } else {
      createEntryMutation.mutate(data);
    }
  };

  const handleDelete = (entry: { id: string; date?: string; user_id?: string; project_id?: string; location?: string; approver?: string; po_afe?: string; cc?: string; project?: { customer?: { id: string } } }) => {
    if (window.confirm('Are you sure?')) {
      deleteEntryMutation.mutate({ id: entry.id, entry });
    }
  };

  // Whether an entry's slice on this date overlaps a given hour (for overnight rollover)
  const entrySliceOverlapsHour = (entry: any, dateStr: string, hour: number) => {
    if (!entry.start_time || !entry.end_time) {
      const entryHour = entry.start_time ? new Date(entry.start_time).getHours() : 0;
      return entry.date === dateStr && entryHour === hour;
    }
    const dayStart = new Date(dateStr + 'T00:00:00').getTime();
    const hourStartMs = dayStart + hour * 3600 * 1000;
    const hourEndMs = dayStart + (hour + 1) * 3600 * 1000;
    const startMs = new Date(entry.start_time).getTime();
    const endMs = new Date(entry.end_time).getTime();
    const overlapStart = Math.max(startMs, dayStart);
    const dayEnd = new Date(dateStr + 'T23:59:59.999').getTime();
    const overlapEnd = Math.min(endMs, dayEnd);
    return overlapStart < hourEndMs && overlapEnd > hourStartMs;
  };

  const hours = Array.from({ length: 24 }, (_, i) => i);

  return (
    <div style={{ height: 'calc(100vh - 100px)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <button 
            className="button"
            onClick={() => navigate('/calendar')}
          >
            ← Back to Week
          </button>
          <h2>
            {selectedDate.toLocaleDateString('en-US', { 
              weekday: 'long', 
              year: 'numeric', 
              month: 'long', 
              day: 'numeric' 
            })}
          </h2>
        </div>
        <button 
          className="button button-primary"
          onClick={() => {
            resetForm();
            setShowEntryForm(true);
          }}
        >
          Add Entry
        </button>
      </div>

      {/* Selection Bar */}
      {selectedEntries.size > 0 && (
        <div 
          style={{ 
            backgroundColor: 'rgba(40, 167, 69, 0.1)', 
            border: '1px solid #28a745',
            borderRadius: '4px',
            padding: '10px 15px',
            marginBottom: '15px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontWeight: 'bold', color: '#28a745' }}>
              {selectedEntries.size} {selectedEntries.size === 1 ? 'entry' : 'entries'} selected
            </span>
            <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
              Drag to move
            </span>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button 
              className="button button-danger"
              onClick={() => setShowBulkDeleteConfirm(true)}
              style={{ padding: '4px 12px' }}
            >
              Delete Selected
            </button>
            <button 
              className="button"
              onClick={clearSelection}
              style={{ padding: '4px 12px' }}
            >
              Clear
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '20px', flex: 1, minHeight: 0 }}>
        {/* Time Grid */}
        <div 
          ref={gridRef}
          className="card" 
          style={{ 
            flex: 1, 
            overflowY: 'auto', 
            padding: 0, 
            display: 'flex', 
            flexDirection: 'column',
            position: 'relative',
            userSelect: 'none',
          }}
          onMouseDown={handleMarqueeStart}
          onMouseMove={handleMarqueeMove}
          onMouseUp={handleMarqueeEnd}
          onMouseLeave={handleMarqueeEnd}
        >
          {/* Marquee Selection Box */}
          {marquee.isSelecting && (
            <div
              style={{
                position: 'absolute',
                left: Math.min(marquee.startX, marquee.currentX),
                top: Math.min(marquee.startY, marquee.currentY),
                width: Math.abs(marquee.currentX - marquee.startX),
                height: Math.abs(marquee.currentY - marquee.startY),
                backgroundColor: 'rgba(40, 167, 69, 0.2)',
                border: '2px dashed #28a745',
                pointerEvents: 'none',
                zIndex: 1000,
              }}
            />
          )}
          {hours.map((hour) => {
            const entriesForHour = timeEntries?.filter((entry: any) => date && entrySliceOverlapsHour(entry, date, hour)) || [];
            const isDropTarget = dropTargetHour === hour;
            
            return (
              <div 
                key={hour}
                style={{
                  height: '60px',
                  borderBottom: '1px solid var(--border-color)',
                  display: 'flex',
                  position: 'relative',
                  backgroundColor: isDropTarget ? 'rgba(40, 167, 69, 0.2)' : undefined,
                  transition: 'background-color 0.15s',
                }}
                onDragOver={(e) => handleDragOver(hour, e)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(hour, e)}
              >
                <div style={{
                  width: '60px',
                  borderRight: '1px solid var(--border-color)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  color: 'var(--text-secondary)',
                  flexShrink: 0,
                }}>
                  {hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`}
                </div>
                <div 
                  style={{ flex: 1, cursor: 'crosshair', position: 'relative' }}
                  onDoubleClick={() => {
                    // Double-click on empty space to create new entry
                    handleHourClick(hour);
                  }}
                >
                  {/* Render entries for this hour (include overnight rollover on this date) */}
                  {entriesForHour.map((entry: any, index: number) => {
                    const isSelected = selectedEntries.has(entry.id);
                    const isBeingDragged = dragState.isDragging && selectedEntries.has(entry.id);
                    
                    return (
                      <div
                        key={entry.id}
                        data-entry-id={entry.id}
                        ref={(el) => {
                          if (el) {
                            entryRefs.current.set(entry.id, el);
                          } else {
                            entryRefs.current.delete(entry.id);
                          }
                        }}
                        draggable
                        onDragStart={(e) => handleDragStart(entry.id, hour, e)}
                        onDragEnd={handleDragEnd}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          handleEntryClick(entry.id, e);
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          handleEditEntry(entry);
                        }}
                        style={{
                          position: 'absolute',
                          top: `${2 + index * 20}px`,
                          left: '65px',
                          right: '5px',
                          height: '52px',
                          backgroundColor: isSelected ? 'rgba(40, 167, 69, 0.3)' : 'var(--primary-light)',
                          border: isSelected ? '2px solid #28a745' : '1px solid var(--primary-color)',
                          borderRadius: '4px',
                          padding: '4px 8px',
                          fontSize: '12px',
                          overflow: 'hidden',
                          cursor: 'grab',
                          zIndex: isBeingDragged ? 100 : 10,
                          opacity: isBeingDragged ? 0.5 : 1,
                          userSelect: 'none',
                        }}
                      >
                        <strong>{entry.project?.name || 'No Project'}</strong>
                        {entry.description && <span style={{ marginLeft: '5px' }}>- {entry.description}</span>}
                        {isSelected && (
                          <span style={{ 
                            position: 'absolute', 
                            top: '2px', 
                            right: '4px', 
                            fontSize: '10px',
                            color: '#28a745',
                          }}>
                            ✓
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Entry Form Sidebar */}
        {showEntryForm && (
          <div className="card" style={{ width: '300px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
              <h3>{editingEntry ? 'Edit Entry' : 'New Entry'}</h3>
              <button 
                className="button" 
                style={{ padding: '4px 8px' }}
                onClick={() => {
                  setShowEntryForm(false);
                  resetForm();
                }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div className="form-group">
                <label className="label">Project</label>
                <select
                  className="input"
                  value={formData.project_id}
                  onChange={(e) => setFormData({ ...formData, project_id: e.target.value })}
                >
                  <option value="">Select Project</option>
                  {projects?.map((project: any) => (
                    <option key={project.id} value={project.id}>
                      {project.project_number ? `${project.project_number} - ${project.name}` : project.name}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div className="form-group">
                  <label className="label">Start</label>
                  <input
                    type="time"
                    className="input"
                    value={formData.start_time}
                    onChange={(e) => setFormData({ ...formData, start_time: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="label">End</label>
                  <input
                    type="time"
                    className="input"
                    value={formData.end_time}
                    onChange={(e) => setFormData({ ...formData, end_time: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="label">Hours</label>
                <input
                  type="number"
                  step="0.25"
                  className="input"
                  value={formData.hours}
                  onChange={(e) => setFormData({ ...formData, hours: e.target.value })}
                  required
                />
              </div>

              <div className="form-group">
                <label className="label">Description</label>
                <textarea
                  className="input"
                  rows={3}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                />
              </div>

              <div style={{ display: 'flex', gap: '10px', marginTop: 'auto' }}>
                <button type="submit" className="button button-primary" style={{ flex: 1 }}>
                  Save
                </button>
                {editingEntry && (
                  <button 
                    type="button" 
                    className="button button-danger"
                    onClick={() => handleDelete(editingEntry)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </form>
          </div>
        )}
      </div>

      {/* Bulk Delete Confirmation Modal */}
      {showBulkDeleteConfirm && selectedEntries.size > 0 && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
          }}
          onClick={() => setShowBulkDeleteConfirm(false)}
        >
          <div
            style={{
              backgroundColor: 'var(--card-bg)',
              borderRadius: '8px',
              padding: '24px',
              maxWidth: '400px',
              boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 16px', color: 'var(--text-primary)' }}>
              Delete {selectedEntries.size} {selectedEntries.size === 1 ? 'Entry' : 'Entries'}?
            </h3>
            <p style={{ margin: '0 0 20px', color: 'var(--text-secondary)', fontSize: '14px' }}>
              Are you sure you want to delete the selected time {selectedEntries.size === 1 ? 'entry' : 'entries'}? This action cannot be undone.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                className="button"
                onClick={() => setShowBulkDeleteConfirm(false)}
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                className="button button-danger"
                onClick={handleBulkDelete}
                disabled={isDeleting}
                style={{ cursor: isDeleting ? 'wait' : 'pointer' }}
              >
                {isDeleting ? 'Deleting...' : `Delete ${selectedEntries.size} ${selectedEntries.size === 1 ? 'Entry' : 'Entries'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
