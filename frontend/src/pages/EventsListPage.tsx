import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiClient } from '../lib/apiClient';
import { useOrgStore } from '../stores/orgStore';
import { Event, EventStatus } from '../types';
import { StatusBadge } from '../components/StatusBadge';
import { formatDatetime } from '../lib/utils';

const STATUS_FILTERS: Array<EventStatus | 'All'> = [
  'All', 'Draft', 'Published', 'Open', 'In_Progress', 'Completed', 'Cancelled', 'Archived',
];

export function EventsListPage() {
  const { currentOrg } = useOrgStore();
  const orgId = currentOrg?.orgId ?? '';
  const [statusFilter, setStatusFilter] = useState<EventStatus | 'All'>('All');

  const { data, isLoading } = useQuery({
    queryKey: ['events', orgId, statusFilter],
    queryFn: async () => {
      const params = statusFilter !== 'All' ? `?status=${statusFilter}` : '';
      const res = await apiClient.get<{ items: Event[] }>(`/orgs/${orgId}/events${params}`);
      return res.data.items;
    },
    enabled: !!orgId,
    staleTime: 30_000,
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Events</h1>
        <Link to="create" className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          aria-label="Create new event">
          New event
        </Link>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 mb-4 overflow-x-auto" role="tablist" aria-label="Filter events by status">
        {STATUS_FILTERS.map((s) => (
          <button key={s} role="tab" aria-selected={statusFilter === s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded text-xs font-medium whitespace-nowrap transition-colors ${
              statusFilter === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}>
            {s.replace('_', ' ')}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p role="status" className="text-sm text-gray-500">Loading events…</p>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200" aria-label="Events list">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Title</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Start</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Capacity</th>
                <th scope="col" className="sr-only">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(data ?? []).map((ev) => (
                <tr key={ev.eventId} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link to={ev.eventId} className="text-sm font-medium text-blue-700 hover:underline">
                      {ev.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={ev.status} /></td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    <time dateTime={ev.startAt} title={ev.startAt}>
                      {formatDatetime(ev.startAt, ev.timezone)}
                    </time>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {ev.confirmedCount}/{ev.capacity}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link to={`${ev.eventId}/edit`} className="text-xs text-gray-600 hover:underline"
                      aria-label={`Edit ${ev.title}`}>Edit</Link>
                  </td>
                </tr>
              ))}
              {(data ?? []).length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400">No events found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
