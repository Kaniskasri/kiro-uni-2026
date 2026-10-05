import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';
import { assertPermission } from '../shared/layers/rbac';
import { writeAuditLog } from '../shared/middleware/writeAuditLog';
import * as repo from './repository';
import { AnalyticsReport, TrendReport } from './types';

const s3 = new S3Client({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
const sqs = new SQSClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });

const ASSETS_BUCKET = process.env['ASSETS_BUCKET'] ?? 'clois-assets';
const REPORT_QUEUE_URL = process.env['REPORT_QUEUE_URL'] ?? '';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toAnalyticsReport(item: repo.TicketMetrics & {
  reportId: string;
  orgId: string;
  eventId: string;
  tenantId: string;
  reportStatus: import('./types').ReportStatus;
  csvS3Key?: string;
  pdfS3Key?: string;
  reportGeneratedAt?: string;
  sentimentScore?: number;
  positiveThemes?: string[];
  negativeThemes?: string[];
  createdAt: string;
  updatedAt: string;
  capacity?: number;
}): AnalyticsReport {
  const confirmedCount = item.confirmedCount;
  const checkedInCount = item.checkedInCount;
  const capacity = item.capacity ?? confirmedCount; // fallback

  const attendanceRate =
    capacity > 0 ? Math.min(100, (confirmedCount / capacity) * 100) : 0;
  const checkInRate =
    confirmedCount > 0 ? Math.min(100, (checkedInCount / confirmedCount) * 100) : 0;

  return {
    reportId: item.reportId,
    orgId: item.orgId,
    eventId: item.eventId,
    tenantId: item.tenantId,
    reportStatus: item.reportStatus,
    attendanceRate: Math.round(attendanceRate * 100) / 100,
    checkInRate: Math.round(checkInRate * 100) / 100,
    waitlistCount: item.waitlistCount,
    cancellationCount: item.cancellationCount,
    confirmedCount,
    checkedInCount,
    totalRegistrations: item.totalRegistrations,
    csvS3Key: item.csvS3Key,
    pdfS3Key: item.pdfS3Key,
    reportGeneratedAt: item.reportGeneratedAt,
    sentimentScore: item.sentimentScore,
    positiveThemes: item.positiveThemes,
    negativeThemes: item.negativeThemes,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

// ─── Get event analytics ──────────────────────────────────────────────────────

export async function getEventAnalytics(
  orgId: string,
  eventId: string,
  tenantId: string,
  callerRole: string,
  callerMemberId: string,
): Promise<AnalyticsReport> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'analytics.access_denied',
    });
  }

  // Organizer: own events only (simplified — full impl checks event ownership)
  // Admin: all org events
  assertPermission(callerRole, 'analytics:view-own');

  // Try stored report first
  const stored = await repo.getAnalyticsReport(orgId, eventId, tenantId);

  if (stored) {
    const metrics = await repo.getTicketMetricsForEvent(orgId, eventId, tenantId);
    return toAnalyticsReport({
      ...metrics,
      reportId: stored.reportId,
      orgId: stored.orgId,
      eventId: stored.eventId,
      tenantId: stored.tenantId,
      reportStatus: stored.reportStatus,
      csvS3Key: stored.csvS3Key,
      pdfS3Key: stored.pdfS3Key,
      reportGeneratedAt: stored.reportGeneratedAt,
      sentimentScore: stored.sentimentScore,
      positiveThemes: stored.positiveThemes,
      negativeThemes: stored.negativeThemes,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    });
  }

  // Compute on the fly
  const metrics = await repo.getTicketMetricsForEvent(orgId, eventId, tenantId);
  const now = new Date().toISOString();
  const reportId = randomUUID();

  const saved = await repo.upsertAnalyticsReport({
    type: 'ANALYTICS_REPORT',
    reportId,
    orgId,
    eventId,
    tenantId,
    reportStatus: 'Ready',
    ...metrics,
    attendanceRate: 0,  // computed in toAnalyticsReport
    checkInRate: 0,
    createdAt: now,
    updatedAt: now,
  });

  return toAnalyticsReport({
    ...metrics,
    reportId: saved.reportId,
    orgId: saved.orgId,
    eventId: saved.eventId,
    tenantId: saved.tenantId,
    reportStatus: saved.reportStatus,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  });
}

// ─── Trend report ─────────────────────────────────────────────────────────────

