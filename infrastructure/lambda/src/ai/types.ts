// ─── AI request/response types ────────────────────────────────────────────────

export interface DescribeEventRequest {
  title: string;
  keywords: string[];
  targetAudience: string;
}

export interface DescribeEventResponse {
  description: string;
  wordCount: number;
}

export interface ScheduleSuggestion {
  dayOfWeek: string;       // e.g. "Monday"
  timeSlot: string;        // e.g. "14:00"
  predictedAttendance: number; // [0, 100]
  reasoningFactors: string[];  // at least 2
}

export interface SuggestScheduleRequest {
  orgId: string;
}

export interface SuggestScheduleResponse {
  suggestions: ScheduleSuggestion[];
  hasInsufficientData?: boolean;
  message?: string;
}

export interface SentimentAnalysisRequest {
  feedbackEntries: string[];
}

export interface SentimentAnalysisResponse {
  sentimentScore: number;       // [-1.0, 1.0]
  positiveThemes: string[];     // exactly 3
  negativeThemes: string[];     // exactly 3
  feedbackCount: number;
}

// ─── Bedrock invocation types ─────────────────────────────────────────────────

export interface BedrockMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface BedrockRequest {
  anthropic_version: string;
  max_tokens: number;
  messages: BedrockMessage[];
}

export interface BedrockResponse {
  content: Array<{ text: string }>;
  stop_reason: string;
}
