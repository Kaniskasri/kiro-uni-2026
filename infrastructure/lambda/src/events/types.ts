// ─── Event lifecycle states ────────────────────────────────────────────────────

export type EventStatus =
  | 'Draft'
  | 'Published'
  | 'Open'
  | 'In_Progress'
  | 'Completed'
  | 'Archived'
  | 'Cancelled';

// Valid state machine transitions (immutable — do not deviate)
//
//  Draft → Published → Open → In_Progress → Completed → Archived
//  Draft → Cancelled
//  Published → Cancelled
//  Open → Cancelled
//  In_Progress → Cancelled
//  Completed → Archived  (also reachable from the main chain above)
//  Cancelled and Archived are terminal states — no further transitions
export const VALID_TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  Draft: ['Published', 'Cancelled'],
  Published: ['Open', 'Cancelled'],
  Open: ['In_Progress', 'Cancelled'],
  In_Progress: ['Completed', 'Cancelled'],
  Completed: ['Archived'],
  Archived: [],
  Cancelled: [],
};

// ─── Domain types ─────────────────────────────────────────────────────────────

export interface Event {
  eventId: string;
  orgId: string;
  title: string;
  description?: string;
  status: EventStatus;
  startAt: string;   // UTC ISO 8601
  endAt: string;     // UTC ISO 8601
  timezone: string;  // IANA timezone
  capacity: number;
  venueId?: string;
  address?: string;
  meetingUrl?: string;
  isVirtual: boolean;
  tenantId: string;  // equals orgId
  createdAt: string; // UTC ISO 8601
  updatedAt: string; // UTC ISO 8601
}

// ─── Request / Response types ──────────────────────────────────────────────────

export interface CreateEventRequest {
  title: string;
  description?: string;
  startAt: string;
  endAt: string;
  timezone: string;
  capacity: number;
  venueId?: string;
  address?: string;
  meetingUrl?: string;
  isVirtual?: boolean;
}

export interface UpdateEventRequest {
  title?: string;
  description?: string;
  startAt?: string;
  endAt?: string;
  timezone?: string;
  capacity?: number;
  venueId?: string;
  address?: string;
  meetingUrl?: string;
  isVirtual?: boolean;
}

// ─── DynamoDB item shape ───────────────────────────────────────────────────────

export interface EventDynamoItem {
  PK: string;       // ORG#{orgId}#EVENT#{eventId}
  SK: string;       // METADATA
  GSI2PK: string;   // ORG#{orgId}#STATUS#{status}
  GSI2SK: string;   // startAt (UTC ISO 8601)
  type: 'EVENT';
  eventId: string;
  orgId: string;
  title: string;
  description?: string;
  status: EventStatus;
  startAt: string;
  endAt: string;
  timezone: string;
  capacity: number;
  venueId?: string;
  address?: string;
  meetingUrl?: string;
  isVirtual: boolean;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
}
