# Implementation Plan: Community Lifecycle Orchestration and Intelligence System (CLOIS)

## Overview

This plan breaks down the full CLOIS implementation into eight ordered phases that mirror the system's architectural layers. Each phase builds on the previous so that no code is left hanging or unintegrated. The stack is TypeScript throughout: React + Tailwind CSS on the frontend, AWS CDK + Lambda on the backend. All property-based tests use fast-check; unit/integration tests use Vitest.

---

## Tasks

---

### Phase 1: Infrastructure Foundation and CDK Stacks

- [ ] 1. Bootstrap CDK project and core infrastructure stacks
  - Initialise the CDK TypeScript app under `infrastructure/` with the directory structure from the design (`bin/clois.ts`, `lib/stacks/`, `lib/constructs/`)
  - Create `DatabaseStack.ts`: DynamoDB `clois-main` table with PK/SK, all four GSIs, and the separate `clois-audit-log` table (append-only resource policy, no `DeleteItem`/`UpdateItem` for application roles) and `clois-ws-connections` table with TTL
  - Create `StorageStack.ts`: S3 buckets for frontend assets and application assets (`qr-codes/`, `exports/`, `reports/`, `data-exports/`) with lifecycle policies (3-year retention on reports per Req 10.7)
  - Create `AuthStack.ts`: Cognito User Pool with email verification, 12-char password policy (uppercase + lowercase + digit + special), TOTP MFA support, custom attributes (`custom:memberId`, `custom:orgRoles`), and App Client
  - Create `MessagingStack.ts`: EventBridge default bus, SQS queues (`notification-queue`, `report-queue`, `ai-request-queue`) each with a DLQ, SNS topic wired to SES, and CloudWatch alarm on DLQ depth > 0
  - Create `CdnStack.ts`: CloudFront distribution pointing to the frontend S3 bucket with `redirect-to-https` viewer protocol policy
  - Create `MonitoringStack.ts`: CloudWatch alarms for Lambda error rate > 1 %, DLQ messages > 0, DynamoDB throttles > 0, circuit-breaker open, Step Functions failures
  - Create base CDK constructs `LambdaFunction.ts`, `ApiRoute.ts`, `StepMachine.ts` (with built-in retry config: 5 s, 2×, 3 attempts)
  - Write CDK snapshot tests for all stacks using `@aws-cdk/assertions`
  - _Requirements: 2.3, 16.3, 19.1, 19.3, 19.4, 21.5_

  - [ ]* 1.1 Write CDK snapshot tests for DatabaseStack, StorageStack, AuthStack
    - Assert GSI count, table names, bucket lifecycle rules, Cognito password policy
    - _Requirements: 1.2, 16.3, 19.4_

  - [ ]* 1.2 Write CDK snapshot tests for MessagingStack, CdnStack, MonitoringStack
    - Assert DLQ configurations, CloudWatch alarm thresholds, CloudFront HTTPS redirect
    - _Requirements: 19.3, 21.5_

---

### Phase 2: Authentication and Lambda Authorizer

- [ ] 2. Implement authentication Lambda functions and JWT authorizer
  - [ ] 2.1 Implement `AuthorizerFn` (Lambda Authorizer)
    - Validate JWT signature against Cognito JWKS endpoint (cache JWKS for 1 hour)
    - Extract `sub` (memberId), `custom:orgRoles` (JSON map), and derive role for the requested `{orgId}` path param
    - Generate IAM Allow/Deny policy based on `methodArn` vs required permission map
    - Return HTTP 401 for missing/expired/invalid tokens; HTTP 403 for valid token with insufficient role
    - _Requirements: 1.6, 1.11, 15.3_

  - [ ]* 2.2 Write property test for JWT authorizer rejects invalid tokens
    - **Property 2: JWT Authorizer Rejects All Invalid Tokens**
    - **Validates: Requirements 1.11, 15.3**

  - [ ] 2.3 Implement Auth API Lambda endpoints
    - `POST /v1/auth/register` — validate password policy (12 chars, uppercase, lowercase, digit, special), call Cognito `signUp`, return 409 on duplicate email (Req 1.2, 1.5)
    - `POST /v1/auth/verify-email` — confirm registration code, return error + resend option for expired links (Req 1.3, 1.4)
    - `POST /v1/auth/login` — authenticate via Cognito, return accessToken (1 hr) + refreshToken (30 d) + idToken (Req 1.6)
    - `POST /v1/auth/refresh` — exchange refresh token for new access token; reject expired/invalid refresh tokens (Req 1.7, 1.8)
    - `POST /v1/auth/forgot-password` — invalidate prior reset links, send new 15-min reset link (Req 1.9)
    - `POST /v1/auth/reset-password` — consume one-time token, reject expired/used links (Req 1.10)
    - `PUT /v1/auth/mfa/enable` and `PUT /v1/auth/mfa/disable` — toggle TOTP MFA on Cognito user (Req 1.12)
    - Record MFA lockout (5 consecutive wrong TOTP codes) in Audit Log (Req 1.14)
    - _Requirements: 1.2–1.14_

  - [ ]* 2.4 Write property test for password validation completeness
    - **Property 1: Password Validation Completeness**
    - **Validates: Requirements 1.2**

  - [ ] 2.5 Implement `APIStack.ts` CDK construct: API Gateway REST API under `/v1/`, attach `AuthorizerFn` as token authorizer, configure `X-Correlation-ID` context variable propagation, and wire all Lambda integrations for auth routes
    - _Requirements: 23.1, 23.5, 23.6_

