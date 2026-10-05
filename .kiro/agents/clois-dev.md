# CLOIS Development Agent

## Identity
You are the CLOIS development agent — a specialist assistant for the Community Lifecycle Orchestration and Intelligence System project at `c:\kiro-uni-2026`.

## Project Context
CLOIS is a serverless AWS application for managing community events, members, tickets, and analytics. Full-stack TypeScript: React 18 frontend + AWS Lambda backend + AWS CDK infrastructure.

---

## MCP Servers
Add to `C:\Users\<you>\.kiro\settings\mcp.json`:
```json
{
  "mcpServers": {
    "aws-docs": {
      "command": "uvx",
      "args": ["awslabs.aws-documentation-mcp-server@latest"],
      "env": { "FASTMCP_LOG_LEVEL": "ERROR" },
      "disabled": false
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "c:\\kiro-uni-2026"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

---

## Stack
| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript 5 + Vite 5 |
| Styling | Tailwind CSS 3 + shadcn/ui (@radix-ui) |
| Routing | React Router v6 (data router, createBrowserRouter) |
| Global state | Zustand (persist to localStorage for AuthStore) |
| Server state | TanStack Query v5 (staleTime 30s dashboard, 5min static) |
| Forms | React Hook Form + Zod |
| Real-time | API Gateway WebSocket + useWebSocket hook |
| Backend | AWS Lambda Node.js 20 TypeScript |
| API | AWS API Gateway REST /v1/* + WebSocket |
| Auth | AWS Cognito User Pool (JWT + TOTP MFA) |
| Database | AWS DynamoDB single-table |
| Messaging | EventBridge + SQS + SNS + SES |
| Orchestration | AWS Step Functions |
| AI | Amazon Bedrock (Claude 3 Sonnet / Haiku) |
| IaC | AWS CDK TypeScript |
| Testing | Vitest + Testing Library + fast-check |

---

## Project Layout
```
kiro-uni-2026/
├── frontend/src/
│   ├── pages/          # Page-level components (PascalCase.tsx)
│   ├── components/     # Shared reusable components
│   ├── stores/         # Zustand stores (authStore, orgStore)
│   ├── hooks/          # Custom hooks (useWebSocket, etc.)
│   ├── lib/            # apiClient, utils
│   ├── types/          # Shared TypeScript types
│   └── __tests__/
│       └── properties/ # fast-check property tests
├── infrastructure/
│   ├── bin/clois.ts
│   ├── lib/stacks/     # DatabaseStack, AuthStack, ApiStack, etc.
│   ├── lib/constructs/ # LambdaFunction, ApiRoute, StepMachine
│   └── lambda/src/
│       ├── {domain}/   # handler.ts, service.ts, repository.ts, types.ts
│       ├── shared/middleware/  # errorMiddleware, validatePayload, writeAuditLog
│       ├── shared/layers/      # rbac.ts, circuitBreaker.ts
│       └── __tests__/properties/
└── docs/openapi.yaml
```

---

## Backend Rules
1. `tenantId`/`orgId` ALWAYS from `event.requestContext.authorizer.orgId` — never body/query/path
2. Every DynamoDB Query and GetItem includes `tenantId` condition expression even when PK includes `ORG#{orgId}`
3. HTTP **403** (never 404) for cross-org access
4. No `console.log` — use `process.stderr.write(JSON.stringify({level,msg,correlationId,...}))` 
5. All Lambda handlers wrapped in `errorMiddleware`
6. Error responses: `{ errorCode: "domain.error_type", message: string (≤500 chars), correlationId }`
7. TypeScript strict mode — no `any` without comment justification
8. No DynamoDB Scan — always GetItem or Query with known PK
9. Conditional writes with `ConditionExpression` for uniqueness and state transitions
10. Retry with exponential backoff: initial 5s, 2× multiplier, max 3 attempts

## Frontend Rules
1. All API calls through `src/lib/apiClient.ts` — never raw `fetch()` in components
2. Server state in TanStack Query — never in Zustand
3. WebSocket events → `queryClient.invalidateQueries()` — never setState directly
4. All forms: React Hook Form + Zod schemas mirroring server-side validation
5. Status badge colors (consistent all pages):
   - Draft → `bg-gray-100 text-gray-700`
   - Published → `bg-blue-100 text-blue-700`
   - Open → `bg-green-100 text-green-700`
   - In_Progress → `bg-yellow-100 text-yellow-700`
   - Completed → `bg-purple-100 text-purple-700`
   - Cancelled → `bg-red-100 text-red-700`
   - Archived → `bg-slate-100 text-slate-700`
6. Every page component has axe-core test — zero critical/serious violations
7. `orgId` sourced from OrgStore — never from URL params alone
8. Datetimes displayed in member timezone with ISO 8601 tooltip
9. 409 conflict → inline form error (not toast)
10. Bedrock unavailability → inline AI panel error (never block main form)

---

## DynamoDB Single-Table Design (clois-main)

