# CLOIS — Security & Multi-Tenant Isolation

## Authentication

- All authentication is handled by AWS Cognito User Pool.
- Access tokens expire after **1 hour**. Refresh tokens expire after **30 days**.
- Password policy: minimum 12 characters, must include uppercase, lowercase, digit, and special character.
- TOTP MFA is optional per Member. When enabled, a valid TOTP code is required on every login after password validation.
- After 5 consecutive incorrect TOTP codes in a single session, the session is locked and the lockout is written to the Audit Log.
- Password reset links expire after **15 minutes**. Requesting a new reset link invalidates any previously issued unexpired link.

## JWT & Lambda Authorizer

- Every request to `/v1/*` passes through the Lambda Authorizer before reaching any application Lambda.
- The Authorizer validates: JWT signature (against Cognito JWKS, cached 1 hour), expiry, issuer, audience, and presence of required claims (`sub`, `custom:orgRoles`).
- Returns `HTTP 401` for missing, expired, or structurally invalid tokens.
- Returns `HTTP 403` for valid tokens with insufficient role for the requested operation.
- The `custom:orgRoles` claim contains a JSON map of `{ orgId: role }` updated on every role change.

## Multi-Tenant Isolation

This is the most critical security invariant in CLOIS. Violations result in data leakage between organizations.

**Rule**: `tenantId` / `orgId` is **always and only** sourced from `event.requestContext.authorizer.orgId` (set by the Lambda Authorizer from the verified JWT claim).

- Path parameters like `:orgId` are used only for DynamoDB key construction — they are not trusted for access control decisions alone.
- Every DynamoDB `Query` or `GetItem` in every domain Lambda must include a `tenantId` condition expression, even when the PK already includes `ORG#{orgId}`.
- Cross-org access attempts always return `HTTP 403` — never `HTTP 404`. Do not reveal whether a resource exists in another organization.
- Audit log entries for one organization must never be returned in queries from another organization.

## RBAC (Role-Based Access Control)

Four roles per organization, with strict hierarchy: **Owner ⊇ Admin ⊇ Organizer ⊇ Member**.

| Role | Key permissions |
|---|---|
| Owner | All permissions including org deletion and ownership transfer |
| Admin | All permissions except org deletion and ownership transfer |
| Organizer | Create/edit/cancel Events, manage Venues, send Announcements to Event Attendees, view Analytics for own Events |
| Member | RSVP to Events, cancel own Tickets, view own profile and Notifications |

**Enforcement rules**:
- Permissions are checked server-side in every Lambda handler after the Lambda Authorizer step.
- Client-side permission checks are UI affordances only — they are never the authority.
- An Organization must always retain at least one Owner. Attempts to remove or demote the sole Owner must be rejected.
- Ownership transfers are only valid when the target is an existing Member of the Organization.

## Data Privacy

- Member passwords are managed exclusively through Cognito. Plaintext or weakly hashed passwords must never be stored in DynamoDB or S3.
- PII fields in DynamoDB (email, name, phone) must be tagged with a data classification attribute for compliance audits.
- All API and frontend traffic is HTTPS only. HTTP requests are redirected with HTTP 301.
- On account deletion, PII is anonymized (replaced with placeholder values) within 30 days — individual records in Analytics Reports are anonymized, not deleted.
- A Member cannot delete their account if they are the sole Owner of any Organization. Ownership must be transferred first.
- Data export requests (GDPR-style) must be fulfilled with a pre-signed download URL within 24 hours.

## Audit Logging

An immutable Audit Log entry must be written for every security-relevant operation:

- User login / logout / failed login / MFA lockout
- Password change / reset
- Role assignment change / Member removal
- Organization creation / deactivation
- Event state transition
- Ticket creation / cancellation
- Bulk invitation submission
- AI generation request (prompt params only, no PII)
- Data export request

Each entry must include: `timestamp` (UTC ISO 8601), `actor` (memberId or "system"), `targetType`, `targetId`, `operation`, `sourceIp`, `outcome`.

The `clois-audit-log` DynamoDB table is append-only. No application IAM role has `UpdateItem` or `DeleteItem` on this table.

## AI & PII

- Amazon Bedrock prompts must never contain email addresses, Member IDs, or any string sourced from a Member's name or profile.
- For sentiment analysis, PII must be stripped from feedback text before sending to Bedrock (regex + NER layer in Lambda).
- AI requests are logged in the Audit Log with prompt parameters (excluding PII), the model used, and response latency.
