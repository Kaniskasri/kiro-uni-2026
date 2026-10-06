import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient';
import { useOrgStore } from '../stores/orgStore';
import { Event } from '../types';
import { StatusBadge } from '../components/StatusBadge';
import { formatDatetime } from '../lib/utils';
import { Link } from 'react-router-dom';
import { useParams } from 'react-router-dom';

interface DashboardMetrics {
  upcomingEventsCount: number;
  totalRegisteredAttendees: number;
  totalCheckIns: number;
  totalEventsRun: number;
  totalRegistrations: number;
  avgAttendanceRate: number;
}

interface LiveCheckIn {
  eventId: string;
  title: string;
  checkedInCount: number;
  capacity: number;
  percentage: number;
}

export function DashboardPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { currentOrg } = useOrgStore();
  const orgId = currentOrg?.orgId ?? '';

  const { data: metrics, dataUpdatedAt: metricsUpdated, isError: metricsError } = useQuery<DashboardMetrics>({
    queryKey: ['dashboard-metrics', orgId],
    queryFn: async () => {
      const res = await apiClient.get<DashboardMetrics>(`/orgs/${orgId}/dashboard/metrics`);
      return res.data;
    },
    enabled: !!orgId,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const { data: events } = useQuery<Event[]>({
    queryKey: ['events', orgId, 'All'],
    queryFn: async () => {
      const res = await apiClient.get<{ items: Event[] }>(`/orgs/${orgId}/events`);
      return res.data.items;
    },
    enabled: !!orgId,
    staleTime: 30_000,
  });

  const { data: liveCheckIns } = useQuery<LiveCheckIn[]>({
    queryKey: ['live-checkins', orgId],
    queryFn: async () => {
      const res = await apiClient.get<{ items: LiveCheckIn[] }>(`/orgs/${orgId}/dashboard/live-checkins`);
      return res.data.items;
    },
    enabled: !!orgId,
    refetchInterval: 10_000,
  });

  const staleIndicator = metricsUpdated
    ? new Date(metricsUpdated).toLocaleTimeString()
    : null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>

      {metricsError && (
        <div role="alert" className="rounded bg-yellow-50 border border-yellow-300 px-3 py-2 text-sm text-yellow-800">
          Unable to load metrics. Showing stale data.
        </div>
      )}

      {/* Metric cards */}
      <section aria-labelledby="metrics-heading">
        <h2 id="metrics-heading" className="sr-only">Organization metrics</h2>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            { label: 'Upcoming events', value: metrics?.upcomingEventsCount ?? '—' },
            { label: 'Registered attendees', value: metrics?.totalRegisteredAttendees ?? '—' },
            { label: 'Total check-ins', value: metrics?.totalCheckIns ?? '—' },
            { label: 'Events run (12mo)', value: metrics?.totalEventsRun ?? '—' },
            { label: 'Total registrations', value: metrics?.totalRegistrations ?? '—' },
            { label: 'Avg attendance rate', value: metrics?.avgAttendanceRate != null ? `${metrics.avgAttendanceRate.toFixed(1)}%` : '—' },
          ].map((m) => (
            <div key={m.label} className="bg-white rounded-lg border border-gray-200 p-4"
              aria-label={`${m.label}: ${m.value}`}>
              <p className="text-xs text-gray-500 mb-1">{m.label}</p>
              <p className="text-2xl font-bold text-gray-900">{String(m.value)}</p>
            </div>
          ))}
        </div>
        {staleIndicator && (
          <p className="mt-2 text-xs text-gray-400">Last updated: {staleIndicator}</p>
        )}
      </section>

      {/* Live check-in widget */}
      {liveCheckIns && liveCheckIns.length > 0 && (
        <section aria-labelledby="live-checkin-heading" className="bg-white rounded-lg border border-gray-200 p-4">
          <h2 id="live-checkin-heading" className="text-sm font-semibold text-gray-700 mb-3">
            Live check-in
          </h2>
          <ul className="space-y-3" role="list">
            {liveCheckIns.map((ev) => (
              <li key={ev.eventId}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <Link to={`/orgs/${orgSlug}/events/${ev.eventId}`} className="font-medium text-blue-700 hover:underline">
                    {ev.title}
                  </Link>
                  <span className="text-gray-600">{ev.checkedInCount}/{ev.capacity} ({ev.percentage.toFixed(0)}%)</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2" role="progressbar"
                  aria-valuenow={ev.checkedInCount} aria-valuemin={0} aria-valuemax={ev.capacity}
                  aria-label={`${ev.title}: ${ev.percentage.toFixed(0)}% checked in`}>
                  <div className={`h-2 rounded-full ${ev.percentage >= 100 ? 'bg-red-500' : ev.percentage >= 90 ? 'bg-yellow-500' : 'bg-blue-500'}`}
                    style={{ width: `${Math.min(ev.percentage, 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Events table */}
      <section aria-labelledby="events-table-heading">
        <h2 id="events-table-heading" className="text-sm font-semibold text-gray-700 mb-3">Events by status</h2>
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200" aria-label="Events overview">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Title</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Start</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(events ?? []).slice(0, 10).map((ev) => (
                <tr key={ev.eventId}>
                  <td className="px-4 py-3">
                    <Link to={`/orgs/${orgSlug}/events/${ev.eventId}`}
                      className="text-sm font-medium text-blue-700 hover:underline">{ev.title}</Link>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={ev.status} /></td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    <time dateTime={ev.startAt} title={ev.startAt}>{formatDatetime(ev.startAt, ev.timezone)}</time>
                  </td>
                </tr>
              ))}
              {(events ?? []).length === 0 && (
                <tr><td colSpan={3} className="px-4 py-8 text-center text-sm text-gray-400">No events yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