- [ ] 3. Checkpoint — Ensure auth tests pass, ask the user if questions arise.

---

### Phase 3: Organization and Member Management

- [ ] 4. Implement organization CRUD and multi-tenant isolation
  - [ ] 4.1 Implement `OrgsFn` Lambda
    - `POST /v1/orgs` — validate name (3–100 chars) and slug (3–63 chars, lowercase alphanumeric + hyphens); case-insensitive uniqueness check via GSI1 `SLUG#{slug}` query; create Organization item + OrgMembership item with Owner role; return within 3 s (Req 2.1, 2.2)
    - `GET /v1/orgs/{orgId}` — return org record scoped to caller's orgId
    - `PUT /v1/orgs/{orgId}` — update name/settings; Owner only
    - `POST /v1/orgs/{orgId}/deactivate` — set status Deactivated, revoke member sessions, retain data ≥ 90 days (Req 2.4, 2.5)
    - `POST /v1/orgs/{orgId}/transfer-ownership` — validate target is existing member, demote prior Owner to Admin, promote target to Owner, write audit log (Req 2.7, 2.8)
    - Enforce tenant isolation: all DynamoDB queries include `tenantId` condition; `tenantId` sourced exclusively from JWT authorizer context (Req 2.3)
    - _Requirements: 2.1–2.8_

  - [ ]* 4.2 Write property test for org slug/name uniqueness invariant
    - **Property 3: Organization Slug and Name Uniqueness Invariant**
    - **Validates: Requirements 2.1, 2.2**

  - [ ]* 4.3 Write property test for cross-tenant isolation (403 on cross-org access)
    - **Property 4: Cross-Tenant Isolation (403 on Cross-Org Access)**
    - **Validates: Requirements 2.3, 15.4**

  - [ ] 4.4 Implement `MembersFn` Lambda
    - `POST /v1/orgs/{orgId}/invitations` — validate email + role; check for duplicate active membership; create Invitation item (hashed token, 72 h expiry); send invitation email via SES; write audit log (Req 3.1, 3.2)
    - `POST /v1/orgs/{orgId}/invitations/bulk` — parse CSV (≤ 500 rows); validate each row; send valid invitations; return summary report of accepted + skipped entries with reasons; reject files > 500 rows with error (Req 3.9, 3.10, 3.11)
    - `GET /v1/orgs/{orgId}/invitations/{invitationId}/accept` — token-based acceptance (public endpoint); validate token hash via GSI1; check expiry (72 h) and used status; add OrgMembership record; write audit log (Req 3.3, 3.4, 3.5)
    - `GET /v1/orgs/{orgId}/members` — paginated list of org members
    - `PUT /v1/orgs/{orgId}/members/{memberId}/role` — enforce sole-Owner guard; apply new role within 2 s; write audit log (Req 3.6, 3.7)
    - `DELETE /v1/orgs/{orgId}/members/{memberId}` — revoke access; cancel pending tickets for upcoming events; write audit log (Req 3.8)
    - _Requirements: 3.1–3.11_

  - [ ]* 4.5 Write property test for invitation token uniqueness
    - **Property 5: Invitation Token Uniqueness**
    - **Validates: Requirements 3.1**

  - [ ]* 4.6 Write property test for bulk CSV invitation processing correctness
    - **Property 6: Bulk CSV Invitation Processing Correctness**
    - **Validates: Requirements 3.9, 3.11**

- [ ] 5. Checkpoint — Ensure all org and member tests pass, ask the user if questions arise.

---

### Phase 4: Events, Venues, Ticketing, and Check-In

- [ ] 6. Implement venue management
  - [ ] 6.1 Implement `VenuesFn` Lambda
    - `POST /v1/orgs/{orgId}/venues` — validate name (1–200), address (1–500), capacity (1–999,999), amenities (≤ 50 items ≤ 100 chars each); return venue ID within 3 s (Req 5.1, 5.2)
    - `GET /v1/orgs/{orgId}/venues` — list all venues for org
    - `GET /v1/orgs/{orgId}/venues/{venueId}` — get single venue
    - `PUT /v1/orgs/{orgId}/venues/{venueId}` — update venue fields
    - `DELETE /v1/orgs/{orgId}/venues/{venueId}` — guard: reject if venue is used by any Published/Open event, return list of blocking events (Req 5.5)
    - _Requirements: 5.1–5.6_

  - [ ]* 6.2 Write property test for venue capacity override enforcement
    - **Property 9: Venue Capacity Override Enforcement**
    - **Validates: Requirements 5.3, 5.4**

