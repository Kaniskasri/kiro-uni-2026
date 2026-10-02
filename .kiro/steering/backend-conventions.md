# CLOIS — Backend Lambda & AWS Conventions

## Lambda Function Structure

Each Lambda function is scoped to exactly one domain (Orgs, Events, Tickets, etc.). The directory structure under `infrastructure/lambda/` follows:

```
lambda/
├── {domain}/
│   ├── handler.ts     # Lambda handler entry point
│   ├── service.ts     # Business logic (no AWS SDK calls here)
│   ├── repository.ts  # DynamoDB access patterns for this domain
│   └── types.ts       # Domain-specific types and Zod schemas
├── shared/
│   ├── middleware/
│   │   ├── errorMiddleware.ts   # Wrap all handlers
│   │   ├── validatePayload.ts   # JSON Schema validation
│   │   └── writeAuditLog.ts     # Shared audit log writer
│   └── layers/
│       ├── circuitBreaker.ts    # Bedrock circuit breaker
│       └── rbac.ts              # Permission map enforcement
```

## Handler Pattern

Every Lambda handler must be wrapped with `errorMiddleware`:

```typescript
export const handler = errorMiddleware(async (event, context) => {
  // 1. Extract tenantId and memberId from authorizer context (NEVER from body/query)
  const { orgId, memberId, role } = event.requestContext.authorizer;
  // 2. Validate payload against JSON Schema
  // 3. Fine-grained RBAC check
  // 4. Business logic
  // 5. Return response
});
```

`errorMiddleware` must:
- Catch all unhandled exceptions
- Log full stack trace + request context to CloudWatch
- Return HTTP 500 with a generic `{ errorCode, message, correlationId }` — never expose stack traces

## Multi-Tenant Isolation (Critical)

- `tenantId` / `orgId` is **always** sourced from `event.requestContext.authorizer.orgId` (set by the Lambda Authorizer from the JWT claim).
- Path parameters (`:orgId`) are used only for DynamoDB key construction.
- Every DynamoDB `Query` and `GetItem` must include a `tenantId` condition expression.
- Never trust `orgId` from the request body, query string, or headers.

## DynamoDB Conventions

- **Single table**: `clois-main` for all domain data. The audit log is in a separate table `clois-audit-log`.
- **Key pattern**: `PK = TYPE#{id}`, `SK = SUBTYPE#{id}` or `METADATA`.
- **No table scans**: All access patterns must use `GetItem` or `Query` with a known PK. `Scan` is never used in application code.
- **Conditional writes**: Use `ConditionExpression` for uniqueness checks and state transitions rather than read-then-write.
- **Transient write failures**: Retry with exponential backoff (initial 5s, 2× multiplier, max 3 attempts) using the shared retry wrapper.
- The `clois-audit-log` table is append-only. Application IAM roles have `PutItem` only — never `UpdateItem` or `DeleteItem`.

## Error Response Contract

All Lambda functions must return errors in this exact structure:

```json
{
  "errorCode": "domain.error_type",
  "message": "Human-readable description (max 500 chars)",
  "correlationId": "req-abc123"
}
```

HTTP status codes must follow the standard mapping:
- `200` — successful read
- `201` — resource created
- `204` — successful delete (no body)
- `400` — validation error
- `401` — unauthenticated (missing/expired/invalid JWT)
- `403` — unauthorized (valid JWT, insufficient role or cross-org)
- `404` — not found
- `409` — conflict (duplicate slug, duplicate RSVP, etc.)
- `500` — unhandled server error

Never return `404` for cross-org resource access — always `403`.

## Asynchronous Processing

- Notification dispatch and report generation are always enqueued to SQS — never processed synchronously in an API Lambda.
- Every SQS consumer Lambda has a configured DLQ. Messages failing after 3 attempts move to the DLQ and trigger a CloudWatch alarm.
- All EventBridge domain events are serialized as JSON conforming to the versioned CloudEvents schema.
- All SQS message payloads are validated against their declared JSON Schema before processing. Invalid messages go to the DLQ with a schema-validation error.

## Step Functions

- All multi-step automated workflows are implemented as Step Functions state machines, never as chained Lambda calls.
- Every task state uses the standard retry config: `IntervalSeconds: 5, MaxAttempts: 3, BackoffRate: 2.0`.
- Every state machine has a terminal `MarkWorkflowFailed` catch state that writes an Audit Log entry.

## IAM / Least Privilege

- Each Lambda function has its own IAM execution role.
- Roles grant only the DynamoDB actions (`GetItem`, `PutItem`, `Query`, `UpdateItem`) needed for that specific domain — no blanket `dynamodb:*`.
- No Lambda role has `DeleteItem` or `UpdateItem` on the `clois-audit-log` table.

## CDK Conventions

- One stack per AWS concern: `DatabaseStack`, `StorageStack`, `AuthStack`, `ApiStack`, `MessagingStack`, `WorkflowStack`, `CdnStack`, `MonitoringStack`.
- Reusable patterns are CDK constructs in `lib/constructs/`: `LambdaFunction.ts`, `ApiRoute.ts`, `StepMachine.ts`.
- Every stack must have CDK snapshot tests (`@aws-cdk/assertions`).
- `cdk diff --fail` runs in CI and blocks deployment if the diff includes unintended resource deletions.
