import { RouterProvider, createBrowserRouter, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { OrgShell } from './components/OrgShell';
import { DashboardPage } from './pages/DashboardPage';
import { EventsListPage } from './pages/EventsListPage';
import { CreateEventPage } from './pages/CreateEventPage';
import { EditEventPage } from './pages/EditEventPage';
import { EventDetailPage } from './pages/EventDetailPage';
import { MembersPage } from './pages/MembersPage';
import { VenuesPage } from './pages/VenuesPage';
import { CreateVenuePage } from './pages/CreateVenuePage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { OrgSettingsPage } from './pages/OrgSettingsPage';
import { CreateOrgPage } from './pages/CreateOrgPage';
import { ProfilePage } from './pages/ProfilePage';
import { DataExportPage } from './pages/DataExportPage';
import { CheckInPage } from './pages/CheckInPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/login" replace /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  { path: '/verify-email', element: <VerifyEmailPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/accept-invite/:token', element: <AcceptInvitePage /> },
  { path: '/orgs/new', element: <CreateOrgPage /> },
  { path: '/profile', element: <ProfilePage /> },
  { path: '/profile/data-export', element: <DataExportPage /> },
  {
    path: '/orgs/:orgSlug',
    element: <OrgShell />,
    children: [
      { index: true, element: <Navigate to="dashboard" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'events', element: <EventsListPage /> },
      { path: 'events/create', element: <CreateEventPage /> },
      { path: 'events/:eventId', element: <EventDetailPage /> },
      { path: 'events/:eventId/edit', element: <EditEventPage /> },
      { path: 'events/:eventId/checkin', element: <CheckInPage /> },
      { path: 'members', element: <MembersPage /> },
      { path: 'venues', element: <VenuesPage /> },
      { path: 'venues/create', element: <CreateVenuePage /> },
      { path: 'analytics', element: <AnalyticsPage /> },
      { path: 'audit-log', element: <AuditLogPage /> },
      { path: 'settings', element: <OrgSettingsPage /> },
    ],
  },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
