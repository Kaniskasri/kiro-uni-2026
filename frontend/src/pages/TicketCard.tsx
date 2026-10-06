import { useState } from 'react';
import QRCode from 'react-qr-code';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient, extractApiError } from '../lib/apiClient';
import { useOrgStore } from '../stores/orgStore';
import { Ticket } from '../types';

interface Props {
  ticket: Ticket;
  eventId: string;
  eventStatus: string;
}

export function TicketCard({ ticket, eventId, eventStatus }: Props) {
  const queryClient = useQueryClient();
  const { currentOrg } = useOrgStore();
  const orgId = currentOrg?.orgId ?? '';
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const cancelMutation = useMutation({
    mutationFn: () => apiClient.delete(`/orgs/${orgId}/events/${eventId}/tickets/${ticket.ticketId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tickets', orgId, eventId] });
      setShowConfirm(false);
    },
    onError: (err) => setCancelError(extractApiError(err)),
  });

  const downloadIcal = async () => {
    try {
      const res = await apiClient.get(
        `/orgs/${orgId}/events/${eventId}/tickets/${ticket.ticketId}/ical`,
        { responseType: 'blob' }
      );
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url; a.download = `event-${eventId}.ics`; a.click();
      URL.revokeObjectURL(url);
    } catch { /* silently ignore */ }
  };

  const canCancel = ['Draft', 'Published', 'Open'].includes(eventStatus) &&
    ticket.status === 'Confirmed';

  return (
    <article
      className="bg-white rounded-lg border border-gray-200 p-4"
      aria-label={`Ticket ${ticket.ticketCode}`}
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Ticket code</p>
          <p className="font-mono text-sm font-bold text-gray-900">{ticket.ticketCode}</p>
        </div>
        <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${
          ticket.status === 'Confirmed' ? 'bg-green-100 text-green-700 border-green-300' :
          ticket.status === 'Waitlisted' ? 'bg-yellow-100 text-yellow-700 border-yellow-300' :
          ticket.status === 'CheckedIn' ? 'bg-purple-100 text-purple-700 border-purple-300' :
          'bg-red-100 text-red-700 border-red-300'
        }`}
          aria-label={`Ticket status: ${ticket.status}`}>
          {ticket.status}
        </span>
      </div>

      {ticket.status === 'Waitlisted' && ticket.waitlistPosition && (
        <p className="text-xs text-yellow-700 mb-3" aria-live="polite">
          Waitlist position: #{ticket.waitlistPosition}
        </p>
      )}

      {ticket.status === 'Confirmed' && (
        <div className="mb-3 flex justify-center bg-gray-50 p-3 rounded">
          <QRCode
            value={ticket.ticketCode}
            size={128}
            aria-label={`QR code for ticket ${ticket.ticketCode}`}
          />
        </div>
      )}

      {ticket.checkedInAt && (
        <p className="text-xs text-gray-500 mb-3">
          Checked in: <time dateTime={ticket.checkedInAt}>{new Date(ticket.checkedInAt).toLocaleString()}</time>
        </p>
      )}

      {cancelError && (
        <p role="alert" className="text-xs text-red-600 mb-2">{cancelError}</p>
      )}

      <div className="flex gap-2 flex-wrap">
        {ticket.status === 'Confirmed' && (
          <button
            onClick={downloadIcal}
            className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
            aria-label="Add to calendar — download .ics file"
          >
            Add to Calendar
          </button>
        )}

        {canCancel && !showConfirm && (
          <button
            onClick={() => setShowConfirm(true)}
            className="rounded border border-red-300 px-3 py-1.5 text-xs text-red-700 hover:bg-red-50"
            aria-label="Cancel this ticket"
          >
            Cancel ticket
          </button>
        )}

        {showConfirm && (
          <div className="flex gap-2" role="group" aria-label="Confirm ticket cancellation">
            <button
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
              className="rounded bg-red-600 px-3 py-1.5 text-xs text-white hover:bg-red-700 disabled:opacity-50"
            >
              Confirm cancel
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700"
            >
              Keep ticket
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