- [ ] 7. Implement event lifecycle management
  - [ ] 7.1 Implement `EventsFn` Lambda — CRUD and lifecycle transitions
    - `POST /v1/orgs/{orgId}/events` — validate required fields (title 1–200, startAt, endAt, timezone IANA, capacity 1–100,000); enforce endAt > startAt; create Event in Draft; return within 3 s (Req 4.1, 4.2, 4.3)
    - `GET /v1/orgs/{orgId}/events` — paginated list; support query by status via GSI2
    - `GET /v1/orgs/{orgId}/events/{eventId}` — get event detail
    - `PUT /v1/orgs/{orgId}/events/{eventId}` — update event fields; validate endAt > startAt; for Published events update EventBridge rules within 30 s (Req 11.3)
    - `POST /v1/orgs/{orgId}/events/{eventId}/publish` — validate all required fields populated; enforce valid state transition (Draft → Published); emit domain event to EventBridge; trigger Event Publish Workflow (Step Functions) within 3 s (Req 4.4, 4.5)
    - `POST /v1/orgs/{orgId}/events/{eventId}/cancel` — enforce valid state (Published/Open/In_Progress → Cancelled); trigger Event Cancellation Workflow (Req 4.9)
    - `POST /v1/orgs/{orgId}/events/{eventId}/transition` — Admin manual override; validate transition table; write audit log (Req 21.6)
    - Enforce valid state transition table throughout; reject invalid transitions with descriptive error (Req 4.6)
    - Support physical (address required) and virtual (meetingUrl required, address not required) venue types (Req 4.10)
    - _Requirements: 4.1–4.12_

  - [ ]* 7.2 Write property test for event datetime validation invariant
    - **Property 7: Event Datetime Validation Invariant**
    - **Validates: Requirements 4.3**

  - [ ]* 7.3 Write property test for event lifecycle state machine validity
    - **Property 8: Event Lifecycle State Machine Validity**
    - **Validates: Requirements 4.6**

  - [ ] 7.4 Implement `WorkflowStack.ts` Step Functions state machines
    - **Event Publish Workflow**: ValidateEvent → ScheduleEventBridgeRules (T-start and T-end rules) → SetPublishedStatus → ScheduleReminders → EmitPublishedEvent → WriteAuditLog; on failure: RevertToDraft → NotifyOrganizer (Req 11.2)
    - **Event Cancellation Workflow**: SetCancelledStatus → VoidAllTickets → EnqueueAttendeeNotifications → DeleteEventBridgeRules → WriteAuditLog (Req 4.9, 11.4)
    - **Reminder Workflow**: CheckReminderEligibility → FetchConfirmedAttendees → BatchEnqueueReminderNotifications → MarkReminderSent; skip if reminder time already passed (Req 7.4, 11.5)
    - **Post-Event Report Workflow**: AggregateEventMetrics → GeneratePDFReport → GenerateCSVReport → StoreReportsInS3 → UpdateAnalyticsRecord → NotifyAdminsReportReady → WriteAuditLog (Req 10.1)
    - All tasks use retry config: IntervalSeconds=5, MaxAttempts=3, BackoffRate=2.0; Catch→MarkWorkflowFailed (Req 11.6)
    - Implement `SchedulerFn` EventBridge Lambda: handles T-start (→ In_Progress) and T-end (→ Completed + trigger Post-Event Report SFN) transitions (Req 4.7, 4.8)
    - Implement `EventTransitionFn`, `ReminderFn`, `PostEventReportFn`, `CancellationFn` Step Functions task Lambdas
    - Expose workflow execution history via `GET /v1/orgs/{orgId}/events/{eventId}/workflow-history` (Req 11.7)
    - _Requirements: 4.7–4.9, 11.1–11.7_

  - [ ]* 7.5 Write property test for event publish atomicity
    - **Property 18: Event Publish Atomicity**
    - **Validates: Requirements 11.2**

  - [ ]* 7.6 Write property test for retry semantics correctness
    - **Property 19: Retry Semantics Correctness**
    - **Validates: Requirements 11.6, 21.2**

- [ ] 8. Implement ticketing, RSVP, and check-in
  - [ ] 8.1 Implement `TicketsFn` Lambda
    - `POST /v1/orgs/{orgId}/events/{eventId}/tickets` — validate event in Published/Open state; member duplicate check via GSI3; guest email duplicate check via GSI3 (overloaded); if confirmedCount < capacity create Confirmed ticket + generate unique UUID ticketCode; if at capacity add Waitlisted ticket with waitlistPosition; reject if waitlist ≥ 100 (Req 6.1, 6.3–6.6)
    - Generate QR code image (use `qrcode` npm package), store in S3 `qr-codes/{orgId}/{eventId}/{ticketId}.png`, generate 7-day pre-signed URL, return within 5 s (Req 6.2, 6.12)
    - Enqueue RSVP confirmation notification to `notification-queue` (Req 6.8)
    - `GET /v1/orgs/{orgId}/events/{eventId}/tickets` — paginated ticket list (Organizer/Admin)
    - `GET /v1/orgs/{orgId}/events/{eventId}/tickets/{ticketId}` — get ticket; return 7-day pre-signed QR URL
    - `DELETE /v1/orgs/{orgId}/events/{eventId}/tickets/{ticketId}` — cancel ticket; validate event state (Draft/Published/Open only); trigger waitlist promotion if applicable; notify promoted attendee within 2 min (Req 6.7, 6.9, 6.10)
    - `GET /v1/orgs/{orgId}/events/{eventId}/waitlist` — list waitlisted tickets in position order
    - Implement `promoteWaitlist` helper: DynamoDB transaction to set Waitlisted → Confirmed for lowest waitlistPosition; enqueue promotion notification (Req 6.7)
    - _Requirements: 6.1–6.12_

  - [ ]* 8.2 Write property test for ticket code uniqueness
    - **Property 10: Ticket Code Uniqueness**
    - **Validates: Requirements 6.1**

  - [ ]* 8.3 Write property test for event capacity invariant
    - **Property 11: Event Capacity Invariant**
    - **Validates: Requirements 6.5, 6.6**

  - [ ]* 8.4 Write property test for waitlist promotion FIFO invariant
    - **Property 12: Waitlist Promotion FIFO Invariant**
    - **Validates: Requirements 6.7**

  - [ ] 8.5 Implement `CheckInFn` Lambda
    - `POST /v1/orgs/{orgId}/events/{eventId}/checkins` — accept `{ ticketCode }` (QR scan) or `{ ticketCode | attendeeName }` (manual); validate event in In_Progress state; look up ticket via GSI1 (`TICKETCODE#{code}`); enforce idempotency (return duplicate warning with original timestamp if already checked in); mark Ticket as CheckedIn + record checkedInAt + checkedInBy within 2 s (Req 8.1–8.6)
    - After each check-in, calculate capacity percentage; push real-time `CHECKIN_UPDATE` WebSocket event to org connections; send `CAPACITY_WARNING` notification at 90 % and `CAPACITY_FULL` notification at 100 % (Req 8.7, 8.8)
    - `GET /v1/orgs/{orgId}/events/{eventId}/checkins/stats` — return checkedInCount, capacity, percentage
    - _Requirements: 8.1–8.8_

  - [ ]* 8.6 Write property test for check-in idempotency
    - **Property 15: Check-In Idempotency**
    - **Validates: Requirements 8.3**

