// ─── Domain types ─────────────────────────────────────────────────────────────

export interface Venue {
  venueId: string;
  orgId: string;
  name: string;
  address: string;
  capacity: number;
  amenities: string[];
  createdAt: string; // UTC ISO 8601
  updatedAt: string; // UTC ISO 8601
  tenantId: string; // equals orgId
}

// ─── Request / Response types ─────────────────────────────────────────────────

export interface CreateVenueRequest {
  name: string;
  address: string;
  capacity: number;
  amenities?: string[];
}

export interface UpdateVenueRequest {
  name?: string;
  address?: string;
  capacity?: number;
  amenities?: string[];
}

// ─── DynamoDB item shapes ─────────────────────────────────────────────────────

export interface VenueDynamoItem {
  PK: string;       // ORG#{orgId}#VENUE#{venueId}
  SK: string;       // METADATA
  GSI1PK: string;   // ORG#{orgId}
  GSI1SK: string;   // VENUE#{venueId}
  type: 'VENUE';
  venueId: string;
  orgId: string;
  name: string;
  address: string;
  capacity: number;
  amenities: string[];
  tenantId: string;
  createdAt: string;
  updatedAt: string;
}

/** A minimal event shape used for the "blocking events" guard in DELETE. */
export interface BlockingEvent {
  eventId: string;
  name: string;
  status: string;
}
