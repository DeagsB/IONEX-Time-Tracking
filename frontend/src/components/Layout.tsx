import { Outlet, useNavigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';

export default function Layout() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerDisplay, setTimerDisplay] = useState('0:00:00');
  const [currentEntry, setCurrentEntry] = useState<{ description: string; projectId?: string; projectName?: string } | null>(null);
  const timerStartTimeRef = useRef<number | null>(null);
  const timerElapsedRef = useRef<number>(0);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

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

  const handleTimerStart = (description: string, projectId?: string) => {
    // If already running, this shouldn't happen, but handle it
    if (timerRunning) {
      return;
    }
    
    // Start fresh timer (reset elapsed if starting new)
    timerElapsedRef.current = 0;
    timerStartTimeRef.current = Date.now();
    setTimerRunning(true);
    setTimerDisplay('0:00:00');
    
    // Store entry info
    setCurrentEntry({
      description,
      projectId,
    });
  };

  const handleTimerStop = () => {
    if (timerStartTimeRef.current) {
      timerElapsedRef.current += Date.now() - timerStartTimeRef.current;
    }
    
    setTimerRunning(false);
    timerStartTimeRef.current = null;
    // Don't reset elapsed here - Header will handle that after saving
  };

  const handleLogout = () => {
    // Stop timer if running
    if (timerRunning) {
      handleTimerStop();
    }
    logout();
    navigate('/login');
  };

  // Save timer state to localStorage
  useEffect(() => {
    if (timerRunning && timerStartTimeRef.current) {
      const timerState = {
        running: timerRunning,
        elapsed: timerElapsedRef.current,
        entry: currentEntry,
        startTime: timerStartTimeRef.current,
      };
      localStorage.setItem('timerState', JSON.stringify(timerState));
    } else if (!timerRunning) {
      // Reset when stopped
      timerElapsedRef.current = 0;
      setTimerDisplay('0:00:00');
      setCurrentEntry(null);
      localStorage.removeItem('timerState');
    }
  }, [timerRunning, currentEntry]);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: 'var(--bg-secondary)' }}>
      <Sidebar />
      <div style={{ marginLeft: '240px', width: 'calc(100% - 240px)', paddingTop: '60px' }}>
        <Header 
          onTimerStart={handleTimerStart}
          onTimerStop={handleTimerStop}
          timerRunning={timerRunning}
          timerDisplay={timerDisplay}
          currentEntry={currentEntry}
          timerStartTime={timerStartTimeRef.current}
        />
        <div style={{ padding: '20px' }}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
