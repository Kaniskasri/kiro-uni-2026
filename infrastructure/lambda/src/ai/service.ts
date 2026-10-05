import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { assertPermission } from '../shared/layers/rbac';
import { writeAuditLog } from '../shared/middleware/writeAuditLog';
import { createBedrockCircuitBreaker } from '../shared/layers/circuitBreaker';
import {
  DescribeEventRequest,
  DescribeEventResponse,
  ScheduleSuggestion,
  SuggestScheduleResponse,
  SentimentAnalysisResponse,
} from './types';

// ─── Bedrock client ───────────────────────────────────────────────────────────

const bedrock = new BedrockRuntimeClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });

const MODEL_SONNET = 'anthropic.claude-3-sonnet-20240229-v1:0';
const MODEL_HAIKU = 'anthropic.claude-3-haiku-20240307-v1:0';

// ─── PII stripping ────────────────────────────────────────────────────────────

/**
 * Strips PII from feedback text before sending to Bedrock.
 * Removes: email addresses, member IDs, phone numbers.
 * Property 20 enforces: no PII in Bedrock prompts.
 */
export function stripPII(text: string): string {
  // Remove email addresses
  let clean = text.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[EMAIL]');
  // Remove member IDs (UUID-like patterns)
  clean = clean.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    '[ID]',
  );
  // Remove phone numbers (various formats)
  clean = clean.replace(/\b(\+?1?\s?)?(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})\b/g, '[PHONE]');
  return clean;
}

// ─── Bedrock invocation helper ────────────────────────────────────────────────

async function invokeBedrock(
  modelId: string,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };

  const command = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload),
  });

  const response = await bedrock.send(command);
  const responseBody = JSON.parse(Buffer.from(response.body).toString('utf-8')) as {
    content: Array<{ text: string }>;
  };

  return responseBody.content[0]?.text ?? '';
}

// ─── Word count helper ────────────────────────────────────────────────────────

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── Describe Event ───────────────────────────────────────────────────────────

export async function describeEvent(
  orgId: string,
  tenantId: string,
  callerRole: string,
  actorId: string,
  sourceIp: string,
  input: DescribeEventRequest,
): Promise<DescribeEventResponse> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'ai.access_denied',
    });
  }

  assertPermission(callerRole, 'ai:describe-event');

  // Validate input — no PII fields accepted
  if (!input.title || input.title.trim().length === 0) {
    throw Object.assign(new Error('title is required'), {
      statusCode: 400,
      errorCode: 'ai.invalid_input',
    });
  }

  // Build prompt — NEVER include PII (enforced by Property 20)
  // Only: title, keywords, targetAudience (description of audience type, not member data)
  const keywordsStr = (input.keywords ?? []).join(', ');
  const prompt =
    `Write a compelling event description for an event titled "${input.title}". ` +
    `Keywords: ${keywordsStr || 'none provided'}. ` +
    `Target audience: ${input.targetAudience || 'general audience'}. ` +
    `The description should be 100-500 words, professional, and engaging. ` +
    `Return only the description text, no headers or metadata.`;

  const cb = createBedrockCircuitBreaker('describe-event');
  const startTime = Date.now();
  let outcome: 'success' | 'failure' | 'circuit-open' = 'success';

  let description: string;

  try {
    description = await cb.execute(() => invokeBedrock(MODEL_SONNET, prompt, 1024));
  } catch (err) {
    const error = err as Error & { errorCode?: string };
    if (error.errorCode === 'ai.service_unavailable') {
      outcome = 'circuit-open';
    } else {
      outcome = 'failure';
    }

    await writeAuditLog({
      timestamp: new Date().toISOString(),
      actor: actorId,
      targetType: 'AI_REQUEST',
      targetId: `describe-event-${orgId}`,
      operation: 'ai.describe_event',
      sourceIp,
      outcome: 'failure',
      orgId,
      metadata: {
        feature: 'description_generation',
        model: MODEL_SONNET,
        latencyMs: Date.now() - startTime,
        outcome,
      },
    });

    throw err;
  }

  const wordCount = countWords(description);

  // Validate response: 100-500 words
  if (wordCount < 100 || wordCount > 500) {
    await writeAuditLog({
      timestamp: new Date().toISOString(),
      actor: actorId,
      targetType: 'AI_REQUEST',
      targetId: `describe-event-${orgId}`,
      operation: 'ai.describe_event',
      sourceIp,
      outcome: 'failure',
      orgId,
      metadata: {
        feature: 'description_generation',
        model: MODEL_SONNET,
        latencyMs: Date.now() - startTime,
        outcome: 'validation_failed',
        wordCount,
      },
    });

    throw Object.assign(
      new Error(`AI response validation failed: description word count ${wordCount} is outside the required range of 100-500 words.`),
      { statusCode: 422, errorCode: 'ai.invalid_response' },
    );
  }

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: actorId,
    targetType: 'AI_REQUEST',
    targetId: `describe-event-${orgId}`,
    operation: 'ai.describe_event',
    sourceIp,
    outcome: 'success',
    orgId,
    metadata: {
      feature: 'description_generation',
      model: MODEL_SONNET,
      latencyMs: Date.now() - startTime,
      outcome: 'success',
      wordCount,
    },
  });

  return { description, wordCount };
}

