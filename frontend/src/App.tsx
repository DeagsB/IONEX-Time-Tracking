import { lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth, canAccessInvoices } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { TimerProvider } from './context/TimerContext';
import { DemoModeProvider } from './context/DemoModeContext';
import Login from './pages/Login';
import AuthCallback from './pages/AuthCallback';
import Maintenance from './pages/Maintenance';

const WeekView = lazy(() => import('./pages/WeekView'));
const TimeEntries = lazy(() => import('./pages/TimeEntries'));
const DayDetail = lazy(() => import('./pages/DayDetail'));
const Projects = lazy(() => import('./pages/Projects'));
const Customers = lazy(() => import('./pages/Customers'));
const Employees = lazy(() => import('./pages/Employees'));
const Payroll = lazy(() => import('./pages/Payroll'));
const Profile = lazy(() => import('./pages/Profile'));
const ServiceTickets = lazy(() => import('./pages/ServiceTickets'));
const Invoices = lazy(() => import('./pages/Invoices'));
const EmployeeReports = lazy(() => import('./pages/EmployeeReports'));
const UserManagement = lazy(() => import('./pages/UserManagement'));
const Changelog = lazy(() => import('./pages/Changelog'));
const Expenses = lazy(() => import('./pages/Expenses'));
const Profitability = lazy(() => import('./pages/Profitability'));
const Dashboard = lazy(() => import('./pages/Dashboard'));

import Layout from './components/Layout';
import AppErrorBoundary from './components/ErrorBoundary';
// Avoid refetch-on-focus racing token refresh on some browsers (entries briefly OK then empty).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, isDeveloper, maintenanceMode } = useAuth();

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

  // Maintenance mode: only developers can access the app
  if (maintenanceMode && !isDeveloper) {
    return <Navigate to="/maintenance" />;
  }

  return <>{children}</>;
}

function InvoicesRoute({ children }: { children: React.ReactNode }) {
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

  if (!canAccessInvoices(user)) {
    return <Navigate to="/calendar" />;
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

function AdminHome() {
  const { isAdmin } = useAuth();
  return <Navigate to={isAdmin ? '/dashboard' : '/calendar'} replace />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/maintenance" element={<Maintenance />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<AdminHome />} />
        <Route
          path="dashboard"
          element={
            <AdminRoute>
              <Dashboard />
            </AdminRoute>
          }
        />
        <Route path="calendar" element={<WeekView />} />
        <Route path="calendar/:date" element={<DayDetail />} />
        <Route path="time-entries" element={<TimeEntries />} />
        <Route path="expenses" element={<Expenses />} />
        <Route path="manage" element={<Navigate to="/projects" replace />} />
        <Route path="projects" element={<Projects />} />
        <Route path="payroll" element={<Payroll />} />
        <Route path="profile" element={<Profile />} />
        <Route
          path="changelog"
          element={
            <AdminRoute>
              <Changelog />
            </AdminRoute>
          }
        />
        <Route path="customers" element={<Customers />} />
        <Route
          path="employees"
          element={
            <AdminRoute>
              <Employees />
            </AdminRoute>
          }
        />
        <Route path="service-tickets" element={<ServiceTickets />} />
        <Route
          path="invoices"
          element={
            <InvoicesRoute>
              <Invoices />
            </InvoicesRoute>
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
          path="profitability"
          element={
            <AdminRoute>
              <Profitability />
            </AdminRoute>
          }
        />
        <Route path="user-archive" element={<Navigate to="/user-management" replace />} />
        <Route
          path="user-management"
          element={
            <AdminRoute>
              <UserManagement />
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

