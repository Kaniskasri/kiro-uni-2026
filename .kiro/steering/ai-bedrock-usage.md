# CLOIS — AI & Amazon Bedrock Usage Conventions

## Core Principle: AI Is Never on the Critical Path

Amazon Bedrock is used for three features: event description generation, smart scheduling suggestions, and sentiment analysis. All three are optional accelerators. If Bedrock is unavailable, core CRUD operations must continue working normally.

## Circuit Breaker (Required for All Bedrock Calls)

Every call to Amazon Bedrock must go through the circuit breaker middleware in `/opt/circuitBreaker`.

**State machine**:
- `CLOSED` (normal) → `OPEN` (blocking) → `HALF_OPEN` (probe) → `CLOSED`
- Opens after **5 consecutive failures within 60 seconds**
- Stays OPEN for **120 seconds**
- HALF_OPEN allows 1 probe call; success → CLOSED, failure → OPEN again
- State is persisted in DynamoDB (with TTL) so it survives Lambda cold starts

When the circuit is OPEN, return a `serviceUnavailable` error immediately — do not invoke Bedrock.

## PII Prohibition (Strictly Enforced)

**No PII may ever appear in a Bedrock prompt.** This is enforced by Property 20.

- Description generation prompts contain only: event title, keyword list, and target audience description. No Member names, emails, or IDs.
- Scheduling suggestion prompts contain only: pre-aggregated statistical data (day-of-week × time slot → avg attendance). No raw Member records.
- Sentiment analysis prompts contain only: anonymized feedback text strings after PII stripping (regex + NER layer removes emails, names, and Member IDs before the Bedrock call).

## Model Selection

| Feature | Model | Max Tokens |
|---|---|---|
| Event description generation | Claude 3 Sonnet | 1024 |
| Smart scheduling suggestions | Claude 3 Haiku | 512 |
| Sentiment analysis | Claude 3 Sonnet | 1024 |

Use Haiku for scheduling to minimize cost, since this is a lighter structured-output task.

## Output Validation (Required)

All Bedrock responses must be validated before returning to the caller:

**Description generation**:
- Response must be non-empty, parseable, and between 100–500 words
- Reject and return an error if below 100 words or empty

**Smart scheduling**:
- Return 1–5 suggestions only (min 1 if org has ≥ 5 completed events)
- Each `predictedAttendance` must be in [0, 100]
- Suggestions must be sorted in descending order of `predictedAttendance`
- Each suggestion must include at least 2 reasoning factors

**Sentiment analysis**:
- `Sentiment_Score` must be clamped to [-1.0, 1.0] — clamp out-of-range raw values; never pass them through
- Return exactly 3 positive themes and 3 negative themes
- Reject corpus with fewer than 3 feedback entries (return insufficient-data message, no score)
- Cap at 500 entries (use the 500 most recent if more are provided)

## Audit Logging for AI Requests

Every Bedrock invocation must be logged in the Audit Log with:
- Prompt parameters (feature type, e.g., "description_generation", input fields — no PII)
- Model ID used
- Response latency (milliseconds)
- Outcome (success / failure / circuit-open)

## Graceful Degradation

- The event creation/editing form must remain fully functional when Bedrock is unavailable
- AI panels (`AIDescriptionPanel`, `SmartSchedulingPanel`, sentiment panel) must show an inline error state — never block or disable the parent form
- The frontend must not retry Bedrock requests automatically — user must explicitly re-trigger AI features
