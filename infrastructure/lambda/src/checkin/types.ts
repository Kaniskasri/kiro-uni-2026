// ─── Check-In types ───────────────────────────────────────────────────────────

export interface CheckInRequest {
  ticketCode: string;
  attendeeName?: string; // optional, used for manual check-in
}

export interface CheckInResponse {
  ticketId: string;
  ticketCode: string;
  memberId?: string;
  guestEmail?: string;
  guestName?: string;
  checkedInAt: string;      // UTC ISO 8601
  checkedInBy: string;      // memberId from JWT
  alreadyCheckedIn: boolean;
}

export interface CheckInStatsResponse {
  checkedInCount: number;
  capacity: number;
  percentage: number; // checkedInCount / capacity * 100
}

export interface CheckInDynamoUpdate {
  orgId: string;
  eventId: string;
  ticketId: string;
  tenantId: string;
  checkedInAt: string;
  checkedInBy: string;
}
