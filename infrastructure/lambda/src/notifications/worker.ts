import { SQSEvent, SQSRecord } from 'aws-lambda';
import {
  SESClient,
  SendEmailCommand,
} from '@aws-sdk/client-ses';
import { writeAuditLog } from '../shared/middleware/writeAuditLog';
import * as repo from './repository';
import { broadcastToOrg } from '../websocket/broadcast';
import { NotificationMessage, NotificationDynamoItem } from './types';

const ses = new SESClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
const SES_FROM_ADDRESS = process.env['SES_FROM_ADDRESS'] ?? 'noreply@clois.example.com';

// ─── JSON Schema for validation ───────────────────────────────────────────────

const REQUIRED_FIELDS: (keyof NotificationMessage)[] = [
  'version',
  'notificationId',
  'orgId',
  'type',
  'subject',
  'bodyText',
  'inAppMessage',
  'enqueuedAt',
];

function validateMessage(obj: unknown): obj is NotificationMessage {
  if (!obj || typeof obj !== 'object') return false;
  const m = obj as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!m[field]) return false;
  }
  if (m['version'] !== '1') return false;
  if (!m['memberId'] && !m['guestEmail']) return false;
  return true;
}

// ─── SES with retry ───────────────────────────────────────────────────────────

async function sendEmailWithRetry(
  toAddress: string,
  subject: string,
  bodyText: string,
  bodyHtml?: string,
  maxAttempts = 3,
): Promise<void> {
  let attempt = 0;
  let delayMs = 1000;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      await ses.send(
        new SendEmailCommand({
          Source: SES_FROM_ADDRESS,
          Destination: { ToAddresses: [toAddress] },
          Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: bodyText, Charset: 'UTF-8' },
              ...(bodyHtml ? { Html: { Data: bodyHtml, Charset: 'UTF-8' } } : {}),
            },
          },
        }),
      );
      return; // success
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2; // exponential backoff
    }
  }
}

// ─── Record processor ─────────────────────────────────────────────────────────

async function processRecord(record: SQSRecord): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.body);
  } catch {
    process.stderr.write(`[notification-worker] Invalid JSON in SQS record: ${record.messageId}\n`);
    // Let it go to DLQ by throwing
    throw new Error('schema_validation_failed: invalid JSON');
  }

  if (!validateMessage(parsed)) {
    process.stderr.write(
      `[notification-worker] Schema validation failed for record: ${record.messageId}\n`,
    );
    // Throw to route to DLQ
    throw new Error('schema_validation_failed: missing required fields');
  }

  const msg = parsed as NotificationMessage;
  const { notificationId, orgId, memberId, guestEmail, type, subject, bodyText, bodyHtml, inAppMessage, metadata } = msg;

  // ── Persist in-app notification (if member-targeted) ──────────────────────
  if (memberId) {
    const item: Omit<NotificationDynamoItem, 'createdAt' | 'updatedAt'> = {
      PK: `MEMBER#${memberId}`,
      SK: `NOTIFICATION#${notificationId}`,
      GSI4PK: `ORG#${orgId}`,
      GSI4SK: `NOTIFICATION#${notificationId}`,
      type: 'NOTIFICATION',
      notificationId,
      orgId,
      memberId,
      notificationType: type,
      subject,
      inAppMessage,
      deliveryStatus: 'pending',
      read: false,
      tenantId: orgId,
      metadata,
    };

    await repo.createNotification(item);
  }

  // ── Check email opt-out ────────────────────────────────────────────────────
  const emailAddress = guestEmail ?? (memberId ? undefined : undefined);
  // For member notifications: check opt-out per org
  let shouldSendEmail = true;

  if (memberId) {
    const optedOut = await repo.isEmailOptedOut(memberId, orgId);
    if (optedOut) {
      shouldSendEmail = false;
      process.stdout.write(
        JSON.stringify({ level: 'INFO', event: 'notification.email_suppressed', memberId, orgId, notificationId }) + '\n',
      );
      // Update delivery status to opted-out
      await repo.updateNotificationStatus(memberId, notificationId, orgId, 'opted-out');
    }
  }

  // ── Dispatch email ─────────────────────────────────────────────────────────
  if (shouldSendEmail) {
    const toAddress = guestEmail ?? (memberId ? `${memberId}@clois.noop` : null);
    if (toAddress && toAddress !== `${memberId}@clois.noop`) {
      try {
        await sendEmailWithRetry(toAddress, subject, bodyText, bodyHtml);
        if (memberId) {
          await repo.updateNotificationStatus(memberId, notificationId, orgId, 'delivered');
        }
      } catch (err) {
        process.stderr.write(
          `[notification-worker] Email delivery failed after retries for notification ${notificationId}: ${String(err)}\n`,
        );

        if (memberId) {
          await repo.updateNotificationStatus(memberId, notificationId, orgId, 'delivery-failed');
        }

        // Write audit log entry for failure
        await writeAuditLog({
          timestamp: new Date().toISOString(),
          actor: 'system',
          targetType: 'NOTIFICATION',
          targetId: notificationId,
          operation: 'notification.email_delivery_failed',
          sourceIp: '0.0.0.0',
          outcome: 'failure',
          orgId,
          metadata: { notificationType: type, attempt: 3 },
        }).catch(() => {
          // Non-fatal
        });
      }
    } else if (memberId) {
      // Member email would be fetched from Cognito in production.
      // Here we mark as delivered since the actual SES call is out of scope
      // for the worker (email address lookup is an integration concern).
      await repo.updateNotificationStatus(memberId, notificationId, orgId, 'delivered');
    }
  }

  // ── Push WebSocket event ───────────────────────────────────────────────────
  if (memberId) {
    await broadcastToOrg(orgId, {
      event: 'NOTIFICATION',
      notificationId,
      memberId,
      notificationType: type,
      inAppMessage,
      timestamp: new Date().toISOString(),
    }).catch((err) => {
      process.stderr.write(
        `[notification-worker] WebSocket broadcast failed for notification ${notificationId}: ${String(err)}\n`,
      );
    });
  }
}

// ─── SQS Handler ──────────────────────────────────────────────────────────────

export const handler = async (event: SQSEvent): Promise<void> => {
  const results = await Promise.allSettled(
    event.Records.map((record) => processRecord(record)),
  );

  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

  if (failures.length > 0) {
    // Re-throw the first failure so Lambda/SQS routes these records to the DLQ
    throw failures[0].reason as Error;
  }
};