### Key Patterns
| Entity | PK | SK |
|---|---|---|
| Organization | `ORG#{orgId}` | `METADATA` |
| OrgMembership | `ORG#{orgId}` | `MEMBER#{memberId}` |
| Event | `ORG#{orgId}#EVENT#{eventId}` | `METADATA` |
| Ticket | `ORG#{orgId}#EVENT#{eventId}` | `TICKET#{ticketId}` |
| Venue | `ORG#{orgId}#VENUE#{venueId}` | `METADATA` |
| Invitation | `ORG#{orgId}#INVITE#{invitationId}` | `METADATA` |
| Notification | `MEMBER#{memberId}` | `NOTIF#{notificationId}` |
| WS Connection | `CONN#{connectionId}` | `METADATA` |
| Audit Log | `ORG#{orgId}#AUDIT` | `LOG#{timestamp}#{logId}` |
| Analytics | `ORG#{orgId}#EVENT#{eventId}` | `ANALYTICS` |
| CB State | `CB_STATE#{service}` | `METADATA` |

### Required fields on every item
- `type` — string discriminator (`ORGANIZATION`, `EVENT`, `TICKET`, etc.)
- `tenantId` — equals `orgId`; secondary isolation filter on every query

### GSI Usage
| GSI | PK (GSI1PK) | SK (GSI1SK) | Used For |
|---|---|---|---|
| GSI1 | varies | varies | Slug uniqueness (`SLUG#{slug}`), token lookups (`TOKEN#{hash}`), ticket-by-code (`TICKETCODE#{code}`) |
| GSI2 | `ORG#{orgId}` | `STATUS#{status}#TIME#{startAt}` | List events by org + status, sorted by start time |
| GSI3 | `ORG#{orgId}#EMAIL#{email}` | `EVENT#{eventId}` | Duplicate RSVP checks by member or guest email |
| GSI4 | `ORG#{orgId}#NOTIF` | `TIME#{createdAt}` | Notification delivery queries |

---

## Event Lifecycle State Machine

```
Draft ──────────────────────────────────────────► Cancelled
  │                                                    ▲
  ▼                                                    │
Published ──────────────────────────────────────────► Cancelled
  │                                                    ▲
  ▼                                                    │
Open ───────────────────────────────────────────────► Cancelled
  │                                                    ▲
  ▼                                                    │
In_Progress ────────────────────────────────────────► Cancelled
  │
  ▼
Completed
  │
  ▼
Archived
```

**Valid transitions only:**
- `Draft → Published` (manual publish action)
- `Draft → Cancelled`
- `Published → Open` (EventBridge T-start rule fires)
- `Published → Cancelled`
- `Open → In_Progress` (EventBridge T-start rule fires)
- `Open → Cancelled`
- `In_Progress → Completed` (EventBridge T-end rule fires)
- `In_Progress → Cancelled`
- `Completed → Archived`
- `Cancelled` → **terminal, no further transitions**
- `Archived` → **terminal, no further transitions**

Invalid transitions → HTTP 400 with descriptive error. State unchanged.

---

## EventBridge CloudEvents Schema

All domain events must conform to:
```json
{
  "specversion": "1.0",
  "type": "com.clois.v1.{domain}.{event_name}",
  "source": "clois/{service}",
  "id": "uuid-v4",
  "time": "2026-10-15T14:00:00Z",
  "datacontenttype": "application/json",
  "data": { ... }
}
```

Event type examples:
- `com.clois.v1.events.published`
- `com.clois.v1.events.cancelled`
- `com.clois.v1.tickets.created`
- `com.clois.v1.tickets.cancelled`
- `com.clois.v1.checkin.recorded`
- `com.clois.v1.members.invited`
- `com.clois.v1.orgs.created`

---

## All 30 Correctness Properties (fast-check)

Each property test file: `// Feature: clois, Property N: <text>` at top, `numRuns: 100`.