- [ ] 9. Checkpoint — Ensure all event, ticket, and check-in tests pass, ask the user if questions arise.

---

### Phase 5: Real-Time WebSocket, Notifications, and Announcements

- [ ] 10. Implement WebSocket infrastructure and real-time push
  - [ ] 10.1 Implement WebSocket Lambda handlers
    - `WSConnectFn` (`$connect`): validate JWT from query param `?token=`; store `{connectionId, memberId, orgId, connectedAt, TTL=+7200s}` in `clois-ws-connections` table (Req 8.5, 9.3)
    - `WSDisconnectFn` (`$disconnect`): delete connection record
    - `WSMessageFn` (`$default`): route inbound WebSocket messages
    - Implement `broadcastToOrg(orgId, payload)` utility: query `clois-ws-connections` GSI by memberId/orgId; call `ApiGatewayManagementApi.postToConnection`; on `GoneException` (410) delete stale connection record
    - Wire `ApiStack.ts` to add WebSocket API Gateway with `$connect`, `$disconnect`, `$default` routes
    - _Requirements: 8.5, 9.3_

  - [ ] 10.2 Implement `NotificationWorkerFn` (SQS consumer on `notification-queue`)
    - Deserialize and validate notification message against JSON Schema; route to DLQ on schema failure (Req 18.2, 18.3)
    - Check Member email opt-out status per org before dispatching email (Req 7.9)
    - Dispatch email via SES with retry: exponential backoff, 3 attempts, 15-minute window; mark as delivery-failed in DynamoDB after exhaustion + write audit log entry (Req 7.5)
    - Persist in-app notification record in `clois-main` table; push `NOTIFICATION` WebSocket event to member's active connections (Req 7.10)
    - Mark notification unread count; support `PUT /v1/me/notifications/{notificationId}/read` within 5 s (Req 7.6)
    - `GET /v1/me/notifications` — paginated in-app notifications for authenticated member
    - `PUT /v1/orgs/{orgId}/notifications/opt-out` — toggle email opt-out flag for member+org (Req 7.9)
    - _Requirements: 7.3, 7.5–7.7, 7.9, 7.10_

  - [ ]* 10.3 Write property test for email opt-out suppression
    - **Property 14: Email Opt-Out Suppression**
    - **Validates: Requirements 7.9**

  - [ ] 10.4 Implement `AnnouncementsFn` Lambda
    - `POST /v1/orgs/{orgId}/announcements` — validate audience type (AllMembers | EventAttendees | Role | Manual list ≤ 500); resolve target member set from DynamoDB; enqueue one notification message per target member to `notification-queue`; deliver within 5 min (Req 7.1, 7.2)
    - `GET /v1/orgs/{orgId}/announcements` — paginated announcement list
    - _Requirements: 7.1, 7.2_

  - [ ]* 10.5 Write property test for announcement audience targeting completeness
    - **Property 13: Announcement Audience Targeting Completeness**
    - **Validates: Requirements 7.2**

- [ ] 11. Checkpoint — Ensure all real-time and notification tests pass, ask the user if questions arise.

---

### Phase 6: Analytics, AI Features, and Calendar Export

- [ ] 12. Implement analytics and reporting
  - [ ] 12.1 Implement `AnalyticsFn` Lambda
    - `GET /v1/orgs/{orgId}/events/{eventId}/analytics` — return stored Analytics_Report; enforce access control (Organizer: own events only, Admin: all org events) (Req 10.2)
    - `POST /v1/orgs/{orgId}/analytics/trend-report` — if event count in date range ≤ 100 aggregate synchronously and return within 10 s; if > 100 enqueue to `report-queue` and return jobId (Req 10.4, 10.5, 10.6)
    - `GET /v1/orgs/{orgId}/analytics/trend-report/{reportId}` — poll for async report status; push `REPORT_READY` WebSocket event when complete (Req 10.6)
    - `GET /v1/orgs/{orgId}/events/{eventId}/analytics/export?format=csv|pdf` — return 24-hour pre-signed S3 URL to stored export file; enqueue generation if not yet available (Req 10.3)
    - _Requirements: 10.1–10.7_

  - [ ] 12.2 Implement `ReportWorkerFn` (SQS consumer on `report-queue`)
    - Aggregate attendance rate, check-in rate, waitlist count, cancellation count, registration time series from DynamoDB
    - Generate CSV (RFC 4180 compliant) and PDF report files; upload to `reports/{orgId}/{eventId}/` S3 prefix
    - Update `AnalyticsReport` DynamoDB item (`reportStatus: Ready`, `csvS3Key`, `pdfS3Key`, `reportGeneratedAt`)
    - Notify admins via notification queue; retain reports ≥ 3 years (S3 lifecycle policy in StorageStack)
    - _Requirements: 10.1, 10.3, 10.7_

  - [ ]* 12.3 Write property test for report sync/async routing
    - **Property 17: Report Generation Sync vs Async Routing**
    - **Validates: Requirements 10.5, 10.6**

  - [ ]* 12.4 Write property test for CSV export round-trip
    - **Property 27: CSV Export Round-Trip**
    - **Validates: Requirements 18.6**

  - [ ]* 12.5 Write property test for dashboard metric calculation correctness
    - **Property 16: Dashboard Metric Calculation Correctness**
    - **Validates: Requirements 9.3, 9.4**

