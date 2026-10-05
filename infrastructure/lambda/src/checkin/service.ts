import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import * as repo from './repository';
import * as eventRepo from '../events/repository';
import { assertPermission } from '../shared/layers/rbac';
import { writeAuditLog } from '../shared/middleware/writeAuditLog';
import { broadcastToOrg } from '../shared/utils/broadcast';
import { CheckInRequest, CheckInResponse, CheckInStatsResponse } from './types';

const sqs = new SQSClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
const NOTIFICATION_QUEUE_URL = process.env['NOTIFICATION_QUEUE_URL'] ?? '';

// ─── Check-In service ─────────────────────────────────────────────────────────

/**
 * Performs a check-in for a ticket identified by ticketCode.
 *
 * Idempotency: if the ticket is already CheckedIn, returns the original
 * checkedInAt timestamp with alreadyCheckedIn: true — no new record created.
 *
 * Requirements:
 * - Event must be in In_Progress state
 * - Ticket must exist in this org/event (404 if not found — safe here because
 *   we are searching by ticketCode, not cross-org resource access)
 * - Organizer role required
 */
export async function checkIn(
  orgId: string,
  eventId: string,
  tenantId: string,
  actorId: string,
  actorRole: string,
  sourceIp: string,
  input: CheckInRequest,
): Promise<CheckInResponse> {
  // Multi-tenant isolation check
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'checkin.access_denied',
    });
  }

  // RBAC: Organizer or above
  assertPermission(actorRole, 'checkin:perform');

  // Validate input
  if (!input.ticketCode || typeof input.ticketCode !== 'string' || input.ticketCode.trim() === '') {
    throw Object.assign(new Error('ticketCode is required.'), {
      statusCode: 400,
      errorCode: 'checkin.missing_ticket_code',
    });
  }

  const ticketCode = input.ticketCode.trim();

  // Fetch the event — must be In_Progress
  const event = await eventRepo.getEventById(orgId, eventId, tenantId);
  if (!event) {
    throw Object.assign(new Error('Event not found or access denied.'), {
      statusCode: 403,
      errorCode: 'checkin.event_not_found',
    });
  }

  if (event.status !== 'In_Progress') {
    throw Object.assign(
      new Error(
        `Check-in is only allowed for In_Progress events. Current status: ${event.status}.`,
      ),
      { statusCode: 400, errorCode: 'checkin.event_not_in_progress' },
    );
  }

  // Look up ticket by ticketCode via GSI1
  const ticket = await repo.findTicketByCode(ticketCode, tenantId);
  if (!ticket) {
    // 404 is correct here: ticket not found in this org/event by ticketCode
    throw Object.assign(new Error('Ticket not found.'), {
      statusCode: 404,
      errorCode: 'checkin.ticket_not_found',
    });
  }

  // Ensure the ticket belongs to the requested event (extra isolation guard)
  if (ticket.eventId !== eventId || ticket.orgId !== orgId) {
    throw Object.assign(new Error('Ticket does not belong to this event.'), {
      statusCode: 404,
      errorCode: 'checkin.ticket_not_found',
    });
  }

  // ── Idempotency check ───────────────────────────────────────────────────────
  // If already checked in, return original timestamp without creating a new record.
  if (ticket.status === 'CheckedIn') {
    return {
      ticketId: ticket.ticketId,
      ticketCode: ticket.ticketCode,
      memberId: ticket.memberId,
      guestEmail: ticket.guestEmail,
      guestName: ticket.guestName,
      checkedInAt: ticket.checkedInAt!,
      checkedInBy: (ticket as unknown as Record<string, string>)['checkedInBy'] ?? actorId,
      alreadyCheckedIn: true,
    };
  }

  // Reject cancelled or waitlisted tickets
  if (ticket.status === 'Cancelled') {
    throw Object.assign(new Error('Cannot check in a cancelled ticket.'), {
      statusCode: 400,
      errorCode: 'checkin.ticket_cancelled',
    });
  }

  if (ticket.status === 'Waitlisted') {
    throw Object.assign(new Error('Cannot check in a waitlisted ticket.'), {
      statusCode: 400,
      errorCode: 'checkin.ticket_waitlisted',
    });
  }

  const checkedInAt = new Date().toISOString();

  // Atomically update ticket to CheckedIn (conditional: must currently be Confirmed)
  const updateResult = await repo.markCheckedIn(
    orgId,
    eventId,
    ticket.ticketId,
    tenantId,
    checkedInAt,
    actorId,
  );

  // If condition failed, re-fetch to check for concurrent check-in (idempotency)
  if (!updateResult.updated) {
    const freshTicket = await repo.getTicketById(orgId, eventId, ticket.ticketId, tenantId);
    if (freshTicket?.status === 'CheckedIn') {
      return {
        ticketId: freshTicket.ticketId,
        ticketCode: freshTicket.ticketCode,
        memberId: freshTicket.memberId,
        guestEmail: freshTicket.guestEmail,
        guestName: freshTicket.guestName,
        checkedInAt: freshTicket.checkedInAt!,
        checkedInBy: (freshTicket as unknown as Record<string, string>)['checkedInBy'] ?? actorId,
        alreadyCheckedIn: true,
      };
    }
    // Ticket state changed to something else concurrently
    throw Object.assign(new Error('Check-in failed due to concurrent modification. Please retry.'), {
      statusCode: 409,
      errorCode: 'checkin.concurrent_modification',
    });
  }

  const updatedTicket = updateResult.ticket;

  // ── Post-check-in side effects (non-blocking) ───────────────────────────────

  void (async () => {
    try {
      // Calculate capacity percentage
      const checkedInCount = await repo.countCheckedInTickets(orgId, eventId, tenantId);
      const capacity = event.capacity;
      const percentage = capacity > 0 ? (checkedInCount / capacity) * 100 : 0;

      // Broadcast WebSocket event
      await broadcastToOrg(orgId, 'CHECKIN_UPDATE', {
        eventId,
        ticketId: updatedTicket.ticketId,
        checkedInCount,
        capacity,
        percentage: Math.round(percentage * 100) / 100,
      });

      // Enqueue SQS notification for capacity warnings
      if (NOTIFICATION_QUEUE_URL && percentage >= 90) {
        const notificationType = percentage >= 100 ? 'CAPACITY_FULL' : 'CAPACITY_WARNING';
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: NOTIFICATION_QUEUE_URL,
            MessageBody: JSON.stringify({
              type: notificationType,
              orgId,
              eventId,
              checkedInCount,
              capacity,
              percentage: Math.round(percentage * 100) / 100,
              timestamp: checkedInAt,
            }),
          }),
        );
      }
    } catch {
      // Side effects are non-fatal — swallow errors
      process.stderr.write(`[checkin] Post-check-in side effects failed for ticket ${ticket.ticketId}\n`);
    }
  })();

  // Write audit log (synchronous — important for compliance)
  await writeAuditLog({
    timestamp: checkedInAt,
    actor: actorId,
    targetType: 'TICKET',
    targetId: ticket.ticketId,
    operation: 'ticket.checkin',
    sourceIp,
    outcome: 'success',
    orgId,
    metadata: { eventId, ticketCode },
  });

  return {
    ticketId: updatedTicket.ticketId,
    ticketCode: updatedTicket.ticketCode,
    memberId: updatedTicket.memberId,
    guestEmail: updatedTicket.guestEmail,
    guestName: updatedTicket.guestName,
    checkedInAt,
    checkedInBy: actorId,
    alreadyCheckedIn: false,
  };
}

/**
 * Returns check-in statistics for an event.
 * Organizer role required.
 */
export async function getCheckInStats(
  orgId: string,
  eventId: string,
  tenantId: string,
  actorRole: string,
): Promise<CheckInStatsResponse> {
  // Multi-tenant isolation check
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'checkin.access_denied',
    });
  }

  assertPermission(actorRole, 'checkin:perform');

  // Fetch the event to get capacity
  const event = await eventRepo.getEventById(orgId, eventId, tenantId);
  if (!event) {
    throw Object.assign(new Error('Event not found or access denied.'), {
      statusCode: 403,
      errorCode: 'checkin.event_not_found',
    });
  }

  const checkedInCount = await repo.countCheckedInTickets(orgId, eventId, tenantId);
  const capacity = event.capacity;
  const percentage = capacity > 0 ? Math.round((checkedInCount / capacity) * 10000) / 100 : 0;

  return { checkedInCount, capacity, percentage };
}
