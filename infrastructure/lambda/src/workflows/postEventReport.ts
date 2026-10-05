import {
  DynamoDBClient,
  UpdateItemCommand,
  PutItemCommand,
  QueryCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const dynamo = new DynamoDBClient({});
const s3 = new S3Client({});
const sqs = new SQSClient({});

const MAIN_TABLE = process.env.MAIN_TABLE ?? 'clois-main';
const AUDIT_LOG_TABLE = process.env.AUDIT_LOG_TABLE ?? 'clois-audit-log';
const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? 'clois-assets';
const NOTIFICATION_QUEUE_URL = process.env.NOTIFICATION_QUEUE_URL ?? '';

export interface PostEventReportInput {
  orgId: string;
  eventId: string;
  actorId?: string;
  correlationId: string;
}

export interface PostEventReportStepResult extends PostEventReportInput {
  stepName: string;
  timestamp: string;
  metrics?: EventMetrics;
  csvS3Key?: string;
  pdfS3Key?: string;
}

export interface EventMetrics {
  totalRegistrations: number;
  confirmedAttendees: number;
  checkedInCount: number;
  cancelledCount: number;
  waitlistedCount: number;
  attendanceRate: number;
  checkInRate: number;
}

// ─── Step: AggregateEventMetrics ─────────────────────────────────────────────

export async function aggregateEventMetrics(
  input: PostEventReportInput,
): Promise<PostEventReportStepResult> {
  const { orgId, eventId } = input;

  // Query all tickets for this event
  const result = await dynamo.send(
    new QueryCommand({
      TableName: MAIN_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      FilterExpression: 'tenantId = :orgId',
      ExpressionAttributeValues: marshall({
        ':pk': `ORG#${orgId}#EVENT#${eventId}`,
        ':skPrefix': 'TICKET#',
        ':orgId': orgId,
      }),
    }),
  );

  const tickets = (result.Items ?? []).map((item) => unmarshall(item));
  const totalRegistrations = tickets.length;
  const confirmedAttendees = tickets.filter((t) => t['status'] === 'Confirmed').length;
  const checkedInCount = tickets.filter((t) => t['checkedIn'] === true).length;
  const cancelledCount = tickets.filter((t) => t['status'] === 'Cancelled').length;
  const waitlistedCount = tickets.filter((t) => t['status'] === 'Waitlisted').length;

  const attendanceRate =
    totalRegistrations > 0
      ? Math.round((confirmedAttendees / totalRegistrations) * 100) / 100
      : 0;
  const checkInRate =
    confirmedAttendees > 0
      ? Math.round((checkedInCount / confirmedAttendees) * 100) / 100
      : 0;

  const metrics: EventMetrics = {
    totalRegistrations,
    confirmedAttendees,
    checkedInCount,
    cancelledCount,
    waitlistedCount,
    attendanceRate,
    checkInRate,
  };

  return {
    ...input,
    stepName: 'AggregateEventMetrics',
    timestamp: new Date().toISOString(),
    metrics,
  };
}

// ─── Step: GeneratePDFReport ──────────────────────────────────────────────────

export async function generatePDFReport(
  input: PostEventReportStepResult,
): Promise<PostEventReportStepResult> {
  const { orgId, eventId, correlationId, metrics } = input;

  // Fetch event details for the report
  const eventResult = await dynamo.send(
    new GetItemCommand({
      TableName: MAIN_TABLE,
      Key: marshall({ PK: `ORG#${orgId}#EVENT#${eventId}`, SK: 'METADATA' }),
    }),
  );

  const event = eventResult.Item ? unmarshall(eventResult.Item) : {};

  // Generate a structured PDF-like content (JSON for Lambda, actual PDF generation
  // would require a library like pdfmake or puppeteer in production)
  const reportContent = {
    title: `Post-Event Report: ${event['title'] ?? eventId}`,
    generatedAt: new Date().toISOString(),
    correlationId,
    orgId,
    eventId,
    eventTitle: event['title'],
    eventStartAt: event['startAt'],
    eventEndAt: event['endAt'],
    metrics,
    format: 'PDF',
  };

  const pdfS3Key = `reports/${orgId}/${eventId}/report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

  await s3.send(
    new PutObjectCommand({
      Bucket: ASSETS_BUCKET,
      Key: pdfS3Key,
      Body: JSON.stringify(reportContent, null, 2),
      ContentType: 'application/json',
      Metadata: {
        orgId,
        eventId,
        reportType: 'post-event-pdf',
        correlationId,
      },
    }),
  );

  return {
    ...input,
    stepName: 'GeneratePDFReport',
    timestamp: new Date().toISOString(),
    pdfS3Key,
  };
}

// ─── Step: GenerateCSVReport ──────────────────────────────────────────────────

export async function generateCSVReport(
  input: PostEventReportStepResult,
): Promise<PostEventReportStepResult> {
  const { orgId, eventId, correlationId, metrics } = input;

  // RFC 4180-compliant CSV
  const csvHeader = 'metric,value\r\n';
  const csvRows = metrics
    ? [
        `total_registrations,${metrics.totalRegistrations}`,
        `confirmed_attendees,${metrics.confirmedAttendees}`,
        `checked_in,${metrics.checkedInCount}`,
        `cancelled,${metrics.cancelledCount}`,
        `waitlisted,${metrics.waitlistedCount}`,
        `attendance_rate,${metrics.attendanceRate}`,
        `check_in_rate,${metrics.checkInRate}`,
      ]
        .map((row) => row + '\r\n')
        .join('')
    : '';

  const csvContent = csvHeader + csvRows;

  const csvS3Key = `reports/${orgId}/${eventId}/report-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;

  await s3.send(
    new PutObjectCommand({
      Bucket: ASSETS_BUCKET,
      Key: csvS3Key,
      Body: csvContent,
      ContentType: 'text/csv',
      Metadata: {
        orgId,
        eventId,
        reportType: 'post-event-csv',
        correlationId,
      },
    }),
  );

  return {
    ...input,
    stepName: 'GenerateCSVReport',
    timestamp: new Date().toISOString(),
    csvS3Key,
  };
}

// ─── Step: StoreReportsInS3 ───────────────────────────────────────────────────

export async function storeReportsInS3(
  input: PostEventReportStepResult,
): Promise<PostEventReportStepResult> {
  // S3 upload was already done in GeneratePDFReport and GenerateCSVReport.
  // This step records the S3 keys in the Analytics Record.
  return { ...input, stepName: 'StoreReportsInS3', timestamp: new Date().toISOString() };
}

// ─── Step: UpdateAnalyticsRecord ──────────────────────────────────────────────

export async function updateAnalyticsRecord(
  input: PostEventReportStepResult,
): Promise<PostEventReportStepResult> {
  const { orgId, eventId, metrics, pdfS3Key, csvS3Key } = input;
  const ts = new Date().toISOString();

  await dynamo.send(
    new UpdateItemCommand({
      TableName: MAIN_TABLE,
      Key: marshall({ PK: `ORG#${orgId}#EVENT#${eventId}`, SK: 'ANALYTICS' }),
      UpdateExpression: `
        SET reportStatus = :ready,
            csvS3Key = :csvKey,
            pdfS3Key = :pdfKey,
            reportGeneratedAt = :ts,
            totalRegistrations = :totalReg,
            confirmedAttendees = :confirmed,
            checkedInCount = :checkedIn,
            cancelledCount = :cancelled,
            waitlistedCount = :waitlisted,
            attendanceRate = :attRate,
            checkInRate = :ciRate,
            tenantId = :orgId,
            #type = :recordType
      `,
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: marshall({
        ':ready': 'Ready',
        ':csvKey': csvS3Key ?? '',
        ':pdfKey': pdfS3Key ?? '',
        ':ts': ts,
        ':totalReg': metrics?.totalRegistrations ?? 0,
        ':confirmed': metrics?.confirmedAttendees ?? 0,
        ':checkedIn': metrics?.checkedInCount ?? 0,
        ':cancelled': metrics?.cancelledCount ?? 0,
        ':waitlisted': metrics?.waitlistedCount ?? 0,
        ':attRate': metrics?.attendanceRate ?? 0,
        ':ciRate': metrics?.checkInRate ?? 0,
        ':orgId': orgId,
        ':recordType': 'ANALYTICS_REPORT',
      }),
    }),
  );

  return { ...input, stepName: 'UpdateAnalyticsRecord', timestamp: ts };
}

// ─── Step: NotifyAdminsReportReady ────────────────────────────────────────────

export async function notifyAdminsReportReady(
  input: PostEventReportStepResult,
): Promise<PostEventReportStepResult> {
  const { orgId, eventId, correlationId } = input;

  if (!NOTIFICATION_QUEUE_URL) {
    return { ...input, stepName: 'NotifyAdminsReportReady', timestamp: new Date().toISOString() };
  }

  // Query org admins and owners to notify them
  const result = await dynamo.send(
    new QueryCommand({
      TableName: MAIN_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      FilterExpression: 'tenantId = :orgId AND #role IN (:admin, :owner)',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: marshall({
        ':pk': `ORG#${orgId}`,
        ':skPrefix': 'MEMBER#',
        ':orgId': orgId,
        ':admin': 'Admin',
        ':owner': 'Owner',
      }),
    }),
  );

  const adminMembers = (result.Items ?? []).map((item) => unmarshall(item));

  for (const member of adminMembers) {
    if (!member['memberId']) continue;
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: NOTIFICATION_QUEUE_URL,
        MessageBody: JSON.stringify({
          type: 'REPORT_READY',
          orgId,
          eventId,
          recipientMemberId: member['memberId'],
          pdfS3Key: input.pdfS3Key,
          csvS3Key: input.csvS3Key,
          correlationId,
        }),
      }),
    );
  }

  return {
    ...input,
    stepName: 'NotifyAdminsReportReady',
    timestamp: new Date().toISOString(),
  };
}