- [ ] 13. Implement AI features with circuit breaker
  - [ ] 13.1 Implement circuit breaker middleware (`/opt/circuitBreaker`)
    - Implement `CircuitBreaker` class in Lambda shared layer with CLOSED / OPEN / HALF_OPEN states
    - Persist state in DynamoDB (`CB_STATE#{service}` item with TTL) to survive Lambda cold starts
    - Opening condition: 5 consecutive failures within 60-second window → OPEN for 120 s → HALF_OPEN (1 probe call) → CLOSED on success (Req 21.4)
    - Return `serviceUnavailable` error on OPEN state without invoking Bedrock
    - _Requirements: 21.4_

  - [ ]* 13.2 Write property test for circuit breaker state transitions
    - **Property 29: Circuit Breaker State Transitions**
    - **Validates: Requirements 21.4**

  - [ ] 13.3 Implement `AIFn` Lambda and `AIWorkerFn`
    - `POST /v1/orgs/{orgId}/ai/describe-event` — accept `{ title, keywords[], targetAudience }`; assemble prompt without any PII; call Bedrock (Claude 3 Sonnet, max 1024 tokens) via circuit breaker; validate response (100–500 words, non-empty, parseable); return editable draft; log request (prompt params, model, latency) in audit log; on Bedrock unavailability return error without blocking event CRUD (Req 12.1–12.6)
    - `POST /v1/orgs/{orgId}/ai/suggest-schedule` — require ≥ 5 completed events; pre-aggregate historical stats (day-of-week × time slot → avg attendance); call Bedrock (Claude 3 Haiku, max 512 tokens) via circuit breaker; validate output (1–5 suggestions, predictedAttendance ∈ [0,100], sorted descending); return < 5 completed events message with 3 generic recommendations if insufficient data (Req 13.1–13.5)
    - `POST /v1/orgs/{orgId}/ai/analyze-sentiment` — strip PII from feedback text (regex + NER); cap at 500 most recent entries; call Bedrock (Claude 3 Sonnet, max 1024 tokens) via circuit breaker; validate Sentiment_Score ∈ [-1.0, 1.0] (clamp out-of-range values); return 3 positive themes + 3 negative themes; reject corpus < 3 entries; store results in AnalyticsReport record (Req 14.1–14.7)
    - _Requirements: 12.1–12.6, 13.1–13.5, 14.1–14.7_

  - [ ]* 13.4 Write property test for no PII in Bedrock prompts
    - **Property 20: No PII in Bedrock Prompts**
    - **Validates: Requirements 12.2, 14.6**

  - [ ]* 13.5 Write property test for AI response validation rejection
    - **Property 21: AI Response Validation Rejection**
    - **Validates: Requirements 12.4**

  - [ ]* 13.6 Write property test for scheduling suggestion range and ordering
    - **Property 22: Scheduling Suggestion Range and Ordering**
    - **Validates: Requirements 13.1, 13.4**

  - [ ]* 13.7 Write property test for sentiment score range enforcement
    - **Property 23: Sentiment Score Range Enforcement**
    - **Validates: Requirements 14.3**

- [ ] 14. Implement calendar export and data privacy
  - [ ] 14.1 Implement `CalendarFn` Lambda
    - `GET /v1/orgs/{orgId}/events/{eventId}/tickets/{ticketId}/ical` — generate RFC 5545-compliant `.ics` file on-demand using `ics` npm package; include DTSTART (with TZID), DTEND (with TZID), SUMMARY (title), DESCRIPTION, LOCATION or URL (physical/virtual); invalidate any cached `.ics` older than 60 min; return within 5 s (Req 20.1–20.3)
    - When event startAt/endAt/venue is updated, enqueue notifications to all ticket holders informing them to re-download (Req 20.4)
    - _Requirements: 20.1–20.4_

  - [ ]* 14.2 Write property test for iCalendar export field fidelity
    - **Property 28: iCalendar Export Field Fidelity**
    - **Validates: Requirements 20.1, 20.2**

  - [ ] 14.3 Implement `DataPrivacyFn` Lambda
    - `POST /v1/me/data-export` — compile member profile + ticket history + notification history into JSON; store in `data-exports/{memberId}/export-{timestamp}.json`; return 48-hour pre-signed URL within 24 h; notify member by email on failure (Req 17.1, 17.2)
    - `DELETE /v1/me/account` — guard: reject if sole Owner of any org; send deletion confirmation email; anonymize PII fields (name, email, phone → placeholder values) across all records within 30 days; cancel active tickets (Req 17.3, 17.4)
    - `GET /v1/orgs/{orgId}/admin/member-data-map?memberId=` — return all DynamoDB keys and S3 object keys containing the member's data within 1 business day (Admin only) (Req 17.7)
    - HTTP 301 redirect for plain HTTP requests (enforce in CloudFront + API Gateway) (Req 17.6)
    - _Requirements: 17.1–17.7_

