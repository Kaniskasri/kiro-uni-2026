import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import {
  AnalyticsReportDynamoItem,
  TrendReportDynamoItem,
  ReportStatus,
} from './types';

const client = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
const dynamo = DynamoDBDocumentClient.from(client);

const TABLE = process.env['MAIN_TABLE'] ?? 'clois-main';

// ─── Analytics Report ─────────────────────────────────────────────────────────

export async function getAnalyticsReport(
  orgId: string,
  eventId: string,
  tenantId: string,
): Promise<AnalyticsReportDynamoItem | null> {
  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE,
      Key: {
        PK: `ORG#${orgId}#EVENT#${eventId}`,
        SK: 'ANALYTICS#REPORT',
      },
    }),
  );

  if (!result.Item) return null;

  const item = result.Item as AnalyticsReportDynamoItem;
  // Tenant isolation check
  if (item.tenantId !== tenantId) return null;

  return item;
}

export async function upsertAnalyticsReport(
  item: Omit<AnalyticsReportDynamoItem, 'PK' | 'SK'> & { orgId: string; eventId: string },
): Promise<AnalyticsReportDynamoItem> {
  const now = new Date().toISOString();
  const full: AnalyticsReportDynamoItem = {
    ...item,
    PK: `ORG#${item.orgId}#EVENT#${item.eventId}`,
    SK: 'ANALYTICS#REPORT',
    type: 'ANALYTICS_REPORT',
    reportId: item.reportId ?? randomUUID(),
    updatedAt: now,
    createdAt: item.createdAt ?? now,
  };

  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: full,
    }),
  );

  return full;
}

export async function updateAnalyticsReportStatus(
  orgId: string,
  eventId: string,
  tenantId: string,
  status: ReportStatus,
  extras?: {
    csvS3Key?: string;
    pdfS3Key?: string;
    reportGeneratedAt?: string;
    sentimentScore?: number;
    positiveThemes?: string[];
    negativeThemes?: string[];
  },
): Promise<void> {
  const now = new Date().toISOString();
  let updateExpression = 'SET reportStatus = :status, updatedAt = :now';
  const expressionValues: Record<string, unknown> = {
    ':status': status,
    ':now': now,
    ':tenantId': tenantId,
  };

  if (extras?.csvS3Key) {
    updateExpression += ', csvS3Key = :csvS3Key';
    expressionValues[':csvS3Key'] = extras.csvS3Key;
  }
  if (extras?.pdfS3Key) {
    updateExpression += ', pdfS3Key = :pdfS3Key';
    expressionValues[':pdfS3Key'] = extras.pdfS3Key;
  }
  if (extras?.reportGeneratedAt) {
    updateExpression += ', reportGeneratedAt = :reportGeneratedAt';
    expressionValues[':reportGeneratedAt'] = extras.reportGeneratedAt;
  }
  if (extras?.sentimentScore !== undefined) {
    updateExpression += ', sentimentScore = :sentimentScore';
    expressionValues[':sentimentScore'] = extras.sentimentScore;
  }
  if (extras?.positiveThemes) {
    updateExpression += ', positiveThemes = :positiveThemes';
    expressionValues[':positiveThemes'] = extras.positiveThemes;
  }
  if (extras?.negativeThemes) {
    updateExpression += ', negativeThemes = :negativeThemes';
    expressionValues[':negativeThemes'] = extras.negativeThemes;
  }

  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: {
        PK: `ORG#${orgId}#EVENT#${eventId}`,
        SK: 'ANALYTICS#REPORT',
      },
      UpdateExpression: updateExpression,
      ConditionExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: expressionValues,
    }),
  );
}

// ─── Trend Report ─────────────────────────────────────────────────────────────

export async function createTrendReport(
  orgId: string,
  tenantId: string,
  dateRangeStart: string,
  dateRangeEnd: string,
  eventCount: number,
): Promise<TrendReportDynamoItem> {
  const now = new Date().toISOString();
  const reportId = randomUUID();

  const item: TrendReportDynamoItem = {
    PK: `ORG#${orgId}`,
    SK: `TREND#REPORT#${reportId}`,
    type: 'TREND_REPORT',
    reportId,
    orgId,
    tenantId,
    reportStatus: 'Pending',
    dateRangeStart,
    dateRangeEnd,
    eventCount,
    avgAttendanceRate: 0,
    avgCheckInRate: 0,
    totalTickets: 0,
    totalCancellations: 0,
    createdAt: now,
    updatedAt: now,
  };

  await dynamo.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

export async function getTrendReport(
  orgId: string,
  reportId: string,
  tenantId: string,
): Promise<TrendReportDynamoItem | null> {
  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE,
      Key: {
        PK: `ORG#${orgId}`,
        SK: `TREND#REPORT#${reportId}`,
      },
    }),
  );

  if (!result.Item) return null;
  const item = result.Item as TrendReportDynamoItem;
  if (item.tenantId !== tenantId) return null;
  return item;
}