// ─── Step: WriteAuditLog ──────────────────────────────────────────────────────

export async function writeAuditLog(
  input: PostEventReportStepResult,
): Promise<PostEventReportStepResult> {
  const { orgId, eventId, actorId, correlationId } = input;
  const ts = new Date().toISOString();

  await dynamo.send(
    new PutItemCommand({
      TableName: AUDIT_LOG_TABLE,
      Item: marshall({
        PK: `ORG#${orgId}`,
        SK: `AUDIT#${ts}#${correlationId}`,
        type: 'AUDIT_LOG',
        tenantId: orgId,
        timestamp: ts,
        actor: actorId ?? 'system',
        targetType: 'EVENT',
        targetId: eventId,
        operation: 'event.post_event_report_generated',
        sourceIp: 'system',
        outcome: 'success',
        correlationId,
        csvS3Key: input.csvS3Key ?? '',
        pdfS3Key: input.pdfS3Key ?? '',
      }),
    }),
  );

  return { ...input, stepName: 'WriteAuditLog', timestamp: ts };
}

// ─── Step: MarkWorkflowFailed (catch-all) ────────────────────────────────────

export async function markWorkflowFailed(
  input: PostEventReportInput & { error?: string },
): Promise<void> {
  const { orgId, eventId, correlationId, error } = input;
  const ts = new Date().toISOString();

  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: AUDIT_LOG_TABLE,
        Item: marshall({
          PK: `ORG#${orgId}`,
          SK: `AUDIT#${ts}#${correlationId}`,
          type: 'AUDIT_LOG',
          tenantId: orgId,
          timestamp: ts,
          actor: 'system',
          targetType: 'EVENT',
          targetId: eventId,
          operation: 'event.post_event_report_workflow_failed',
          sourceIp: 'system',
          outcome: 'failure',
          correlationId,
          errorDetail: (error ?? 'Unknown error').slice(0, 500),
        }),
      }),
    );
  } catch {
    process.stderr.write(
      JSON.stringify({
        level: 'ERROR',
        message: 'Failed to write post-event report workflow-failed audit log',
        orgId,
        eventId,
        correlationId,
      }) + '\n',
    );
  }
}
