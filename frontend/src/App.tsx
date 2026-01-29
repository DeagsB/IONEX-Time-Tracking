import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { TimerProvider } from './context/TimerContext';
import { DemoModeProvider } from './context/DemoModeContext';
import Login from './pages/Login';
import AuthCallback from './pages/AuthCallback';
import WeekView from './pages/WeekView';
import TimeEntries from './pages/TimeEntries';
import DayDetail from './pages/DayDetail';
import Projects from './pages/Projects';
import Customers from './pages/Customers';
import Employees from './pages/Employees';
import Payroll from './pages/Payroll';
import Profile from './pages/Profile';
import ServiceTickets from './pages/ServiceTickets';
import EmployeeReports from './pages/EmployeeReports';
import UserArchive from './pages/UserArchive';
import UserManagement from './pages/UserManagement';
import BugReports from './pages/BugReports';
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
  const { user, loading, isAdmin } = useAuth();

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

  if (!isAdmin) {
    return <Navigate to="/calendar" />;
  }

  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/calendar" />} />
        <Route path="calendar" element={<WeekView />} />
        <Route path="calendar/:date" element={<DayDetail />} />
        <Route path="time-entries" element={<TimeEntries />} />
        <Route path="projects" element={<Projects />} />
        <Route path="payroll" element={<Payroll />} />
        <Route path="profile" element={<Profile />} />
        <Route path="customers" element={<Customers />} />
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
        <Route
          path="employee-reports"
          element={
            <AdminRoute>
              <EmployeeReports />
            </AdminRoute>
          }
        />
        <Route
          path="user-archive"
          element={
            <AdminRoute>
              <UserArchive />
            </AdminRoute>
          }
        />
        <Route
          path="user-management"
          element={
            <AdminRoute>
              <UserManagement />
            </AdminRoute>
          }
        />
        <Route
          path="bug-reports"
          element={
            <AdminRoute>
              <BugReports />
            </AdminRoute>
          }
        />
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
          <DemoModeProvider>
            <AuthProvider>
              <TimerProvider>
                <Router>
                  <AppRoutes />
                </Router>
              </TimerProvider>
            </AuthProvider>
          </DemoModeProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}

export default App;

