// ─── Analytics domain types ────────────────────────────────────────────────────

export type ReportStatus = 'Pending' | 'Processing' | 'Ready' | 'Failed';

export interface AnalyticsReport {
  reportId: string;
  orgId: string;
  eventId: string;
  tenantId: string;
  reportStatus: ReportStatus;
  // Core metrics
  attendanceRate: number;    // confirmedCount / capacity * 100, 0-100
  checkInRate: number;       // checkedInCount / confirmedCount * 100, 0-100
  waitlistCount: number;
  cancellationCount: number;
  confirmedCount: number;
  checkedInCount: number;
  totalRegistrations: number;
  // S3 export keys
  csvS3Key?: string;
  pdfS3Key?: string;
  // Job tracking
  jobId?: string;
  reportGeneratedAt?: string;
  // Sentiment
  sentimentScore?: number;      // [-1, 1]
  positiveThemes?: string[];
  negativeThemes?: string[];
  // Timestamps
  createdAt: string;
  updatedAt: string;
}

export interface TrendReport {
  reportId: string;
  orgId: string;
  tenantId: string;
  reportStatus: ReportStatus;
  dateRangeStart: string;
  dateRangeEnd: string;
  eventCount: number;
  // Aggregated metrics
  avgAttendanceRate: number;
  avgCheckInRate: number;
  totalTickets: number;
  totalCancellations: number;
  csvS3Key?: string;
  pdfS3Key?: string;
  jobId?: string;
  reportGeneratedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── DynamoDB item shapes ─────────────────────────────────────────────────────

export interface AnalyticsReportDynamoItem {
  PK: string;     // ORG#{orgId}#EVENT#{eventId}
  SK: string;     // ANALYTICS#REPORT
  type: 'ANALYTICS_REPORT';
  reportId: string;
  orgId: string;
  eventId: string;
  tenantId: string;
  reportStatus: ReportStatus;
  attendanceRate: number;
  checkInRate: number;
  waitlistCount: number;
  cancellationCount: number;
  confirmedCount: number;
  checkedInCount: number;
  totalRegistrations: number;
  csvS3Key?: string;
  pdfS3Key?: string;
  jobId?: string;
  reportGeneratedAt?: string;
  sentimentScore?: number;
  positiveThemes?: string[];
  negativeThemes?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TrendReportDynamoItem {
  PK: string;     // ORG#{orgId}
  SK: string;     // TREND#REPORT#{reportId}
  type: 'TREND_REPORT';
  reportId: string;
  orgId: string;
  tenantId: string;
  reportStatus: ReportStatus;
  dateRangeStart: string;
  dateRangeEnd: string;
  eventCount: number;
  avgAttendanceRate: number;
  avgCheckInRate: number;
  totalTickets: number;
  totalCancellations: number;
  csvS3Key?: string;
  pdfS3Key?: string;
  jobId?: string;
  reportGeneratedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Request/Response types ───────────────────────────────────────────────────

export interface TrendReportRequest {
  dateRangeStart: string;
  dateRangeEnd: string;
}

export interface ExportFormat {
  format: 'csv' | 'pdf';
}
