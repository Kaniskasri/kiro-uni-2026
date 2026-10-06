// Core domain types for CLOIS frontend

export type EventStatus =
  | 'Draft'
  | 'Published'
  | 'Open'
  | 'In_Progress'
  | 'Completed'
  | 'Cancelled'
  | 'Archived';

export type MemberRole = 'Owner' | 'Admin' | 'Organizer' | 'Member';

export type TicketStatus = 'Confirmed' | 'Waitlisted' | 'Cancelled' | 'CheckedIn';

export interface Organization {
  orgId: string;
  name: string;
  slug: string;
  status: 'Active' | 'Deactivated';
  createdAt: string;
}

export interface Member {
  memberId: string;
  email: string;
  name: string;
  role: MemberRole;
  joinedAt: string;
}

export interface Event {
  eventId: string;
  orgId: string;
  title: string;
  description?: string;
  status: EventStatus;
  startAt: string;
  endAt: string;
  timezone: string;
  capacity: number;
  confirmedCount: number;
  waitlistCount: number;
  venueId?: string;
  venueName?: string;
  venueAddress?: string;
  meetingUrl?: string;
  isVirtual: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Ticket {
  ticketId: string;
  eventId: string;
  orgId: string;
  memberId?: string;
  guestEmail?: string;
  guestName?: string;
  ticketCode: string;
  status: TicketStatus;
  waitlistPosition?: number;
  qrCodeUrl?: string;
  checkedInAt?: string;
  checkedInBy?: string;
  createdAt: string;
}

export interface Venue {
  venueId: string;
  orgId: string;
  name: string;
  address: string;
  capacity: number;
  amenities: string[];
  createdAt: string;
}

export interface Notification {
  notificationId: string;
  memberId: string;
  orgId: string;
  type: string;
  title: string;
  body: string;
  isRead: boolean;
  createdAt: string;
}

export interface AuditLogEntry {
  logId: string;
  timestamp: string;
  actor: string;
  targetType: string;
  targetId: string;
  operation: string;
  sourceIp: string;
  outcome: 'success' | 'failure';
}

export interface AnalyticsReport {
  eventId: string;
  attendanceRate: number;
  checkInRate: number;
  waitlistCount: number;
  cancellationCount: number;
  reportStatus: 'Pending' | 'Ready' | 'Failed';
  csvS3Url?: string;
  pdfS3Url?: string;
  sentimentScore?: number;
  positiveThemes?: string[];
  negativeThemes?: string[];
}

export interface ApiError {
  errorCode: string;
  message: string;
  correlationId: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  nextToken?: string;
  total?: number;
}

export interface AIScheduleSuggestion {
  dayOfWeek: string;
  timeSlot: string;
  predictedAttendance: number;
  reasoningFactors: string[];
}
