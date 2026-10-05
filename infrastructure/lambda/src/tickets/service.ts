import { randomUUID } from 'crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import * as repo from './repository';
import * as eventRepo from '../events/repository';
import { assertPermission } from '../shared/layers/rbac';
import { writeAuditLog } from '../shared/middleware/writeAuditLog';
import { Ticket, TicketDynamoItem, CreateTicketRequest } from './types';

const s3 = new S3Client({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
const sqs = new SQSClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });

const ASSETS_BUCKET = process.env['ASSETS_BUCKET_NAME'] ?? 'clois-assets';
const NOTIFICATION_QUEUE_URL = process.env['NOTIFICATION_QUEUE_URL'] ?? '';
const WAITLIST_MAX = 100;
const QR_PRESIGN_SECONDS = 7 * 24 * 60 * 60; // 7 days

// ─── QR code generation ────────────────────────────────────────────────────────

/**
 * Generates a QR code PNG buffer from the ticket code.
 * Uses the `qrcode` npm package.
 */
async function generateQrCodeBuffer(ticketCode: string): Promise<Buffer> {
  // Dynamic import so it can be mocked in tests
  const QRCode = await import('qrcode');
  const buffer = await QRCode.toBuffer(ticketCode, { type: 'png', width: 300 });
  return buffer;
}

/**
 * Uploads QR code PNG to S3 and returns a 7-day pre-signed URL.
 */
async function uploadQrCodeAndGetUrl(
  orgId: string,
  eventId: string,
  ticketId: string,
  ticketCode: string,
): Promise<string> {
  const key = `qr-codes/${orgId}/${eventId}/${ticketId}.png`;
  const buffer = await generateQrCodeBuffer(ticketCode);

  await s3.send(
    new PutObjectCommand({
      Bucket: ASSETS_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: 'image/png',
    }),
  );

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: ASSETS_BUCKET, Key: key }),
    { expiresIn: QR_PRESIGN_SECONDS },
  );

  return url;
}

/**
 * Gets a 7-day pre-signed URL for an existing QR code in S3.
 */
export async function getQrCodePresignedUrl(
  orgId: string,
  eventId: string,
  ticketId: string,
): Promise<string> {
  const key = `qr-codes/${orgId}/${eventId}/${ticketId}.png`;
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: ASSETS_BUCKET, Key: key }),
    { expiresIn: QR_PRESIGN_SECONDS },
  );
}

// ─── Item mapper ───────────────────────────────────────────────────────────────

