import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

// ─── Circuit Breaker States ───────────────────────────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  failureThreshold: number;    // failures before opening (default: 5)
  windowSeconds: number;       // failure window in seconds (default: 60)
  openDurationSeconds: number; // how long to stay OPEN (default: 120)
  service: string;             // unique service name for DynamoDB key
}

interface CircuitStateItem {
  PK: string;                   // CB_STATE#{service}
  SK: string;                   // METADATA
  state: CircuitState;
  failureCount: number;
  windowStart: number;          // epoch ms
  openedAt?: number;            // epoch ms when circuit opened
  ttl?: number;                 // DynamoDB TTL (epoch seconds)
}

const DEFAULT_CONFIG: Omit<CircuitBreakerConfig, 'service'> = {
  failureThreshold: 5,
  windowSeconds: 60,
  openDurationSeconds: 120,
};

// ─── CircuitBreaker class ────────────────────────────────────────────────────

export class CircuitBreaker {
  private readonly config: CircuitBreakerConfig;
  private readonly dynamo: DynamoDBDocumentClient;
  private readonly table: string;

  // In-memory cache to reduce DynamoDB reads
  private cachedState: CircuitStateItem | null = null;
  private cacheExpiresAt = 0;

  constructor(config: Partial<CircuitBreakerConfig> & { service: string }) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    const client = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
    this.dynamo = DynamoDBDocumentClient.from(client);
    this.table = process.env['MAIN_TABLE'] ?? 'clois-main';
  }

  // ─── DynamoDB persistence ──────────────────────────────────────────────────

  private async loadState(): Promise<CircuitStateItem> {
    const now = Date.now();

    // Use cache if fresh (5 second TTL for in-memory cache)
    if (this.cachedState && this.cacheExpiresAt > now) {
      return this.cachedState;
    }

    try {
      const result = await this.dynamo.send(
        new GetCommand({
          TableName: this.table,
          Key: {
            PK: `CB_STATE#${this.config.service}`,
            SK: 'METADATA',
          },
        }),
      );

      if (result.Item) {
        this.cachedState = result.Item as CircuitStateItem;
        this.cacheExpiresAt = now + 5000;
        return this.cachedState;
      }
    } catch {
      // If DynamoDB is unavailable, default to CLOSED (fail open)
    }

    // Default state
    const defaultState: CircuitStateItem = {
      PK: `CB_STATE#${this.config.service}`,
      SK: 'METADATA',
      state: 'CLOSED',
      failureCount: 0,
      windowStart: now,
    };
    this.cachedState = defaultState;
    this.cacheExpiresAt = now + 5000;
    return defaultState;
  }

  private async saveState(item: CircuitStateItem): Promise<void> {
    this.cachedState = item;
    this.cacheExpiresAt = Date.now() + 5000;

    try {
      await this.dynamo.send(
        new PutCommand({
          TableName: this.table,
          Item: item,
        }),
      );
    } catch {
      // Log but don't fail — circuit breaker state persistence is best-effort
      process.stderr.write(
        `[CircuitBreaker] Failed to persist state for ${this.config.service}\n`,
      );
    }
  }

  // ─── State queries ─────────────────────────────────────────────────────────

  /**
   * Returns the current logical state, accounting for OPEN → HALF_OPEN transition
   * after the open duration has elapsed.
   */
  async getState(): Promise<CircuitState> {
    const item = await this.loadState();
    return this.resolveState(item);
  }

  private resolveState(item: CircuitStateItem): CircuitState {
    if (item.state === 'OPEN' && item.openedAt !== undefined) {
      const elapsed = (Date.now() - item.openedAt) / 1000;
      if (elapsed >= this.config.openDurationSeconds) {
        return 'HALF_OPEN';
      }
    }
    return item.state;
  }

  // ─── Record outcomes ───────────────────────────────────────────────────────

  /**
   * Records a successful call. Resets failure count and closes the circuit.
   */
  async recordSuccess(): Promise<void> {
    const now = Date.now();
    const item = await this.loadState();

    const updated: CircuitStateItem = {
      ...item,
      state: 'CLOSED',
      failureCount: 0,
      windowStart: now,
      openedAt: undefined,
      ttl: undefined,
    };

    await this.saveState(updated);
  }

  /**
   * Records a failed call. Opens the circuit after threshold failures within window.
   */
  async recordFailure(): Promise<void> {
    const now = Date.now();
    const item = await this.loadState();
    const currentState = this.resolveState(item);

    // If HALF_OPEN probe failed → reopen
    if (currentState === 'HALF_OPEN') {
      const ttlSeconds = Math.floor(now / 1000) + this.config.openDurationSeconds + 60;
      const updated: CircuitStateItem = {
        ...item,
        state: 'OPEN',
        openedAt: now,
        ttl: ttlSeconds,
      };
      await this.saveState(updated);
      return;
    }

    // Reset window if outside the time window
    const windowStart =
      now - item.windowStart > this.config.windowSeconds * 1000
        ? now
        : item.windowStart;

    const failureCount =
      now - item.windowStart > this.config.windowSeconds * 1000
        ? 1
        : item.failureCount + 1;

    if (failureCount >= this.config.failureThreshold) {
      // Open the circuit
      const ttlSeconds = Math.floor(now / 1000) + this.config.openDurationSeconds + 60;
      const updated: CircuitStateItem = {
        ...item,
        state: 'OPEN',
        failureCount,
        windowStart,
        openedAt: now,
        ttl: ttlSeconds,
      };
      await this.saveState(updated);
    } else {
      const updated: CircuitStateItem = {
        ...item,
        state: 'CLOSED',
        failureCount,
        windowStart,
      };
      await this.saveState(updated);
    }
  }

  // ─── Execute with circuit breaker ─────────────────────────────────────────

  /**
   * Executes a function through the circuit breaker.
   * - CLOSED: execute normally, record success/failure
   * - OPEN: immediately throw serviceUnavailable error
   * - HALF_OPEN: allow one probe call
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = await this.getState();

    if (state === 'OPEN') {
      throw Object.assign(
        new Error(`Service ${this.config.service} is temporarily unavailable (circuit open)`),
        { statusCode: 503, errorCode: 'ai.service_unavailable' },
      );
    }

    try {
      const result = await fn();
      await this.recordSuccess();
      return result;
    } catch (err) {
      await this.recordFailure();
      throw err;
    }
  }
}

// ─── Factory helpers ──────────────────────────────────────────────────────────

export function createBedrockCircuitBreaker(service: string): CircuitBreaker {
  return new CircuitBreaker({
    service: `bedrock-${service}`,
    failureThreshold: 5,
    windowSeconds: 60,
    openDurationSeconds: 120,
  });
}
