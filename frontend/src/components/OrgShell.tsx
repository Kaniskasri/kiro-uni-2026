import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient';
import { useAuthStore } from '../stores/authStore';
import { useOrgStore } from '../stores/orgStore';
import { Organization, MemberRole } from '../types';
import { NotificationBell } from '../pages/NotificationBell';
import { useWebSocket } from '../hooks/useWebSocket';

interface OrgResponse {
  org: Organization;
  role: MemberRole;
}

const navItems = [
  { to: 'dashboard', label: 'Dashboard', icon: '📊' },
  { to: 'events', label: 'Events', icon: '📅' },
  { to: 'members', label: 'Members', icon: '👥' },
  { to: 'venues', label: 'Venues', icon: '📍' },
  { to: 'analytics', label: 'Analytics', icon: '📈' },
  { to: 'audit-log', label: 'Audit Log', icon: '🔍' },
  { to: 'settings', label: 'Settings', icon: '⚙️' },
];

export function OrgShell() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const setOrg = useOrgStore((s) => s.setOrg);
  const clearOrg = useOrgStore((s) => s.clearOrg);

  // Connect WebSocket for real-time updates
  useWebSocket();

  useEffect(() => {
    if (!isAuthenticated) navigate('/login', { replace: true });
  }, [isAuthenticated, navigate]);

  const { data, isError } = useQuery<OrgResponse>({
    queryKey: ['org', orgSlug],
    queryFn: async () => {
      const res = await apiClient.get<OrgResponse>(`/orgs/by-slug/${orgSlug}`);
      return res.data;
    },
    enabled: !!orgSlug && isAuthenticated,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (data) {
      setOrg(data.org, data.role);
    }
    return () => clearOrg();
  }, [data, setOrg, clearOrg]);

  if (isError) {
    return (
      <div className="flex h-screen items-center justify-center" role="alert">
        <p className="text-red-600">Organization not found or access denied.</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <nav
        className="w-56 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col"
        aria-label="Main navigation"
      >
        <div className="p-4 border-b border-gray-200">
          <h1 className="text-lg font-bold text-blue-700 truncate" title={data?.org.name}>
            {data?.org.name ?? orgSlug}
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">/{orgSlug}</p>
        </div>
        <ul className="flex-1 overflow-y-auto py-2" role="list">
          {navItems.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-2 px-4 py-2 text-sm transition-colors ${
                    isActive
                      ? 'bg-blue-50 text-blue-700 font-medium'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`
                }
                aria-label={item.label}
              >
                <span aria-hidden="true">{item.icon}</span>
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="p-4 border-t border-gray-200">
          <p className="text-xs text-gray-500 truncate">{user?.email}</p>
          <button
            onClick={() => { clearAuth(); navigate('/login'); }}
            className="mt-2 text-xs text-red-600 hover:underline"
            aria-label="Sign out"
          >
            Sign out
          </button>
        </div>
      </nav>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
          <div />
          <div className="flex items-center gap-3">
            <NotificationBell />
            <NavLink
              to="/profile"
              className="text-sm text-gray-700 hover:text-blue-700"
              aria-label="My profile"
            >
              {user?.name ?? user?.email}
            </NavLink>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
