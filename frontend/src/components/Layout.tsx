import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import { useTimer } from '../context/TimerContext';

export default function Layout() {
  const { timerRunning, timerDisplay, timerStartTime, currentEntry, startTimer, stopTimer } = useTimer();
  const location = useLocation();
  const isCalendar = location.pathname === '/calendar' || location.pathname.startsWith('/calendar/');

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', backgroundColor: 'var(--bg-secondary)' }}>
      <Sidebar />
      <div style={{
        marginLeft: '240px',
        width: 'calc(100% - 240px)',
        height: '100vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <Header 
          onTimerStart={startTimer}
          onTimerStop={stopTimer}
          timerRunning={timerRunning}
          timerDisplay={timerDisplay}
          currentEntry={currentEntry}
          timerStartTime={timerStartTime}
        />
        <div style={{
          flex: 1,
          minHeight: 0,
          overflow: isCalendar ? 'hidden' : 'auto',
          padding: isCalendar ? 0 : '20px',
        }}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
