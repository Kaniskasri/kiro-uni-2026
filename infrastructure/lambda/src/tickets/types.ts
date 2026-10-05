// ─── Ticket status ─────────────────────────────────────────────────────────────

export type TicketStatus = 'Confirmed' | 'Waitlisted' | 'Cancelled' | 'CheckedIn';

// ─── Domain types ─────────────────────────────────────────────────────────────

export interface Ticket {
  ticketId: string;
  orgId: string;
  eventId: string;
  memberId?: string;        // set if registered member
  guestEmail?: string;      // set if guest RSVP
  guestName?: string;
  status: TicketStatus;
  ticketCode: string;       // UUID used for QR scan lookup
  waitlistPosition?: number; // only set for Waitlisted tickets
  qrCodeUrl?: string;       // 7-day pre-signed S3 URL
  checkedInAt?: string;     // UTC ISO 8601; only set when CheckedIn
  tenantId: string;         // equals orgId
  createdAt: string;        // UTC ISO 8601
  updatedAt: string;        // UTC ISO 8601
}

// ─── Request types ─────────────────────────────────────────────────────────────

export interface CreateTicketRequest {
  memberId?: string;
  guestEmail?: string;
  guestName?: string;
}

// ─── DynamoDB item shape ───────────────────────────────────────────────────────

export interface TicketDynamoItem {
  PK: string;       // ORG#{orgId}#EVENT#{eventId}#TICKET#{ticketId}
  SK: string;       // METADATA
  GSI1PK: string;   // TICKETCODE#{ticketCode}
  GSI1SK: string;   // TICKET#{ticketId}
  GSI3PK: string;   // MEMBER#{memberId}#EVENT#{eventId} | GUEST#{email}#EVENT#{eventId}
  GSI3SK: string;   // TICKET#{ticketId}
  type: 'TICKET';
  ticketId: string;
  orgId: string;
  eventId: string;
  memberId?: string;
  guestEmail?: string;
  guestName?: string;
  status: TicketStatus;
  ticketCode: string;
  waitlistPosition?: number;
  checkedInAt?: string;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
}