- [ ] 15. Checkpoint — Ensure all analytics, AI, calendar, and data privacy tests pass, ask the user if questions arise.

---

### Phase 7: Audit Logging, RBAC, Serialization, and API Contract

- [ ] 16. Implement audit logging and RBAC enforcement
  - [ ] 16.1 Implement `AuditLogFn` Lambda and audit writer utility
    - Create shared `writeAuditLog(entry)` utility used by all domain Lambdas: writes to `clois-audit-log` table within 5 s; entry fields: `timestamp` (UTC ISO 8601), `actor` (memberId | "system"), `targetType`, `targetId`, `operation`, `sourceIp`, `outcome` (Req 16.2)
    - Log all required operations: user login/logout/failed login, MFA lockout, password change, role change, member removal, org creation/deactivation, event state transition, ticket creation/cancellation, bulk invitation, AI generation request, data export request (Req 16.1)
    - `GET /v1/orgs/{orgId}/audit-log` — paginated query (100/page, within 5 s); filter by date range, actor, operation type; enforce org scoping (no cross-org leakage) (Req 16.3–16.6)
    - Ensure audit table resource policy denies `DeleteItem` and `UpdateItem` for all application IAM roles (append-only immutability enforced in `DatabaseStack.ts`) (Req 16.3)
    - _Requirements: 16.1–16.6_

  - [ ]* 16.2 Write property test for audit log entry completeness
    - **Property 30: Audit Log Entry Completeness**
    - **Validates: Requirements 16.2**

  - [ ] 16.3 Implement fine-grained RBAC permission map in Lambda shared layer (`/opt/rbac`)
    - Define permission table: Owner ⊇ Admin ⊇ Organizer ⊇ Member per design (Req 15.1, 15.2)
    - Enforce in every domain Lambda as a secondary check after the Authorizer IAM policy (Req 15.5)
    - Return HTTP 403 (never HTTP 404) for cross-org resource access attempts (Req 15.4)
    - _Requirements: 15.1–15.5_

- [ ] 17. Implement serialization integrity and API contract enforcement
  - [ ] 17.1 Define JSON Schema for all API request/response bodies and domain events
    - Write JSON Schema files for all API request bodies (place in `infrastructure/schemas/`)
    - Implement `validatePayload(schema, payload)` utility in Lambda shared layer; return HTTP 400 for invalid API request payloads; route invalid SQS messages to DLQ (Req 18.2, 18.3)
    - Serialize all EventBridge domain events as JSON conforming to versioned CloudEvents schema (Req 18.1)
    - Maintain OpenAPI 3.1 spec (`docs/openapi.yaml`) that documents all endpoints; add CI step to compare spec against deployed routes and block deployment on discrepancy (Req 23.2)
    - _Requirements: 18.1–18.5, 23.2_

  - [ ]* 17.2 Write property test for domain event serialization round-trip
    - **Property 26: Domain Event Serialization Round-Trip**
    - **Validates: Requirements 18.4**

  - [ ] 17.3 Implement unified error response middleware
    - Wrap all Lambda handlers in `errorMiddleware` that: catches unhandled exceptions, logs full stack trace + request context to CloudWatch, returns HTTP 500 with generic message and no implementation details (Req 21.1)
    - Ensure all 4xx/5xx responses contain `{ errorCode, message (≤ 500 chars), correlationId }` (Req 23.6)
    - Enforce HTTP status code mapping (200/201/204/400/401/403/404/409/500) across all endpoints (Req 23.5)
    - Add `Deprecation` and `Link` response headers to all deprecated endpoint handlers (Req 23.3, 23.4)
    - _Requirements: 21.1, 23.3–23.6_

  - [ ]* 17.4 Write property test for HTTP status code mapping invariant
    - **Property 24: HTTP Status Code Mapping Invariant**
    - **Validates: Requirements 23.5**

  - [ ]* 17.5 Write property test for error response structure completeness
    - **Property 25: Error Response Structure Completeness**
    - **Validates: Requirements 23.6**

- [ ] 18. Checkpoint — Ensure all audit, RBAC, and API contract tests pass, ask the user if questions arise.

---

### Phase 8: Frontend React Application

- [ ] 19. Bootstrap React frontend project
  - [ ] 19.1 Initialise Vite + React 18 + TypeScript 5 project under `frontend/`
    - Configure Tailwind CSS 3 + shadcn/ui component library
    - Set up React Router v6 data router with the full route tree from the design (public routes, protected `OrgShell`, profile routes)
    - Configure Zustand stores: `AuthStore` (user, tokens, isAuthenticated; persist to localStorage; refresh via Cognito SDK on expiry) and `OrgStore` (currentOrg, role, permissions)
    - Configure TanStack Query v5: `staleTime` 30 s for dashboard data, 5 min for static lists; `queryClient.invalidateQueries()` triggered by WebSocket messages
    - Set up `useWebSocket` custom hook: connect with JWT query param, auto-reconnect with exponential backoff on close, dispatch WebSocket events to relevant query keys
    - Configure Vitest + Testing Library + fast-check for frontend testing
    - _Requirements: 1.6, 9.5, 9.6_

  - [ ] 19.2 Implement public authentication pages
    - `LoginPage` — email/password form + TOTP field when MFA enabled; call `POST /v1/auth/login`; store tokens in AuthStore; redirect to `/orgs/:orgSlug/dashboard`
    - `RegisterPage` — email + password with live validation rules display; call `POST /v1/auth/register`; show 409 conflict error
    - `EmailVerificationPage` — accept verification token from URL; show expired-link error with resend option
    - `ForgotPasswordPage` and `ResetPasswordPage` — password reset flow
    - `AcceptInvitePage` — accept invitation by token; show expired/used error states
    - All forms use React Hook Form + Zod schemas matching server-side validation rules
    - _Requirements: 1.1–1.14_