function toTicket(item: TicketDynamoItem, qrCodeUrl?: string): Ticket {
  return {
    ticketId: item.ticketId,
    orgId: item.orgId,
    eventId: item.eventId,
    memberId: item.memberId,
    guestEmail: item.guestEmail,
    guestName: item.guestName,
    status: item.status,
    ticketCode: item.ticketCode,
    waitlistPosition: item.waitlistPosition,
    qrCodeUrl,
    checkedInAt: item.checkedInAt,
    tenantId: item.tenantId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

// ─── Service operations ────────────────────────────────────────────────────────

/**
 * Creates a new Ticket (RSVP) for a Published or Open event.
 * - Member or guest RSVPs are checked for duplicates via GSI3.
 * - If confirmedCount < capacity → Confirmed.
 * - If at capacity → Waitlisted (up to 100 waitlist slots).
 * - Generates QR code PNG, uploads to S3, returns 7-day pre-signed URL.
 * - Enqueues RSVP confirmation to SQS notification-queue.
 * - Writes audit log.
 */
export async function createTicket(
  orgId: string,
  eventId: string,
  tenantId: string,
  actorId: string,
  sourceIp: string,
  input: CreateTicketRequest,
): Promise<Ticket> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'ticket.access_denied',
    });
  }

  // Either memberId or guestEmail must be provided
  if (!input.memberId && !input.guestEmail) {
    throw Object.assign(new Error('Either memberId or guestEmail must be provided.'), {
      statusCode: 400,
      errorCode: 'ticket.missing_registrant',
    });
  }

  // Validate guest email format if provided
  if (input.guestEmail) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(input.guestEmail)) {
      throw Object.assign(new Error('Invalid guest email format.'), {
        statusCode: 400,
        errorCode: 'ticket.invalid_email',
      });
    }
  }

  // Fetch the event — must be in Published or Open state
  const event = await eventRepo.getEventById(orgId, eventId, tenantId);
  if (!event) {
    throw Object.assign(new Error('Event not found or access denied.'), {
      statusCode: 403,
      errorCode: 'ticket.event_not_found',
    });
  }

  if (event.status !== 'Published' && event.status !== 'Open') {
    throw Object.assign(
      new Error(
        `RSVP is only allowed for Published or Open events. Current status: ${event.status}.`,
      ),
      { statusCode: 400, errorCode: 'ticket.event_not_open' },
    );
  }

  // Check for duplicate RSVP
  if (input.memberId) {
    const existing = await repo.findTicketByMemberAndEvent(input.memberId, eventId, orgId);
    if (existing) {
      throw Object.assign(
        new Error('You already have an active ticket for this event.'),
        { statusCode: 409, errorCode: 'ticket.duplicate_registration' },
      );
    }
  } else if (input.guestEmail) {
    const normalizedEmail = input.guestEmail.toLowerCase().trim();
    const existing = await repo.findTicketByGuestEmailAndEvent(normalizedEmail, eventId, orgId);
    if (existing) {
      throw Object.assign(
        new Error('A ticket with this email address already exists for this event.'),
        { statusCode: 409, errorCode: 'ticket.duplicate_registration' },
      );
    }
  }

  // Count confirmed tickets to determine Confirmed vs Waitlisted
  const confirmedCount = await repo.countConfirmedTickets(orgId, eventId, tenantId);
  const atCapacity = confirmedCount >= event.capacity;

  // If at capacity, check waitlist length
  if (atCapacity) {
    const maxWaitlistPos = await repo.getMaxWaitlistPosition(orgId, eventId, tenantId);
    if (maxWaitlistPos >= WAITLIST_MAX) {
      throw Object.assign(
        new Error('The waitlist for this event is full (maximum 100 waitlist spots).'),
        { statusCode: 409, errorCode: 'ticket.waitlist_full' },
      );
    }
  }

  const ticketId = randomUUID();
  const ticketCode = randomUUID();
  const status = atCapacity ? 'Waitlisted' : 'Confirmed';
  const waitlistPosition = atCapacity
    ? (await repo.getMaxWaitlistPosition(orgId, eventId, tenantId)) + 1
    : undefined;

  const normalizedGuestEmail = input.guestEmail
    ? input.guestEmail.toLowerCase().trim()
    : undefined;

  const gsi3pk = input.memberId
    ? `MEMBER#${input.memberId}#EVENT#${eventId}`
    : `GUEST#${normalizedGuestEmail}#EVENT#${eventId}`;

  // Create ticket in DynamoDB
  const dynamoItem = await repo.createTicket({
    PK: `ORG#${orgId}#EVENT#${eventId}#TICKET#${ticketId}`,
    SK: 'METADATA',
    GSI1PK: `TICKETCODE#${ticketCode}`,
    GSI1SK: `TICKET#${ticketId}`,
    GSI3PK: gsi3pk,
    GSI3SK: `TICKET#${ticketId}`,
    type: 'TICKET',
    ticketId,
    orgId,
    eventId,
    memberId: input.memberId,
    guestEmail: normalizedGuestEmail,
    guestName: input.guestName,
    status,
    ticketCode,
    waitlistPosition,
    tenantId,
  });

  // Generate QR code and upload to S3 (only for Confirmed tickets)
  let qrCodeUrl: string | undefined;
  if (status === 'Confirmed') {
    try {
      qrCodeUrl = await uploadQrCodeAndGetUrl(orgId, eventId, ticketId, ticketCode);
    } catch (err) {
      // Non-fatal: QR code generation failure shouldn't block RSVP
      process.stderr.write(
        `[tickets] QR code generation failed for ticket ${ticketId}: ${(err as Error).message}\n`,
      );
    }
  }

  // Enqueue RSVP confirmation notification to SQS (non-critical)
  if (NOTIFICATION_QUEUE_URL) {
    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: NOTIFICATION_QUEUE_URL,
          MessageBody: JSON.stringify({
            type: status === 'Confirmed' ? 'ticket.rsvp_confirmed' : 'ticket.rsvp_waitlisted',
            ticketId,
            orgId,
            eventId,
            memberId: input.memberId,
            guestEmail: normalizedGuestEmail,
            ticketCode,
            waitlistPosition,
            timestamp: new Date().toISOString(),
          }),
        }),
      );
    } catch {
      // Non-fatal: notification failure should not block ticket creation
      process.stderr.write(`[tickets] Failed to enqueue RSVP notification for ticket ${ticketId}\n`);
    }
  }

  // Write audit log
  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: actorId,
    targetType: 'TICKET',
    targetId: ticketId,
    operation: 'ticket.create',
    sourceIp,
    outcome: 'success',
    orgId,
    metadata: { eventId, status, ticketCode },
  });

  return toTicket(dynamoItem, qrCodeUrl);
}

/**
 * Lists all tickets for an event (Organizer/Admin only), paginated.
 */
export async function listTickets(
  orgId: string,
  eventId: string,
  tenantId: string,
  callerRole: string,
  limit: number,
  nextToken?: string,
): Promise<{ tickets: Ticket[]; nextToken?: string }> {
  assertPermission(callerRole, 'tickets:list-all');

  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'ticket.access_denied',
    });
  }

  const result = await repo.listTicketsByEvent(orgId, eventId, tenantId, limit, nextToken);
  return {
    tickets: result.tickets.map((t) => toTicket(t)),
    nextToken: result.nextToken,
  };
}

