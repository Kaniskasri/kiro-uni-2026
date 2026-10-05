import { SQSEvent, SQSRecord } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import * as repo from '../analytics/repository';

const s3 = new S3Client({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
const sqs = new SQSClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });

const ASSETS_BUCKET = process.env['ASSETS_BUCKET'] ?? 'clois-assets';
const NOTIFICATION_QUEUE_URL = process.env['NOTIFICATION_QUEUE_URL'] ?? '';

// ─── RFC 4180 compliant CSV builder ──────────────────────────────────────────

function escapeCSVField(value: unknown): string {
  const str = String(value ?? '');
  // RFC 4180: fields with commas, double quotes, or newlines must be enclosed in double quotes
  if (str.includes('"') || str.includes(',') || str.includes('\r') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function buildCSV(headers: string[], rows: Record<string, unknown>[]): string {
  const headerLine = headers.map(escapeCSVField).join(',');
  const dataLines = rows.map((row) =>
    headers.map((h) => escapeCSVField(row[h])).join(','),
  );
  return [headerLine, ...dataLines].join('\r\n');
}

// ─── Simple PDF builder (text-based, no pdfkit dependency needed) ─────────────

function buildTextReport(title: string, rows: Record<string, unknown>[]): string {
  const lines: string[] = [
    `CLOIS Analytics Report`,
    `Generated: ${new Date().toISOString()}`,
    `Title: ${title}`,
    ``,
    `=== Metrics ===`,
  ];

  for (const row of rows) {
    for (const [key, val] of Object.entries(row)) {
      lines.push(`${key}: ${val}`);
    }
    lines.push('---');
  }

  return lines.join('\n');
}

// ─── Process a single SQS record ─────────────────────────────────────────────

async function processRecord(record: SQSRecord): Promise<void> {
  let message: {
    type: string;
    orgId: string;
    tenantId: string;
    eventId?: string;
    jobId?: string;
    dateRangeStart?: string;
    dateRangeEnd?: string;
    format?: string;
  };

  try {
    message = JSON.parse(record.body);
  } catch {
    process.stderr.write(`[ReportWorker] Invalid JSON in SQS message: ${record.body}\n`);
    throw new Error('Invalid message format — routing to DLQ');
  }

  const { type, orgId, tenantId } = message;

  if (type === 'event_report' && message.eventId) {
    await processEventReport(orgId, message.eventId, tenantId, message.format ?? 'csv');
  } else if (type === 'trend_report' && message.jobId) {
    await processTrendReport(
      orgId,
      tenantId,
      message.jobId,
      message.dateRangeStart ?? '',
      message.dateRangeEnd ?? '',
    );
  } else {
    throw new Error(`Unknown message type: ${type}`);
  }
}

async function processEventReport(
  orgId: string,
  eventId: string,
  tenantId: string,
  format: string,
): Promise<void> {
  // Aggregate metrics
  const metrics = await repo.getTicketMetricsForEvent(orgId, eventId, tenantId);
  const now = new Date().toISOString();

  const attendanceRate =
    metrics.confirmedCount > 0
      ? Math.min(100, (metrics.checkedInCount / metrics.confirmedCount) * 100)
      : 0;
  const checkInRate = attendanceRate;

  const row = {
    orgId,
    eventId,
    confirmedCount: metrics.confirmedCount,
    checkedInCount: metrics.checkedInCount,
    waitlistCount: metrics.waitlistCount,
    cancellationCount: metrics.cancellationCount,
    totalRegistrations: metrics.totalRegistrations,
    attendanceRate: Math.round(attendanceRate * 100) / 100,
    checkInRate: Math.round(checkInRate * 100) / 100,
    generatedAt: now,
  };

  const csvKey = `reports/${orgId}/${eventId}/analytics.csv`;
  const pdfKey = `reports/${orgId}/${eventId}/analytics.txt`;

  // Generate CSV (RFC 4180)
  const csv = buildCSV(Object.keys(row), [row]);
  await s3.send(
    new PutObjectCommand({
      Bucket: ASSETS_BUCKET,
      Key: csvKey,
      Body: csv,
      ContentType: 'text/csv',
    }),
  );

  // Generate text-based report (PDF substitute)
  const pdfContent = buildTextReport(`Event Analytics: ${eventId}`, [row]);
  await s3.send(
    new PutObjectCommand({
      Bucket: ASSETS_BUCKET,
      Key: pdfKey,
      Body: pdfContent,
      ContentType: 'text/plain',
    }),
  );

  // Update DynamoDB
  await repo.updateAnalyticsReportStatus(orgId, eventId, tenantId, 'Ready', {
    csvS3Key: csvKey,
    pdfS3Key: pdfKey,
    reportGeneratedAt: now,
  });

  // Notify admins
  if (NOTIFICATION_QUEUE_URL) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: NOTIFICATION_QUEUE_URL,
        MessageBody: JSON.stringify({
          type: 'REPORT_READY',
          orgId,
          eventId,
          csvS3Key: csvKey,
          pdfS3Key: pdfKey,
          generatedAt: now,
        }),
      }),
    );
  }
}