- [ ] 20. Implement organization and member management UI
  - [ ] 20.1 Build `CreateOrgPage` and `OrgSettingsPage`
    - Create org form: name + slug with real-time uniqueness hint; call `POST /v1/orgs`; redirect to org shell on success
    - `OrgSettingsPage` (Owner only): update org name, transfer ownership (target member lookup), deactivate org
    - _Requirements: 2.1, 2.2, 2.7, 2.8_

  - [ ] 20.2 Build `MembersPage` with invitation and role management
    - Table of active members with role badges; role change dropdown (Admin/Owner only); remove member button with confirmation
    - Invite member modal: email + role selector; single invite via `POST /v1/orgs/{orgId}/invitations`
    - Bulk invite: CSV upload widget (≤ 500 rows); display summary report of accepted/skipped entries (Req 3.9–3.11)
    - Enforce sole-Owner guard UI warning when attempting to remove/demote last Owner
    - _Requirements: 3.1–3.11_

- [ ] 21. Implement event management UI
  - [ ] 21.1 Build `EventsListPage`, `CreateEventPage`, `EditEventPage`, `EventDetailPage`
    - `EventsListPage`: paginated table filtered by status; status badge colours
    - `CreateEventPage` / `EditEventPage`: full event form (title, start/end datetime, timezone picker, capacity, venue selector with capacity override confirmation modal, physical/virtual toggle)
    - `EventDetailPage`: event info, lifecycle status stepper, action buttons (Publish, Cancel) gated by role; link to ticket list, analytics, check-in pages
    - Implement `AIDescriptionPanel`: textarea with "Generate with AI" button; show generated draft as editable text; accept/discard controls; error state for Bedrock unavailability (Req 12.3–12.5)
    - Implement `SmartSchedulingPanel`: "Suggest Schedule" button; render up to 5 suggestion cards each showing predictedAttendance % and ≥ 2 reasoning factors + disclaimer; insufficient-data message < 5 events (Req 13.3–13.5)
    - Implement `WorkflowHistoryPanel`: timeline of Step Functions execution steps with status and timestamps (Req 11.7)
    - _Requirements: 4.1–4.12, 12.3–12.5, 13.3–13.5_

- [ ] 22. Implement ticketing, RSVP, and check-in UI
  - [ ] 22.1 Build `TicketCard` and RSVP flow
    - RSVP button on `EventDetailPage`: call `POST tickets`; show confirmation with QR code image (`react-qr-code`) and "Add to Calendar" button (Req 6.1, 6.2)
    - Cancel ticket button with confirmation; show error if event is In_Progress/Completed (Req 6.9, 6.10)
    - Waitlist badge and position indicator for Waitlisted tickets (Req 6.5)
    - "Add to Calendar" button on `TicketCard`: fetch `/ical` endpoint and trigger browser download (Req 20.1)
    - _Requirements: 6.1–6.12, 20.1_

  - [ ] 22.2 Build `CheckInPage` with QR scanner and manual check-in
    - `QRScanner` component: use `html5-qrcode` or `react-qr-reader` for camera-based QR scanning; call `POST /v1/.../checkins` on successful decode; display success/duplicate/invalid/inactive-event feedback within 2 s (Req 8.1–8.4)
    - `ManualCheckInForm`: input for ticket code or full name; same validation and feedback logic
    - `AttendanceCounter`: live check-in count, remaining capacity, percentage; updates via WebSocket `CHECKIN_UPDATE` events; fallback to polling every 10 s (Req 8.5, 9.3)
    - Capacity-full alert banner that persists until dismissed (Req 8.8)
    - _Requirements: 8.1–8.8_