// ─── Suggest Schedule ─────────────────────────────────────────────────────────

export interface CompletedEventStats {
  dayOfWeek: string;
  timeSlot: string;
  avgAttendance: number;
}

export async function suggestSchedule(
  orgId: string,
  tenantId: string,
  callerRole: string,
  actorId: string,
  sourceIp: string,
  completedEventCount: number,
  preAggregatedStats: CompletedEventStats[],
): Promise<SuggestScheduleResponse> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'ai.access_denied',
    });
  }

  assertPermission(callerRole, 'ai:suggest-schedule');

  if (completedEventCount < 5) {
    return {
      suggestions: [
        {
          dayOfWeek: 'Friday',
          timeSlot: '18:00',
          predictedAttendance: 70,
          reasoningFactors: ['Evening timeslots typically see higher attendance', 'End-of-week events are popular'],
        },
        {
          dayOfWeek: 'Saturday',
          timeSlot: '10:00',
          predictedAttendance: 65,
          reasoningFactors: ['Weekend morning availability is high', 'Morning events often have better energy'],
        },
        {
          dayOfWeek: 'Wednesday',
          timeSlot: '19:00',
          predictedAttendance: 60,
          reasoningFactors: ['Mid-week evenings are low-conflict', 'Consistent weekly scheduling builds habits'],
        },
      ],
      hasInsufficientData: true,
      message: 'Showing generic recommendations. Add at least 5 completed events for personalized suggestions.',
    };
  }

  // Build prompt with pre-aggregated stats only — NO PII
  const statsStr = preAggregatedStats
    .map((s) => `${s.dayOfWeek} ${s.timeSlot}: ${s.avgAttendance}% avg attendance`)
    .join('\n');

  const prompt =
    `Based on historical event attendance statistics for an organization, suggest the best schedule for future events.\n\n` +
    `Historical data (day × time slot → avg attendance %):\n${statsStr}\n\n` +
    `Return 1-5 scheduling suggestions as a JSON array with this exact structure:\n` +
    `[{"dayOfWeek": "Monday", "timeSlot": "14:00", "predictedAttendance": 85, "reasoningFactors": ["reason1", "reason2"]}]\n` +
    `Requirements:\n` +
    `- predictedAttendance must be 0-100\n` +
    `- Each suggestion must have at least 2 reasoningFactors\n` +
    `- Sort by predictedAttendance descending\n` +
    `- Return ONLY the JSON array, no other text.`;

  const cb = createBedrockCircuitBreaker('suggest-schedule');
  const startTime = Date.now();

  let rawResponse: string;

  try {
    rawResponse = await cb.execute(() => invokeBedrock(MODEL_HAIKU, prompt, 512));
  } catch (err) {
    const error = err as Error & { errorCode?: string };
    const outcome = error.errorCode === 'ai.service_unavailable' ? 'circuit-open' : 'failure';

    await writeAuditLog({
      timestamp: new Date().toISOString(),
      actor: actorId,
      targetType: 'AI_REQUEST',
      targetId: `suggest-schedule-${orgId}`,
      operation: 'ai.suggest_schedule',
      sourceIp,
      outcome: 'failure',
      orgId,
      metadata: { feature: 'scheduling_suggestions', model: MODEL_HAIKU, latencyMs: Date.now() - startTime, outcome },
    });

    throw err;
  }

  // Parse and validate response
  let suggestions: ScheduleSuggestion[];

  try {
    // Extract JSON array from response (may have extra text)
    const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in response');
    suggestions = JSON.parse(jsonMatch[0]) as ScheduleSuggestion[];
  } catch {
    throw Object.assign(
      new Error('AI response could not be parsed as scheduling suggestions'),
      { statusCode: 422, errorCode: 'ai.invalid_response' },
    );
  }

  // Validate structure and clamp values
  suggestions = suggestions
    .filter((s) => s.dayOfWeek && s.timeSlot && Array.isArray(s.reasoningFactors) && s.reasoningFactors.length >= 2)
    .map((s) => ({
      ...s,
      predictedAttendance: Math.max(0, Math.min(100, Math.round(s.predictedAttendance))),
    }))
    .sort((a, b) => b.predictedAttendance - a.predictedAttendance)
    .slice(0, 5);

  if (suggestions.length < 1) {
    throw Object.assign(
      new Error('AI response validation failed: no valid suggestions returned'),
      { statusCode: 422, errorCode: 'ai.invalid_response' },
    );
  }

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: actorId,
    targetType: 'AI_REQUEST',
    targetId: `suggest-schedule-${orgId}`,
    operation: 'ai.suggest_schedule',
    sourceIp,
    outcome: 'success',
    orgId,
    metadata: {
      feature: 'scheduling_suggestions',
      model: MODEL_HAIKU,
      latencyMs: Date.now() - startTime,
      suggestionCount: suggestions.length,
    },
  });

  return { suggestions };
}