export async function requestTrendReport(
  orgId: string,
  tenantId: string,
  callerRole: string,
  actorId: string,
  sourceIp: string,
  dateRangeStart: string,
  dateRangeEnd: string,
): Promise<{ jobId?: string; report?: TrendReport; async: boolean }> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'analytics.access_denied',
    });
  }

  assertPermission(callerRole, 'analytics:view-all');

  const eventCount = await repo.countEventsInDateRange(orgId, tenantId, dateRangeStart, dateRangeEnd);

  if (eventCount <= 100) {
    // Sync aggregation
    const events = await repo.getEventsInDateRange(orgId, tenantId, dateRangeStart, dateRangeEnd);

    let totalAttendanceRate = 0;
    let totalCheckInRate = 0;
    let totalTickets = 0;
    let totalCancellations = 0;

    for (const ev of events) {
      const m = await repo.getTicketMetricsForEvent(orgId, ev.eventId, tenantId);
      const ar = ev.capacity > 0 ? (m.confirmedCount / ev.capacity) * 100 : 0;
      const cr = m.confirmedCount > 0 ? (m.checkedInCount / m.confirmedCount) * 100 : 0;
      totalAttendanceRate += ar;
      totalCheckInRate += cr;
      totalTickets += m.confirmedCount + m.checkedInCount;
      totalCancellations += m.cancellationCount;
    }

    const count = events.length || 1;
    const reportId = randomUUID();
    const now = new Date().toISOString();

    const report: TrendReport = {
      reportId,
      orgId,
      tenantId,
      reportStatus: 'Ready',
      dateRangeStart,
      dateRangeEnd,
      eventCount,
      avgAttendanceRate: Math.round((totalAttendanceRate / count) * 100) / 100,
      avgCheckInRate: Math.round((totalCheckInRate / count) * 100) / 100,
      totalTickets,
      totalCancellations,
      reportGeneratedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    // Persist
    await repo.createTrendReport(orgId, tenantId, dateRangeStart, dateRangeEnd, eventCount);

    await writeAuditLog({
      timestamp: now,
      actor: actorId,
      targetType: 'TREND_REPORT',
      targetId: reportId,
      operation: 'analytics.trend_report',
      sourceIp,
      outcome: 'success',
      orgId,
    });

    return { report, async: false };
  }

  // Async: enqueue
  const trendItem = await repo.createTrendReport(orgId, tenantId, dateRangeStart, dateRangeEnd, eventCount);

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: REPORT_QUEUE_URL,
      MessageBody: JSON.stringify({
        jobId: trendItem.reportId,
        orgId,
        tenantId,
        dateRangeStart,
        dateRangeEnd,
        type: 'trend_report',
      }),
    }),
  );

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: actorId,
    targetType: 'TREND_REPORT',
    targetId: trendItem.reportId,
    operation: 'analytics.trend_report_enqueued',
    sourceIp,
    outcome: 'success',
    orgId,
  });

  return { jobId: trendItem.reportId, async: true };
}

export async function getTrendReportStatus(
  orgId: string,
  reportId: string,
  tenantId: string,
  callerRole: string,
): Promise<TrendReport> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'analytics.access_denied',
    });
  }

  assertPermission(callerRole, 'analytics:view-all');

  const item = await repo.getTrendReport(orgId, reportId, tenantId);
  if (!item) {
    throw Object.assign(new Error('Report not found or access denied.'), {
      statusCode: 403,
      errorCode: 'analytics.access_denied',
    });
  }

  return {
    reportId: item.reportId,
    orgId: item.orgId,
    tenantId: item.tenantId,
    reportStatus: item.reportStatus,
    dateRangeStart: item.dateRangeStart,
    dateRangeEnd: item.dateRangeEnd,
    eventCount: item.eventCount,
    avgAttendanceRate: item.avgAttendanceRate,
    avgCheckInRate: item.avgCheckInRate,
    totalTickets: item.totalTickets,
    totalCancellations: item.totalCancellations,
    csvS3Key: item.csvS3Key,
    pdfS3Key: item.pdfS3Key,
    reportGeneratedAt: item.reportGeneratedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

// ─── Export analytics ─────────────────────────────────────────────────────────

export async function getAnalyticsExport(
  orgId: string,
  eventId: string,
  tenantId: string,
  callerRole: string,
  format: 'csv' | 'pdf',
): Promise<{ presignedUrl: string }> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'analytics.access_denied',
    });
  }

  assertPermission(callerRole, 'analytics:export');

  const stored = await repo.getAnalyticsReport(orgId, eventId, tenantId);
  const s3Key = format === 'csv' ? stored?.csvS3Key : stored?.pdfS3Key;

  if (!s3Key) {
    // Enqueue for generation
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: REPORT_QUEUE_URL,
        MessageBody: JSON.stringify({
          orgId,
          eventId,
          tenantId,
          format,
          type: 'event_report',
        }),
      }),
    );

    throw Object.assign(
      new Error('Export is being generated. Please try again in a few moments.'),
      { statusCode: 202, errorCode: 'analytics.export_generating' },
    );
  }

  // 24-hour pre-signed URL
  const command = new GetObjectCommand({
    Bucket: ASSETS_BUCKET,
    Key: s3Key,
  });

  const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 86400 });
  return { presignedUrl };
}

// ─── Calculate dashboard metrics (pure function for property testing) ─────────

export function calculateAttendanceRate(checkedIn: number, confirmed: number): number {
  if (confirmed <= 0) return 0;
  const rate = (checkedIn / confirmed) * 100;
  return Math.max(0, Math.min(100, Math.round(rate * 100) / 100));
}

export function calculateCheckInRate(checkedIn: number, confirmed: number): number {
  return calculateAttendanceRate(checkedIn, confirmed);
}
