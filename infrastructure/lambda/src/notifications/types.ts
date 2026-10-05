// ─── Notification types ───────────────────────────────────────────────────────

export type NotificationType =
  | 'ticket.confirmed'
  | 'ticket.waitlist_promoted'
  | 'ticket.cancelled'
  | 'event.reminder'
  | 'event.cancelled'
  | 'event.published'
  | 'checkin.capacity_warning'
  | 'checkin.capacity_full'
  | 'checkin.update'
  | 'announcement'
  | 'report.ready';

export type DeliveryStatus = 'pending' | 'delivered' | 'delivery-failed' | 'opted-out';

// ─── SQS message schema ───────────────────────────────────────────────────────

export interface NotificationMessage {
  /** Notification message schema version */
  version: '1';
  /** Unique ID for idempotency */
  notificationId: string;
  orgId: string;
  memberId?: string;
  /** For guest notifications without a Member record */
  guestEmail?: string;
  type: NotificationType;
  subject: string;
  /** Plain-text body for email */
  bodyText: string;
  /** HTML body for email */
  bodyHtml?: string;
  /** Short in-app message */
  inAppMessage: string;
  /** ISO 8601 UTC timestamp when message was enqueued */
  enqueuedAt: string;
  /** Optional domain-specific metadata (no PII) */
  metadata?: Record<string, unknown>;
}

// ─── DynamoDB item ────────────────────────────────────────────────────────────

export interface NotificationDynamoItem {
  PK: string;          // MEMBER#{memberId}
  SK: string;          // NOTIFICATION#{notificationId}
  GSI4PK: string;      // ORG#{orgId}
  GSI4SK: string;      // NOTIFICATION#{notificationId}
  type: 'NOTIFICATION';
  notificationId: string;
  orgId: string;
  memberId: string;
  notificationType: NotificationType;
  subject: string;
  inAppMessage: string;
  deliveryStatus: DeliveryStatus;
  read: boolean;
  tenantId: string;
  createdAt: string;   // UTC ISO 8601
  updatedAt: string;   // UTC ISO 8601
  metadata?: Record<string, unknown>;
}

// ─── Opt-out record ───────────────────────────────────────────────────────────

export interface OptOutDynamoItem {
  PK: string;          // MEMBER#{memberId}
  SK: string;          // OPTOUT#ORG#{orgId}
  type: 'EMAIL_OPT_OUT';
  memberId: string;
  orgId: string;
  tenantId: string;
  optedOutAt: string;
  createdAt: string;
  updatedAt: string;
}

// ─── REST response types ──────────────────────────────────────────────────────

export interface NotificationResponse {
  notificationId: string;
  orgId: string;
  memberId: string;
  notificationType: NotificationType;
  subject: string;
  inAppMessage: string;
  deliveryStatus: DeliveryStatus;
  read: boolean;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}