// ─── Analyze Sentiment ────────────────────────────────────────────────────────

export async function analyzeSentiment(
  orgId: string,
  tenantId: string,
  callerRole: string,
  actorId: string,
  sourceIp: string,
  feedbackEntries: string[],
): Promise<SentimentAnalysisResponse> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'ai.access_denied',
    });
  }

  assertPermission(callerRole, 'ai:analyze-sentiment');

  if (feedbackEntries.length < 3) {
    throw Object.assign(
      new Error('Insufficient data: at least 3 feedback entries are required for sentiment analysis.'),
      { statusCode: 400, errorCode: 'ai.insufficient_data' },
    );
  }

  // Cap at 500 most recent entries
  const capped = feedbackEntries.slice(-500);

  // Strip PII from all entries before sending to Bedrock (Property 20)
  const cleanedEntries = capped.map((entry) => stripPII(entry));

  const feedbackStr = cleanedEntries.map((e, i) => `${i + 1}. ${e}`).join('\n');

  const prompt =
    `Analyze the sentiment of the following event feedback entries and return a JSON object.\n\n` +
    `Feedback:\n${feedbackStr}\n\n` +
    `Return ONLY a JSON object with this exact structure:\n` +
    `{"sentimentScore": 0.5, "positiveThemes": ["theme1", "theme2", "theme3"], "negativeThemes": ["theme1", "theme2", "theme3"]}\n` +
    `Requirements:\n` +
    `- sentimentScore: float between -1.0 (very negative) and 1.0 (very positive)\n` +
    `- positiveThemes: exactly 3 strings summarizing positive aspects\n` +
    `- negativeThemes: exactly 3 strings summarizing negative aspects\n` +
    `- Return ONLY the JSON object, no other text.`;

  const cb = createBedrockCircuitBreaker('analyze-sentiment');
  const startTime = Date.now();

  let rawResponse: string;

  try {
    rawResponse = await cb.execute(() => invokeBedrock(MODEL_SONNET, prompt, 1024));
  } catch (err) {
    const error = err as Error & { errorCode?: string };
    const outcome = error.errorCode === 'ai.service_unavailable' ? 'circuit-open' : 'failure';

    await writeAuditLog({
      timestamp: new Date().toISOString(),
      actor: actorId,
      targetType: 'AI_REQUEST',
      targetId: `analyze-sentiment-${orgId}`,
      operation: 'ai.analyze_sentiment',
      sourceIp,
      outcome: 'failure',
      orgId,
      metadata: { feature: 'sentiment_analysis', model: MODEL_SONNET, latencyMs: Date.now() - startTime, outcome },
    });

    throw err;
  }

  // Parse response
  let parsed: { sentimentScore: number; positiveThemes: string[]; negativeThemes: string[] };

  try {
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object in response');
    parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
  } catch {
    throw Object.assign(
      new Error('AI response could not be parsed as sentiment analysis result'),
      { statusCode: 422, errorCode: 'ai.invalid_response' },
    );
  }

  // Validate and clamp score to [-1, 1]
  const rawScore = parsed.sentimentScore;
  const sentimentScore = Math.max(-1.0, Math.min(1.0, rawScore));

  // Validate themes
  const positiveThemes = Array.isArray(parsed.positiveThemes)
    ? parsed.positiveThemes.slice(0, 3)
    : [];
  const negativeThemes = Array.isArray(parsed.negativeThemes)
    ? parsed.negativeThemes.slice(0, 3)
    : [];

  if (positiveThemes.length < 3 || negativeThemes.length < 3) {
    throw Object.assign(
      new Error('AI response validation failed: expected exactly 3 positive and 3 negative themes'),
      { statusCode: 422, errorCode: 'ai.invalid_response' },
    );
  }

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: actorId,
    targetType: 'AI_REQUEST',
    targetId: `analyze-sentiment-${orgId}`,
    operation: 'ai.analyze_sentiment',
    sourceIp,
    outcome: 'success',
    orgId,
    metadata: {
      feature: 'sentiment_analysis',
      model: MODEL_SONNET,
      latencyMs: Date.now() - startTime,
      feedbackCount: capped.length,
      sentimentScore,
    },
  });

  return {
    sentimentScore,
    positiveThemes,
    negativeThemes,
    feedbackCount: capped.length,
  };
}

