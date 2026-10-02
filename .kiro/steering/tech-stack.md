# CLOIS — Technology Stack & Architecture Conventions

## Stack Overview

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript 5 + Vite 5 |
| Styling | Tailwind CSS 3 + shadcn/ui |
| Routing | React Router v6 (data router) |
| Global state | Zustand |
| Server state | TanStack Query v5 |
| Forms | React Hook Form + Zod |
| Real-time | API Gateway WebSocket + custom `useWebSocket` hook |
| Backend compute | AWS Lambda (Node.js 20, TypeScript) |
| API | AWS API Gateway REST (`/v1/*`) + WebSocket |
| Auth | AWS Cognito User Pool (JWT / TOTP MFA) |
| Database | AWS DynamoDB (single-table design) |
| Assets | AWS S3 |
| Messaging | AWS EventBridge + SQS + SNS + SES |
| Orchestration | AWS Step Functions |
| AI | Amazon Bedrock (Claude 3 Sonnet / Haiku) |
| IaC | AWS CDK (TypeScript) |
| Testing | Vitest + Testing Library + fast-check |

## Project Directory Layout

```
kiro-uni-2026/
├── frontend/          # React SPA (Vite + TypeScript + Tailwind)
├── infrastructure/    # AWS CDK app (TypeScript)
│   ├── bin/
│   ├── lib/
│   │   ├── stacks/    # One stack per AWS concern
│   │   └── constructs/# Reusable CDK constructs
│   └── lambda/        # All Lambda function source code
├── docs/
│   └── openapi.yaml   # OpenAPI 3.1 spec (kept in sync with deployed API)
└── .kiro/             # Kiro specs, hooks, and steering
```

## Architectural Principles

1. **Serverless-first**: No EC2/ECS. All compute is Lambda.
2. **Event-driven**: Domain events flow through EventBridge. Downstream consumers are decoupled via SQS.
3. **AI is optional**: Bedrock is never on the critical path for core CRUD. All AI features are protected by a circuit breaker and gracefully degrade.
4. **Multi-tenant by design**: Every API request is scoped to an `orgId` derived from the JWT — never from the request body or query parameters.
5. **RBAC server-side only**: Client-side permission checks are UI affordances only. Every permission decision happens in Lambda.
6. **TypeScript everywhere**: Frontend, backend Lambda functions, and CDK infrastructure all use TypeScript.

## API Versioning

- All REST endpoints are under the `/v1/` prefix.
- Breaking changes require a new version prefix (`/v2/`).
- Deprecated endpoints must include `Deprecation` and `Link: rel="successor-version"` response headers.
- The `docs/openapi.yaml` file must be updated in the same commit as any API change.
