import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import { useTimer } from '../context/TimerContext';

export default function Layout() {
  const { timerRunning, timerDisplay, timerStartTime, currentEntry, startTimer, stopTimer } = useTimer();

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: 'var(--bg-secondary)' }}>
      <Sidebar />
      <div style={{ marginLeft: '240px', width: 'calc(100% - 240px)', paddingTop: '60px' }}>
        <Header 
          onTimerStart={startTimer}
          onTimerStop={stopTimer}
          timerRunning={timerRunning}
          timerDisplay={timerDisplay}
          currentEntry={currentEntry}
          timerStartTime={timerStartTime}
        />
        <div style={{ padding: '20px' }}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