// ─── Exported for property testing ───────────────────────────────────────────

/**
 * Validates that a prompt string contains no PII.
 * Used by Property 20 tests.
 */
export function containsPII(prompt: string): boolean {
  // Email pattern
  if (/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/.test(prompt)) return true;
  // UUID member ID pattern
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(prompt)) return true;
  return false;
}

/**
 * Validates AI describe-event response word count.
 * Used by Property 21 tests.
 */
export function validateDescriptionResponse(text: string): boolean {
  const words = countWords(text);
  return words >= 100 && words <= 500;
}

/**
 * Validates scheduling suggestions structure.
 * Used by Property 22 tests.
 */
export function validateSchedulingSuggestions(suggestions: ScheduleSuggestion[]): boolean {
  if (suggestions.length < 1 || suggestions.length > 5) return false;
  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    if (s.predictedAttendance < 0 || s.predictedAttendance > 100) return false;
    if (!Array.isArray(s.reasoningFactors) || s.reasoningFactors.length < 2) return false;
    // Check descending order
    if (i > 0 && s.predictedAttendance > suggestions[i - 1].predictedAttendance) return false;
  }
  return true;
}

/**
 * Clamps sentiment score to [-1, 1].
 * Used by Property 23 tests.
 */
export function clampSentimentScore(score: number): number {
  return Math.max(-1.0, Math.min(1.0, score));
}