/**
 * Returns a single Ticket with a 7-day pre-signed QR code URL.
 * Cross-org access → 403 (never 404).
 */
export async function getTicket(
  orgId: string,
  eventId: string,
  ticketId: string,
  tenantId: string,
  actorId: string,
  actorRole: string,
): Promise<Ticket> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'ticket.access_denied',
    });
  }

  const item = await repo.getTicketById(orgId, eventId, ticketId, tenantId);
  if (!item) {
    throw Object.assign(new Error('Ticket not found or access denied.'), {
      statusCode: 403,
      errorCode: 'ticket.access_denied',
    });
  }

  // Members can only view their own tickets; Organizers and above can view all
  const isOrganizerOrAbove =
    actorRole === 'Owner' || actorRole === 'Admin' || actorRole === 'Organizer';
  if (!isOrganizerOrAbove && item.memberId !== actorId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'ticket.access_denied',
    });
  }

  // Generate fresh 7-day pre-signed URL for confirmed/checked-in tickets
  let qrCodeUrl: string | undefined;
  if (item.status === 'Confirmed' || item.status === 'CheckedIn') {
    try {
      qrCodeUrl = await getQrCodePresignedUrl(orgId, eventId, ticketId);
    } catch {
      // Non-fatal
    }
  }

  return toTicket(item, qrCodeUrl);
}

/**
 * Cancels a Ticket.
 * - Event must be in Draft, Published, or Open state.
 * - If cancelled ticket was Confirmed, promotes next waitlist ticket.
 * - Writes audit log.
 */
export async function cancelTicket(
  orgId: string,
  eventId: string,
  ticketId: string,
  tenantId: string,
  actorId: string,
  actorRole: string,
  sourceIp: string,
): Promise<Ticket> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'ticket.access_denied',
    });
  }

  // Fetch the event — cancellation only allowed in Draft/Published/Open
  const event = await eventRepo.getEventById(orgId, eventId, tenantId);
  if (!event) {
    throw Object.assign(new Error('Event not found or access denied.'), {
      statusCode: 403,
      errorCode: 'ticket.event_not_found',
    });
  }

  const cancellableEventStates = ['Draft', 'Published', 'Open'];
  if (!cancellableEventStates.includes(event.status)) {
    throw Object.assign(
      new Error(
        `Cannot cancel ticket for an event in ${event.status} state. ` +
          'Cancellation is only allowed for Draft, Published, or Open events.',
      ),
      { statusCode: 400, errorCode: 'ticket.event_not_cancellable' },
    );
  }

  // Fetch the ticket
  const ticket = await repo.getTicketById(orgId, eventId, ticketId, tenantId);
  if (!ticket) {
    throw Object.assign(new Error('Ticket not found or access denied.'), {
      statusCode: 403,
      errorCode: 'ticket.access_denied',
    });
  }

  // Members can only cancel their own tickets; Organizers can cancel any
  const isOrganizerOrAbove =
    actorRole === 'Owner' || actorRole === 'Admin' || actorRole === 'Organizer';
  if (!isOrganizerOrAbove) {
    assertPermission(actorRole, 'tickets:cancel-any'); // will throw if Member
    if (ticket.memberId !== actorId) {
      throw Object.assign(new Error('Access denied.'), {
        statusCode: 403,
        errorCode: 'ticket.access_denied',
      });
    }
  }

  const wasConfirmed = ticket.status === 'Confirmed';

  // Cancel the ticket
  const cancelled = await repo.cancelTicket(orgId, eventId, ticketId, tenantId);

  // If the cancelled ticket was Confirmed, promote the next waitlisted ticket
  if (wasConfirmed && NOTIFICATION_QUEUE_URL) {
    const nextWaitlisted = await repo.findNextWaitlistTicket(orgId, eventId, tenantId);
    if (nextWaitlisted) {
      await repo.promoteWaitlistTicket(
        orgId,
        eventId,
        nextWaitlisted.ticketId,
        tenantId,
        NOTIFICATION_QUEUE_URL,
      );
    }
  }

  // Write audit log
  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: actorId,
    targetType: 'TICKET',
    targetId: ticketId,
    operation: 'ticket.cancel',
    sourceIp,
    outcome: 'success',
    orgId,
    metadata: { eventId, previousStatus: ticket.status },
  });

  return toTicket(cancelled);
}

/**
 * Lists waitlisted tickets for an event, sorted by waitlistPosition ascending.
 * Organizer/Admin only.
 */
export async function listWaitlist(
  orgId: string,
  eventId: string,
  tenantId: string,
  callerRole: string,
  limit: number,
  nextToken?: string,
): Promise<{ tickets: Ticket[]; nextToken?: string }> {
  assertPermission(callerRole, 'tickets:list-all');

  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'ticket.access_denied',
    });
  }

  const result = await repo.listWaitlistedTickets(orgId, eventId, tenantId, limit, nextToken);
  return {
    tickets: result.tickets.map((t) => toTicket(t)),
    nextToken: result.nextToken,
  };
}
