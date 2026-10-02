# CLOIS — Testing & Quality Standards

## Two-Layer Testing Strategy

CLOIS uses a dual approach: **property-based tests** for universal behavioral correctness and **example-based unit/integration tests** for specific scenarios and infrastructure wiring.

## Property-Based Tests (fast-check)

**Library**: fast-check  
**Minimum runs**: 100 iterations per property (`numRuns: 100`)  
**Location**: `infrastructure/lambda/src/__tests__/properties/` (backend), `frontend/src/__tests__/properties/` (frontend)  
**File naming**: `{domain}.property.test.ts`

Every property test must begin with this comment:
```typescript
// Feature: clois, Property N: <property_text>
```

There are 30 defined correctness properties (see `design.md` — Properties 1–30). Each property maps to a `*`-marked task in `tasks.md`. All 30 must be implemented before the project is considered complete.

Key properties to note:
- **Property 4 (Cross-Tenant Isolation)**: For any valid JWT scoped to Org A targeting a resource in Org B, the response must be `HTTP 403` — never 200, 201, or 404.
- **Property 8 (Event State Machine)**: Only valid transitions are allowed. Invalid transitions must be rejected.
- **Property 11 (Capacity Invariant)**: Confirmed ticket count must never exceed Event capacity.
- **Property 15 (Check-In Idempotency)**: Re-checking in a checked-in ticket must return the original timestamp without creating a second record.
- **Property 18 (Publish Atomicity)**: An Event is either Published with EventBridge rules, or Draft with no rules — never a partial state.
- **Property 20 (No PII in Bedrock)**: Bedrock prompts must never contain email addresses, Member IDs, or Member names.

## Unit Tests (Vitest)

**Library**: Vitest + @testing-library/react (frontend), Vitest (backend)  
**File naming**: `{Domain}Service.test.ts` (backend), `ComponentName.test.tsx` (frontend)

Required coverage areas:
- All validation rules (date constraints, field lengths, state transitions)
- Error paths: Bedrock unavailable, DynamoDB transient failure after 3 retries, expired invitation
- Edge cases: empty waitlist, sole Owner deletion attempt, bulk CSV with mixed valid/invalid rows
- UI: ticket card, check-in status, capacity badge, stale data indicator

## Integration Tests

**Environment**: DynamoDB Local (Docker) + LocalStack for SES + real AWS SDK calls for Step Functions  
**Location**: `infrastructure/lambda/src/__tests__/integration/`

Required coverage:
- EventBridge rule creation on Event publish
- Step Functions end-to-end execution flow
- SQS → Worker Lambda → SES email dispatch
- WebSocket connect → push → disconnect cycle
- Load test: 500 concurrent check-in requests (k6) verifying p95 ≤ 2 seconds

## CDK Infrastructure Tests

All CDK stacks must have `@aws-cdk/assertions` snapshot tests.  
CI runs `cdk diff --fail` and blocks deployment on any unintended resource deletions.

## Accessibility Tests

- Integrate `axe-core` into every Vitest + Testing Library render of a page component.
- Zero critical or serious violations are required for: LoginPage, RegisterPage, EventsListPage, EventDetailPage, CheckInPage, TicketCard.
- Manual screen reader testing (NVDA + Chrome, VoiceOver + Safari) is required for MVP user journeys before release.

## Code Quality Standards

- **TypeScript strict mode** is required for all files (frontend and backend). No `any` types without explicit justification.
- **Linting**: ESLint with `@typescript-eslint` strict rules. No warnings allowed in CI.
- **Formatting**: Prettier with project-wide config.
- **No `console.log`** in production code. Use the structured logger (CloudWatch-compatible) in Lambda functions.
- **No `Scan` operations** on DynamoDB tables in application code — ever.
- **No plaintext secrets** in code, comments, or environment variables committed to the repository.
- All Lambda cold starts for critical paths (auth, RSVP, check-in) must complete initialization within 3 seconds.

## CI Requirements

Every pull request must pass:
1. TypeScript compilation (`tsc --noEmit`)
2. ESLint (zero errors)
3. Vitest unit + property tests
4. CDK snapshot tests (`cdk synth` + assertions)
5. `cdk diff --fail` (no unintended resource deletions)
6. OpenAPI spec sync check (routes in `openapi.yaml` match deployed API)