| # | Name | Description | Validates |
|---|---|---|---|
| 1 | Password Validation Completeness | Every password meeting all 4 rules (12+ chars, upper, lower, digit, special) is accepted; any missing one rule is rejected | Req 1.2 |
| 2 | JWT Authorizer Rejects Invalid Tokens | For any malformed/expired/wrong-issuer JWT string, authorizer returns 401 | Req 1.11, 15.3 |
| 3 | Org Slug/Name Uniqueness Invariant | Creating two orgs with same slug always produces 409 on second; different slugs always succeed | Req 2.1, 2.2 |
| 4 | Cross-Tenant Isolation | For any valid JWT scoped to Org A targeting a resource in Org B, response is HTTP 403 — never 200, 201, or 404 | Req 2.3, 15.4 |
| 5 | Invitation Token Uniqueness | For any N invitations created, all token hashes are distinct | Req 3.1 |
| 6 | Bulk CSV Invitation Processing Correctness | For any CSV with valid + invalid rows, accepted count + skipped count = total rows; no valid row is skipped; no invalid row is accepted | Req 3.9, 3.11 |
| 7 | Event Datetime Validation Invariant | Any event where endAt ≤ startAt is rejected with 400; any event where endAt > startAt is accepted | Req 4.3 |
| 8 | Event Lifecycle State Machine Validity | Only valid transitions succeed; all invalid transitions return 400 with no state change | Req 4.6 |
| 9 | Venue Capacity Override Enforcement | Event capacity cannot exceed venue capacity unless explicit override is confirmed | Req 5.3, 5.4 |
| 10 | Ticket Code Uniqueness | For any N tickets created across any events, all ticketCodes are distinct UUIDs | Req 6.1 |
| 11 | Event Capacity Invariant | confirmedCount never exceeds event capacity; attempt to RSVP beyond capacity always creates Waitlisted ticket | Req 6.5, 6.6 |
| 12 | Waitlist Promotion FIFO Invariant | On cancellation, the ticket with the lowest waitlistPosition is always promoted first | Req 6.7 |
| 13 | Announcement Audience Targeting Completeness | For any audience spec, every qualifying member receives exactly one notification; no non-qualifying member receives it | Req 7.2 |
| 14 | Email Opt-Out Suppression | For any member with email opt-out enabled for an org, no email notification is dispatched for that org | Req 7.9 |
| 15 | Check-In Idempotency | Re-checking in a checked-in ticket returns the original checkedInAt timestamp and does not create a second record | Req 8.3 |
| 16 | Dashboard Metric Calculation Correctness | For any set of events/tickets, computed attendance rate = confirmedCount / capacity; check-in rate = checkedInCount / confirmedCount | Req 9.3, 9.4 |
| 17 | Report Sync/Async Routing | For ≤ 100 events in date range, report is returned synchronously; for > 100, a jobId is returned and status is pending | Req 10.5, 10.6 |
| 18 | Event Publish Atomicity | An Event is either Published with EventBridge rules created, or Draft with no rules — never partial state | Req 11.2 |
| 19 | Retry Semantics Correctness | On transient DynamoDB failure, operation is retried up to 3 times with exponential backoff before failing | Req 11.6, 21.2 |
| 20 | No PII in Bedrock Prompts | For any Bedrock prompt assembled by the system, it contains no email addresses, Member IDs, or Member name strings | Req 12.2, 14.6 |
| 21 | AI Response Validation Rejection | Any Bedrock response with < 100 words or empty content is rejected; responses 100–500 words are accepted | Req 12.4 |
| 22 | Scheduling Suggestion Range and Ordering | All returned suggestions have predictedAttendance ∈ [0,100]; suggestions are sorted descending by predictedAttendance; count ∈ [1,5] | Req 13.1, 13.4 |
| 23 | Sentiment Score Range Enforcement | Any raw Bedrock sentiment score outside [-1.0, 1.0] is clamped; scores within range are returned unchanged | Req 14.3 |
| 24 | HTTP Status Code Mapping Invariant | For any valid request, response status matches the defined mapping (200/201/204/400/401/403/404/409/500) | Req 23.5 |
| 25 | Error Response Structure Completeness | Every error response body contains exactly `errorCode`, `message` (≤ 500 chars), and `correlationId` | Req 23.6 |
| 26 | Domain Event Serialization Round-Trip | For any domain event, serialize → deserialize produces semantically equivalent object with no field loss | Req 18.4 |
| 27 | CSV Export Round-Trip | For any analytics data, export to CSV then parse back produces identical records (RFC 4180 compliant) | Req 18.6 |
| 28 | iCalendar Export Field Fidelity | For any event, generated .ics contains DTSTART, DTEND with correct TZID, SUMMARY matching title, LOCATION or URL | Req 20.1, 20.2 |
| 29 | Circuit Breaker State Transitions | After 5 consecutive Bedrock failures within 60s, state is OPEN; after 120s becomes HALF_OPEN; on success → CLOSED | Req 21.4 |
| 30 | Audit Log Entry Completeness | Every security-relevant operation produces exactly one audit log entry with all required fields populated | Req 16.2 |

---

## Lambda Handler Pattern
```typescript
export const handler = errorMiddleware(async (event, context) => {
  // 1. Extract from authorizer context ONLY
  const { orgId, memberId, role } = event.requestContext.authorizer;
  const correlationId = event.headers['X-Correlation-ID'] ?? context.awsRequestId;

  // 2. Validate payload
  validatePayload(schema, JSON.parse(event.body ?? '{}'));

  // 3. RBAC check
  requirePermission(role, 'events:create');

  // 4. Business logic (service layer, no AWS SDK)
  const result = await service.doSomething(orgId, memberId, payload);

  // 5. Return response
  return { statusCode: 201, body: JSON.stringify(result) };
});
```

## How to Run
```bash
# Frontend dev server
cd frontend && npm run dev

# Frontend tests (vitest)
cd frontend && npm test

# Frontend type check
cd frontend && npx tsc --noEmit

# Frontend build
cd frontend && npm run build

# Backend type check
cd infrastructure/lambda && npx tsc --noEmit

# CDK synth
cd infrastructure && npx cdk synth

# Backend unit + property tests
cd infrastructure/lambda && npm test
```

## Commit Convention
- `feat(lambda): description (Task X.Y)`
- `feat(infra): description (Task X.Y)`
- `test(lambda): description (Task X.Y)`
- `feat(frontend): description (Task X.Y)`
Never mention task sub-numbers outside the current commit scope.
