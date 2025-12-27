import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { TimerProvider } from './context/TimerContext';
import Login from './pages/Login';
import AuthCallback from './pages/AuthCallback';
import Dashboard from './pages/Dashboard';
import WeekView from './pages/WeekView';
import TimeEntries from './pages/TimeEntries';
import DayDetail from './pages/DayDetail';
import Projects from './pages/Projects';
import Customers from './pages/Customers';
import Employees from './pages/Employees';
import Forms from './pages/Forms';
import Payroll from './pages/Payroll';
import Approvals from './pages/Approvals';
import Profile from './pages/Profile';
import Settings from './pages/Settings';
import ServiceTickets from './pages/ServiceTickets';
import Layout from './components/Layout';
import AppErrorBoundary from './components/ErrorBoundary';

const queryClient = new QueryClient();

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        height: '100vh',
        fontSize: '18px',
        color: 'var(--text-primary)'
      }}>
        <div>Loading...</div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" />;
  }

  return <>{children}</>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        height: '100vh',
        fontSize: '18px',
        color: 'var(--text-primary)'
      }}>
        <div>Loading...</div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" />;
  }

  if (user.role !== 'ADMIN') {
    return <Navigate to="/dashboard" />;
  }

  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/dashboard" replace />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="calendar" element={<WeekView />} />
        <Route path="calendar/:date" element={<DayDetail />} />
        <Route path="time-entries" element={<TimeEntries />} />
        <Route path="projects" element={<Projects />} />
        <Route path="payroll" element={<Payroll />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="profile" element={<Profile />} />
        <Route path="settings" element={<Settings />} />
        <Route
          path="customers"
          element={
            <AdminRoute>
              <Customers />
            </AdminRoute>
          }
        />
        <Route
          path="employees"
          element={
            <AdminRoute>
              <Employees />
            </AdminRoute>
          }
        />
        <Route
          path="service-tickets"
          element={
            <AdminRoute>
              <ServiceTickets />
            </AdminRoute>
          }
        />
        <Route path="forms" element={<Forms />} />
      </Route>
    </Routes>
  );
}

function App() {
  console.log('📱 App component rendering...');
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider>
            <TimerProvider>
              <Router>
                <AppRoutes />
              </Router>
            </TimerProvider>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}

export default App;