async function processTrendReport(
  orgId: string,
  tenantId: string,
  jobId: string,
  dateRangeStart: string,
  dateRangeEnd: string,
): Promise<void> {
  const now = new Date().toISOString();

  // Get all events in range
  const events = await repo.getEventsInDateRange(orgId, tenantId, dateRangeStart, dateRangeEnd);

  let totalAttendanceRate = 0;
  let totalCheckInRate = 0;
  let totalTickets = 0;
  let totalCancellations = 0;

  const rows: Record<string, unknown>[] = [];

  for (const ev of events) {
    const m = await repo.getTicketMetricsForEvent(orgId, ev.eventId, tenantId);
    const ar = ev.capacity > 0 ? (m.confirmedCount / ev.capacity) * 100 : 0;
    const cr = m.confirmedCount > 0 ? (m.checkedInCount / m.confirmedCount) * 100 : 0;
    totalAttendanceRate += ar;
    totalCheckInRate += cr;
    totalTickets += m.confirmedCount;
    totalCancellations += m.cancellationCount;

    rows.push({
      eventId: ev.eventId,
      confirmedCount: m.confirmedCount,
      checkedInCount: m.checkedInCount,
      waitlistCount: m.waitlistCount,
      cancellationCount: m.cancellationCount,
      attendanceRate: Math.round(ar * 100) / 100,
      checkInRate: Math.round(cr * 100) / 100,
    });
  }

  const count = events.length || 1;
  const avgAttendanceRate = Math.round((totalAttendanceRate / count) * 100) / 100;
  const avgCheckInRate = Math.round((totalCheckInRate / count) * 100) / 100;

  const csvKey = `reports/${orgId}/trend/${jobId}/trend.csv`;
  const pdfKey = `reports/${orgId}/trend/${jobId}/trend.txt`;

  const headers = [
    'eventId',
    'confirmedCount',
    'checkedInCount',
    'waitlistCount',
    'cancellationCount',
    'attendanceRate',
    'checkInRate',
  ];
  const csv = buildCSV(headers, rows);

  await s3.send(
    new PutObjectCommand({
      Bucket: ASSETS_BUCKET,
      Key: csvKey,
      Body: csv,
      ContentType: 'text/csv',
    }),
  );

  const summaryRow = {
    dateRangeStart,
    dateRangeEnd,
    eventCount: events.length,
    avgAttendanceRate,
    avgCheckInRate,
    totalTickets,
    totalCancellations,
    generatedAt: now,
  };

  const pdfContent = buildTextReport('Trend Report', [summaryRow, ...rows]);
  await s3.send(
    new PutObjectCommand({
      Bucket: ASSETS_BUCKET,
      Key: pdfKey,
      Body: pdfContent,
      ContentType: 'text/plain',
    }),
  );

  // Update trend report in DynamoDB
  await repo.updateTrendReportStatus(orgId, jobId, tenantId, 'Ready', {
    avgAttendanceRate,
    avgCheckInRate,
    totalTickets,
    totalCancellations,
    csvS3Key: csvKey,
    pdfS3Key: pdfKey,
    reportGeneratedAt: now,
  });

  // Push REPORT_READY WebSocket event via notification queue
  if (NOTIFICATION_QUEUE_URL) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: NOTIFICATION_QUEUE_URL,
        MessageBody: JSON.stringify({
          type: 'REPORT_READY',
          orgId,
          jobId,
          csvS3Key: csvKey,
          generatedAt: now,
        }),
      }),
    );
  }
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

export const handler = async (event: SQSEvent): Promise<void> => {
  const failures: string[] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      const error = err as Error;
      process.stderr.write(
        JSON.stringify({
          level: 'ERROR',
          message: error.message,
          stack: error.stack,
          messageId: record.messageId,
        }) + '\n',
      );
      failures.push(record.messageId);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to process ${failures.length} records: ${failures.join(', ')}`);
  }
};