export async function updateTrendReportStatus(
  orgId: string,
  reportId: string,
  tenantId: string,
  status: ReportStatus,
  metrics?: {
    avgAttendanceRate?: number;
    avgCheckInRate?: number;
    totalTickets?: number;
    totalCancellations?: number;
    csvS3Key?: string;
    pdfS3Key?: string;
    reportGeneratedAt?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  let updateExpression = 'SET reportStatus = :status, updatedAt = :now';
  const expressionValues: Record<string, unknown> = {
    ':status': status,
    ':now': now,
    ':tenantId': tenantId,
  };

  if (metrics?.avgAttendanceRate !== undefined) {
    updateExpression += ', avgAttendanceRate = :avgAR';
    expressionValues[':avgAR'] = metrics.avgAttendanceRate;
  }
  if (metrics?.avgCheckInRate !== undefined) {
    updateExpression += ', avgCheckInRate = :avgCI';
    expressionValues[':avgCI'] = metrics.avgCheckInRate;
  }
  if (metrics?.totalTickets !== undefined) {
    updateExpression += ', totalTickets = :totalTickets';
    expressionValues[':totalTickets'] = metrics.totalTickets;
  }
  if (metrics?.totalCancellations !== undefined) {
    updateExpression += ', totalCancellations = :totalCancellations';
    expressionValues[':totalCancellations'] = metrics.totalCancellations;
  }
  if (metrics?.csvS3Key) {
    updateExpression += ', csvS3Key = :csvS3Key';
    expressionValues[':csvS3Key'] = metrics.csvS3Key;
  }
  if (metrics?.pdfS3Key) {
    updateExpression += ', pdfS3Key = :pdfS3Key';
    expressionValues[':pdfS3Key'] = metrics.pdfS3Key;
  }
  if (metrics?.reportGeneratedAt) {
    updateExpression += ', reportGeneratedAt = :reportGeneratedAt';
    expressionValues[':reportGeneratedAt'] = metrics.reportGeneratedAt;
  }

  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: {
        PK: `ORG#${orgId}`,
        SK: `TREND#REPORT#${reportId}`,
      },
      UpdateExpression: updateExpression,
      ConditionExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: expressionValues,
    }),
  );
}

// ─── Event ticket metrics for aggregation ────────────────────────────────────

export interface TicketMetrics {
  confirmedCount: number;
  checkedInCount: number;
  waitlistCount: number;
  cancellationCount: number;
  totalRegistrations: number;
}

export async function getTicketMetricsForEvent(
  orgId: string,
  eventId: string,
  tenantId: string,
): Promise<TicketMetrics> {
  // Query tickets by event
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      FilterExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: {
        ':pk': `ORG#${orgId}#EVENT#${eventId}`,
        ':skPrefix': 'TICKET#',
        ':tenantId': tenantId,
      },
    }),
  );

  const tickets = result.Items ?? [];
  let confirmedCount = 0;
  let checkedInCount = 0;
  let waitlistCount = 0;
  let cancellationCount = 0;

  for (const t of tickets) {
    const status = t['ticketStatus'] as string;
    if (status === 'Confirmed') confirmedCount++;
    else if (status === 'CheckedIn') checkedInCount++;
    else if (status === 'Waitlisted') waitlistCount++;
    else if (status === 'Cancelled') cancellationCount++;
  }

  return {
    confirmedCount: confirmedCount + checkedInCount,
    checkedInCount,
    waitlistCount,
    cancellationCount,
    totalRegistrations: confirmedCount + checkedInCount + waitlistCount + cancellationCount,
  };
}

// ─── Count events in date range for org ──────────────────────────────────────

export async function countEventsInDateRange(
  orgId: string,
  tenantId: string,
  dateRangeStart: string,
  dateRangeEnd: string,
): Promise<number> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :gsi2pk AND GSI2SK BETWEEN :start AND :end',
      FilterExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: {
        ':gsi2pk': `ORG#${orgId}#STATUS#Completed`,
        ':start': dateRangeStart,
        ':end': dateRangeEnd,
        ':tenantId': tenantId,
      },
      Select: 'COUNT',
    }),
  );

  return result.Count ?? 0;
}

export async function getEventsInDateRange(
  orgId: string,
  tenantId: string,
  dateRangeStart: string,
  dateRangeEnd: string,
): Promise<Array<{ eventId: string; orgId: string; capacity: number }>> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :gsi2pk AND GSI2SK BETWEEN :start AND :end',
      FilterExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: {
        ':gsi2pk': `ORG#${orgId}#STATUS#Completed`,
        ':start': dateRangeStart,
        ':end': dateRangeEnd,
        ':tenantId': tenantId,
      },
      ProjectionExpression: 'eventId, orgId, capacity',
    }),
  );

  return (result.Items ?? []) as Array<{ eventId: string; orgId: string; capacity: number }>;
}
