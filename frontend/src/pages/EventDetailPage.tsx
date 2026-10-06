import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient, extractApiError } from '../lib/apiClient';
import { useOrgStore } from '../stores/orgStore';
import { Event } from '../types';
import { StatusBadge } from '../components/StatusBadge';
import { formatDatetime } from '../lib/utils';
import { SmartSchedulingPanel } from './SmartSchedulingPanel';

export function EventDetailPage() {
  const { orgSlug, eventId } = useParams<{ orgSlug: string; eventId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { currentOrg, role } = useOrgStore();
  const orgId = currentOrg?.orgId ?? '';
  const [actionError, setActionError] = useState<string | null>(null);
  const [workflowHistory, setWorkflowHistory] = useState<Array<{ step: string; status: string; timestamp: string }> | null>(null);

  const { data: event, isLoading } = useQuery({
    queryKey: ['events', orgId, eventId],
    queryFn: async () => {
      const res = await apiClient.get<Event>(`/orgs/${orgId}/events/${eventId}`);
      return res.data;
    },
    enabled: !!orgId && !!eventId,
  });

  const publishMutation = useMutation({
    mutationFn: () => apiClient.post(`/orgs/${orgId}/events/${eventId}/publish`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['events', orgId, eventId] }),
    onError: (err) => setActionError(extractApiError(err)),
  });

  const cancelMutation = useMutation({
    mutationFn: () => apiClient.post(`/orgs/${orgId}/events/${eventId}/cancel`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['events', orgId, eventId] }),
    onError: (err) => setActionError(extractApiError(err)),
  });

  const loadWorkflowHistory = async () => {
    try {
      const res = await apiClient.get<{ steps: Array<{ step: string; status: string; timestamp: string }> }>(
        `/orgs/${orgId}/events/${eventId}/workflow-history`
      );
      setWorkflowHistory(res.data.steps);
    } catch {
      setWorkflowHistory([]);
    }
  };

  const canPublish = (role === 'Owner' || role === 'Admin' || role === 'Organizer') &&
    event?.status === 'Draft';
  const canCancel = (role === 'Owner' || role === 'Admin' || role === 'Organizer') &&
    ['Published', 'Open', 'In_Progress'].includes(event?.status ?? '');

  if (isLoading) return <p role="status" className="text-sm text-gray-500">Loading event…</p>;
  if (!event) return <p role="alert" className="text-sm text-red-600">Event not found.</p>;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-gray-900">{event.title}</h1>
            <StatusBadge status={event.status} />
          </div>
          <p className="text-sm text-gray-500">
            <time dateTime={event.startAt} title={event.startAt}>{formatDatetime(event.startAt, event.timezone)}</time>
            {' — '}
            <time dateTime={event.endAt} title={event.endAt}>{formatDatetime(event.endAt, event.timezone)}</time>
          </p>
        </div>
        <Link to="edit" className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          aria-label="Edit event">Edit</Link>
      </div>

      {actionError && (
        <div role="alert" className="rounded bg-red-50 border border-red-300 px-3 py-2 text-sm text-red-700">
          {actionError}
        </div>
      )}

      {/* Event info */}
      <section aria-labelledby="event-info" className="bg-white rounded-lg border border-gray-200 p-6 space-y-3">
        <h2 id="event-info" className="sr-only">Event details</h2>
        {event.description && <p className="text-sm text-gray-700">{event.description}</p>}
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-gray-500">Capacity</dt>
            <dd className="font-medium">{event.confirmedCount} / {event.capacity} confirmed</dd>
          </div>
          <div>
            <dt className="text-gray-500">Waitlist</dt>
            <dd className="font-medium">{event.waitlistCount}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Type</dt>
            <dd className="font-medium">{event.isVirtual ? 'Virtual' : 'In-person'}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Timezone</dt>
            <dd className="font-medium">{event.timezone}</dd>
          </div>
          {event.venueName && (
            <div className="col-span-2">
              <dt className="text-gray-500">Venue</dt>
              <dd className="font-medium">{event.venueName}{event.venueAddress && ` — ${event.venueAddress}`}</dd>
            </div>
          )}
          {event.meetingUrl && (
            <div className="col-span-2">
              <dt className="text-gray-500">Meeting URL</dt>
              <dd><a href={event.meetingUrl} className="text-blue-600 hover:underline" target="_blank" rel="noopener noreferrer">{event.meetingUrl}</a></dd>
            </div>
          )}
        </dl>
      </section>

      {/* Action buttons */}
      <section aria-labelledby="actions-heading" className="flex flex-wrap gap-3">
        <h2 id="actions-heading" className="sr-only">Actions</h2>
        {canPublish && (
          <button onClick={() => publishMutation.mutate()} disabled={publishMutation.isPending}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            aria-label="Publish event">
            Publish
          </button>
        )}
        {canCancel && (
          <button onClick={() => { if (confirm('Cancel this event?')) cancelMutation.mutate(); }}
            disabled={cancelMutation.isPending}
            className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            aria-label="Cancel event">
            Cancel event
          </button>
        )}
        <Link to={`/orgs/${orgSlug}/events/${eventId}/checkin`}
          className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          aria-label="Go to check-in page">
          Check-in
        </Link>
        <Link to={`/orgs/${orgSlug}/analytics?eventId=${eventId}`}
          className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          aria-label="View analytics for this event">
          Analytics
        </Link>
      </section>

      {/* Smart Scheduling Panel */}
      {(event.status === 'Draft') && (
        <SmartSchedulingPanel />
      )}

      {/* Workflow history */}
      <section aria-labelledby="workflow-heading">
        <div className="flex items-center justify-between mb-2">
          <h2 id="workflow-heading" className="text-sm font-semibold text-gray-700">Workflow history</h2>
          <button onClick={loadWorkflowHistory} className="text-xs text-blue-600 hover:underline"
            aria-label="Load workflow history">
            Load
          </button>
        </div>
        {workflowHistory && (
          workflowHistory.length === 0 ? (
            <p className="text-xs text-gray-400">No workflow history.</p>
          ) : (
            <ol className="space-y-1">
              {workflowHistory.map((step, i) => (
                <li key={i} className="flex items-center gap-3 text-xs">
                  <span className={`w-2 h-2 rounded-full ${step.status === 'SUCCEEDED' ? 'bg-green-500' : step.status === 'FAILED' ? 'bg-red-500' : 'bg-yellow-500'}`}
                    aria-label={step.status} />
                  <span className="font-medium text-gray-700">{step.step}</span>
                  <time className="text-gray-400" dateTime={step.timestamp}>{formatDatetime(step.timestamp)}</time>
                </li>
              ))}
            </ol>
          )
        )}
      </section>
    </div>
  );
}
