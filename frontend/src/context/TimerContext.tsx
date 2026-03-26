import { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { useAuth } from './AuthContext';

interface TimerContextType {
  timerRunning: boolean;
  timerDisplay: string;
  timerStartTime: number | null;
  currentEntry: { description: string; projectId?: string; projectName?: string } | null;
  startTimer: (description: string, projectId?: string) => void;
  stopTimer: () => void;
  updateStartTime: (newStartTime: number) => void;
  updateTimerEntry: (description: string, projectId?: string, projectName?: string) => void;
}

const TimerContext = createContext<TimerContextType | undefined>(undefined);

export const useTimer = () => {
  const context = useContext(TimerContext);
  if (!context) {
    throw new Error('useTimer must be used within a TimerProvider');
  }
  return context;
};

export const TimerProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerDisplay, setTimerDisplay] = useState('0:00:00');
  const [currentEntry, setCurrentEntry] = useState<{ description: string; projectId?: string; projectName?: string } | null>(null);
  const timerStartTimeRef = useRef<number | null>(null);
  const timerElapsedRef = useRef<number>(0);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const currentUserIdRef = useRef<string | null>(null);

  // Get user-specific localStorage key
  const getTimerStorageKey = (userId: string | null) => {
    if (!userId) return null;
    return `timerState_${userId}`;
  };

  // Update timer display every 100ms when running
  useEffect(() => {
    if (timerRunning && timerStartTimeRef.current) {
      timerIntervalRef.current = setInterval(() => {
        const currentElapsed = timerElapsedRef.current + (Date.now() - timerStartTimeRef.current!);
        const totalSeconds = Math.floor(currentElapsed / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        setTimerDisplay(`${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`);
      }, 100);
    } else {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    }

    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    };
  }, [timerRunning]);

  // Clear timer state when user changes
  useEffect(() => {
    // If user changed, clear the timer state
    if (currentUserIdRef.current !== null && currentUserIdRef.current !== user?.id) {
      console.log('🔄 TimerContext: User changed, clearing timer state');
      setTimerRunning(false);
      setTimerDisplay('0:00:00');
      setCurrentEntry(null);
      timerStartTimeRef.current = null;
      timerElapsedRef.current = 0;
    }
    currentUserIdRef.current = user?.id || null;
  }, [user?.id]);

  // Load timer state from localStorage for current user
  useEffect(() => {
    if (!user?.id) {
      // No user logged in, clear timer
      setTimerRunning(false);
      setCurrentEntry(null);
      timerStartTimeRef.current = null;
      timerElapsedRef.current = 0;
      return;
    }

    const storageKey = getTimerStorageKey(user.id);
    if (!storageKey) return;

    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        const { startTime, description, projectId, projectName, elapsed } = JSON.parse(saved);
        timerStartTimeRef.current = startTime;
        timerElapsedRef.current = elapsed || 0;
        setCurrentEntry({ description, projectId, projectName });
        setTimerRunning(true);
        console.log('✅ TimerContext: Loaded timer state for user', user.id);
      } catch (error) {
        console.error('❌ TimerContext: Error loading timer state', error);
        localStorage.removeItem(storageKey);
      }
    }
  }, [user?.id]);

  // Save timer state to localStorage when it changes (user-specific)
  useEffect(() => {
    if (!user?.id) return;

    const storageKey = getTimerStorageKey(user.id);
    if (!storageKey) return;

    if (timerRunning && currentEntry) {
      localStorage.setItem(storageKey, JSON.stringify({
        startTime: timerStartTimeRef.current,
        description: currentEntry.description,
        projectId: currentEntry.projectId,
        projectName: currentEntry.projectName,
        elapsed: timerElapsedRef.current,
      }));
    } else {
      localStorage.removeItem(storageKey);
    }
  }, [timerRunning, currentEntry, user?.id]);

  const startTimer = (description: string, projectId?: string) => {
    timerStartTimeRef.current = Date.now();
    timerElapsedRef.current = 0;
    setCurrentEntry({ description, projectId });
    setTimerRunning(true);
    setTimerDisplay('0:00:00');
  };

  const stopTimer = () => {
    setTimerRunning(false);
    setTimerDisplay('0:00:00');
    setCurrentEntry(null);
    timerStartTimeRef.current = null;
    timerElapsedRef.current = 0;
  };

  const updateStartTime = (newStartTime: number) => {
    if (timerRunning && timerStartTimeRef.current) {
      // When adjusting start time by dragging, we're changing when the current session started
      // Reset elapsed to 0 so the timer calculates from the new start time
      timerElapsedRef.current = 0;
      timerStartTimeRef.current = newStartTime;
    }
  };

  const updateTimerEntry = (description: string, projectId?: string, projectName?: string) => {
    if (timerRunning && currentEntry) {
      setCurrentEntry({ description, projectId, projectName });
    }
  };

  return (
    <TimerContext.Provider
      value={{
        timerRunning,
        timerDisplay,
        timerStartTime: timerStartTimeRef.current,
        currentEntry,
        startTimer,
        stopTimer,
        updateStartTime,
        updateTimerEntry,
      }}
    >
      {children}
    </TimerContext.Provider>
  );
};






