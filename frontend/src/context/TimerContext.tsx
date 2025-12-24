import { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';

interface TimerContextType {
  timerRunning: boolean;
  timerDisplay: string;
  timerStartTime: number | null;
  currentEntry: { description: string; projectId?: string; projectName?: string } | null;
  startTimer: (description: string, projectId?: string) => void;
  stopTimer: () => void;
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
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerDisplay, setTimerDisplay] = useState('0:00:00');
  const [currentEntry, setCurrentEntry] = useState<{ description: string; projectId?: string; projectName?: string } | null>(null);
  const timerStartTimeRef = useRef<number | null>(null);
  const timerElapsedRef = useRef<number>(0);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

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

  // Load timer state from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('timerState');
    if (saved) {
      const { startTime, description, projectId, projectName, elapsed } = JSON.parse(saved);
      timerStartTimeRef.current = startTime;
      timerElapsedRef.current = elapsed || 0;
      setCurrentEntry({ description, projectId, projectName });
      setTimerRunning(true);
    }
  }, []);

  // Save timer state to localStorage when it changes
  useEffect(() => {
    if (timerRunning && currentEntry) {
      localStorage.setItem('timerState', JSON.stringify({
        startTime: timerStartTimeRef.current,
        description: currentEntry.description,
        projectId: currentEntry.projectId,
        projectName: currentEntry.projectName,
        elapsed: timerElapsedRef.current,
      }));
    } else {
      localStorage.removeItem('timerState');
    }
  }, [timerRunning, currentEntry]);

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

  return (
    <TimerContext.Provider
      value={{
        timerRunning,
        timerDisplay,
        timerStartTime: timerStartTimeRef.current,
        currentEntry,
        startTimer,
        stopTimer,
      }}
    >
      {children}
    </TimerContext.Provider>
  );
};

