# CLOIS — Data & API Conventions

## DynamoDB Single-Table Design

The main table is `clois-main`. All domain entities share this table using composite keys.

**Key format**:
- `PK`: `TYPE#{id}` — e.g., `ORG#{orgId}`, `MEMBER#{memberId}`, `ORG#{orgId}#EVENT#{eventId}`
- `SK`: `SUBTYPE#{id}` or `METADATA` — e.g., `MEMBER#{memberId}`, `EVENT#{eventId}`, `TICKET#{ticketId}`

**Every item must include**:
- `type` — string discriminator for item type (e.g., `ORGANIZATION`, `EVENT`, `TICKET`)
- `tenantId` — equals `orgId`; used as a secondary isolation filter on every query

**GSI usage**:
- `GSI1`: Multi-purpose secondary lookups (slug uniqueness, token lookups, ticket-by-code)
- `GSI2`: Event status + org queries (list events by org + status, sorted by start time)
- `GSI3`: Ticket lookups by member or guest email (duplicate RSVP checks)
- `GSI4`: Notification delivery queries (list all notifications for an org)

Never add a `Scan` operation. Every access pattern must use `GetItem` or `Query` with a known PK.

## Event Lifecycle States

Valid states and transitions (immutable rule — do not deviate):

```
Draft → Published → Open → In_Progress → Completed → Archived
     ↘             ↓        ↓       ↓
      Cancelled ← (any of Published / Open / In_Progress)
```

- `Draft → Cancelled` is also valid.
- `Completed → Archived` is valid.
- `Cancelled` and `Archived` are terminal states — no further transitions.
- Invalid transitions must return `HTTP 400` with a descriptive error and leave the Event state unchanged.

## Datetime Conventions

- All datetimes stored in DynamoDB are **UTC ISO 8601** strings (e.g., `2026-10-15T14:00:00Z`).
- All datetimes in API request/response bodies are UTC ISO 8601.
- Timezone identifiers use the IANA timezone format (e.g., `Asia/Kolkata`, `America/New_York`).
- The frontend renders datetimes in the Member's configured timezone with an ISO 8601 tooltip.

## API Response Conventions

- Successful reads: `HTTP 200` with response body.
- Resource created: `HTTP 201` with the created resource in the body.
- Successful delete: `HTTP 204` with no body.
- All error responses use this exact JSON structure:

```json
{
  "errorCode": "domain.snake_case_error_type",
  "message": "Human-readable message (max 500 characters)",
  "correlationId": "req-abc123"
}
```

- `errorCode` format: `domain.error_type` using dot-namespacing (e.g., `ticket.duplicate_registration`, `event.invalid_transition`).
- Every Lambda handler propagates the `X-Correlation-ID` header as `correlationId` in error responses and in every CloudWatch log line.

## Pagination

- All list endpoints return paginated results.
- Pagination uses cursor-based DynamoDB `LastEvaluatedKey` encoded as a base64 `nextToken`.
- Default page size: 20 items. Maximum: 100 items (audit log queries).

## S3 Asset Conventions

- QR code images: `qr-codes/{orgId}/{eventId}/{ticketId}.png`
- Analytics exports: `exports/{orgId}/{eventId}/{format}/{filename}`
- Reports: `reports/{orgId}/{eventId}/{filename}` (3-year S3 lifecycle retention)
- Member data exports: `data-exports/{memberId}/export-{timestamp}.json`

All S3 assets are accessed by the frontend via pre-signed URLs only — never via public URLs. Lambda functions generate pre-signed URLs and return them in API responses.

## Domain Events (EventBridge)

All domain events published to EventBridge must conform to the versioned CloudEvents schema:

```json
{
  "specversion": "1.0",
  "type": "com.clois.v1.{domain}.{event_name}",
  "source": "clois/{service}",
  "id": "uuid",
  "time": "2026-10-15T14:00:00Z",
  "datacontenttype": "application/json",
  "data": { ... }
}
```

## Serialization Rules

- All Lambda functions validate incoming JSON payloads against their declared JSON Schema before processing.
- Invalid payloads return `HTTP 400` (for API requests) or are moved to the DLQ (for SQS messages).
- Domain event serialization must be round-trip safe: serialize → deserialize must produce a semantically equivalent object with no field loss or type coercion.
- CSV exports must be RFC 4180 compliant and round-trip safe.
- iCalendar (.ics) files must be RFC 5545 compliant and include `DTSTART`/`DTEND` with `TZID`.