- [ ] 23. Implement dashboard, analytics, and notifications UI
  - [ ] 23.1 Build `DashboardPage`
    - `MetricCard` components: upcoming events count, total registered attendees, total check-ins for In_Progress events; load within 3 s, data ≤ 60 s old (Req 9.1, 9.2)
    - `EventStatusTable`: list of events by status, scoped to org (Req 9.2)
    - `LiveCheckInWidget`: per-event check-in %, time elapsed; refresh ≤ every 10 s via WebSocket (Req 9.3)
    - Organization summary: total events run, total registrations, avg attendance rate over trailing 12 months (Req 9.4)
    - Stale data indicator: display last-successful-fetch timestamp alongside widget when live fetch fails; auto-retry every 30 s; unavailable-state indicator on first load failure (Req 9.5, 9.6)
    - _Requirements: 9.1–9.6_

  - [ ] 23.2 Build `AnalyticsPage` and trend report UI
    - Per-event analytics view: attendance rate, check-in rate, waitlist count, cancellation count, registration time-series chart
    - Sentiment analysis panel: Sentiment_Score gauge, positive/negative theme lists; "Analyze Feedback" button; insufficient-data and Bedrock-unavailability states (Req 14.1–14.7)
    - Export buttons (CSV / PDF): call export endpoint, open pre-signed URL for download (Req 10.3)
    - Trend report: date range selector (up to 24 months); sync result rendered inline for ≤ 100 events; async job polling for > 100 events with `REPORT_READY` WebSocket notification (Req 10.4–10.6)
    - _Requirements: 10.1–10.7, 14.1–14.7_

  - [ ] 23.3 Build notification bell and `AuditLogPage`
    - Notification bell in `TopBar`: shows unread count badge; dropdown list of recent notifications; mark-as-read on click via `PUT /v1/me/notifications/{id}/read`; updates within 5 s (Req 7.6)
    - In-app notification items for: RSVP confirmation, waitlist promotion, event cancellation, reminder, capacity warning, announcement (Req 7.3)
    - `AuditLogPage` (Admin+ only): paginated table with date-range, actor, operation-type filters; ≤ 100 rows/page (Req 16.5)
    - _Requirements: 7.3, 7.6, 16.5_

- [ ] 24. Implement profile, venues, and accessibility
  - [ ] 24.1 Build `ProfilePage` and `DataExportPage`
    - Profile page: edit display name; enable/disable MFA (TOTP setup flow with QR code); delete account button (shows ownership-transfer error if sole Owner) (Req 1.12, 17.3, 17.4)
    - `DataExportPage`: "Request My Data Export" button; show download link when ready; email opt-out toggle per org (Req 7.9, 17.1)
    - _Requirements: 1.12, 7.9, 17.1–17.4_

  - [ ] 24.2 Build `VenuesPage`, `CreateVenuePage`
    - Venue list with capacity and amenities; create/edit form with validation; delete button with active-event guard error listing (Req 5.1–5.6)
    - _Requirements: 5.1–5.6_

  - [ ] 24.3 Implement accessibility compliance across all MVP pages
    - Add `aria-label` and `aria-describedby` to all non-text interactive elements (icon buttons, QR images, charts) (Req 22.3)
    - Ensure full keyboard navigation for all forms, modals, dropdowns, tables (Req 22.2)
    - Render date/time values in member's configured timezone with ISO 8601 tooltip (Req 22.5)
    - Configure text scaling up to 200 % without horizontal scroll at 320px min-width (Req 22.4)
    - Integrate `axe-core` into Vitest + Testing Library renders for all page components (Req 22.1)
    - _Requirements: 22.1–22.6_

  - [ ]* 24.4 Write axe-core accessibility tests for all MVP page components
    - Assert zero critical/serious violations for: LoginPage, RegisterPage, EventsListPage, EventDetailPage, CheckInPage, TicketCard
    - _Requirements: 22.1_

- [ ] 25. Final checkpoint — Ensure all tests pass end-to-end, ask the user if questions arise.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP delivery.
- Property-based tests use `fast-check` with `numRuns: 100`; each test file is tagged `// Feature: clois, Property N: <text>`.
- All property test files live in `src/__tests__/properties/` (backend) or `frontend/src/__tests__/properties/` (frontend).
- Each task references requirements for traceability. Checkpoints ensure incremental validation.
- The design document's 30 correctness properties map 1-to-1 to the `*` sub-tasks above.
- Phases 1–7 are backend/infrastructure; Phase 8 is frontend. Teams can parallelize Phase 7 frontend bootstrap (task 19.1) with Phase 5–6 backend work.

---

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "2.5"] },
    { "id": 2, "tasks": ["2.3", "2.4"] },
    { "id": 3, "tasks": ["2.2", "4.1", "19.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4"] },
    { "id": 5, "tasks": ["4.5", "4.6", "6.1"] },
    { "id": 6, "tasks": ["6.2", "7.1"] },
    { "id": 7, "tasks": ["7.2", "7.3", "7.4"] },
    { "id": 8, "tasks": ["7.5", "7.6", "8.1"] },
    { "id": 9, "tasks": ["8.2", "8.3", "8.4", "8.5"] },
    { "id": 10, "tasks": ["8.6", "10.1", "10.4"] },
    { "id": 11, "tasks": ["10.2", "10.5"] },
    { "id": 12, "tasks": ["10.3", "12.1"] },
    { "id": 13, "tasks": ["12.2", "13.1"] },
    { "id": 14, "tasks": ["12.3", "12.4", "12.5", "13.3"] },
    { "id": 15, "tasks": ["13.2", "13.4", "13.5", "13.6", "13.7", "14.1"] },
    { "id": 16, "tasks": ["14.2", "14.3", "16.1", "16.3"] },
    { "id": 17, "tasks": ["16.2", "17.1"] },
    { "id": 18, "tasks": ["17.2", "17.3"] },
    { "id": 19, "tasks": ["17.4", "17.5"] },
    { "id": 20, "tasks": ["19.2", "20.1"] },
    { "id": 21, "tasks": ["20.2", "21.1"] },
    { "id": 22, "tasks": ["22.1", "22.2"] },
    { "id": 23, "tasks": ["23.1", "23.2", "23.3"] },
    { "id": 24, "tasks": ["24.1", "24.2"] },
    { "id": 25, "tasks": ["24.3"] },
    { "id": 26, "tasks": ["24.4"] }
  ]
}
```
