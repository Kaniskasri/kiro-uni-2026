import { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import {
  DynamoDBClient,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import * as jwt from 'jsonwebtoken';

const dynamo = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
const WS_TABLE = process.env['WS_CONNECTIONS_TABLE'] ?? 'clois-ws-connections';
const TTL_SECONDS = 7200; // 2 hours

interface DecodedToken {
  sub: string;
  'custom:orgRoles'?: string;
}

/**
 * Parses a raw query string (e.g. "token=abc&orgId=xyz") into a key-value map.
 */
function parseRawQueryString(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (!raw) return params;
  for (const part of raw.split('&')) {
    const [key, value] = part.split('=');
    if (key) params[decodeURIComponent(key)] = decodeURIComponent(value ?? '');
  }
  return params;
}

/**
 * WSConnectFn — $connect route handler.
 * Validates JWT from ?token= query param.
 * Stores {connectionId, memberId, orgId, connectedAt, TTL=+7200s} in clois-ws-connections.
 */
export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  // APIGatewayProxyWebsocketEventV2 exposes rawQueryString, not queryStringParameters
  const qs = parseRawQueryString((event as unknown as { rawQueryString?: string }).rawQueryString ?? '');
  const token = qs['token'];

  if (!token) {
    return { statusCode: 401, body: 'Missing token' };
  }

  let decoded: DecodedToken;
  try {
    // Decode without full verification here — full JWKS verification is done
    // in the Lambda Authorizer. We extract claims to store connection metadata.
    decoded = jwt.decode(token) as DecodedToken;
    if (!decoded || !decoded.sub) {
      return { statusCode: 401, body: 'Invalid token' };
    }
  } catch {
    return { statusCode: 401, body: 'Invalid token' };
  }

  const memberId = decoded.sub;
  const connectionId = event.requestContext.connectionId;
  const connectedAt = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  // Derive orgId from query param (client must pass it for routing)
  const orgId = qs['orgId'] ?? '';

  if (!orgId) {
    return { statusCode: 400, body: 'Missing orgId query parameter' };
  }

  await dynamo.send(
    new PutItemCommand({
      TableName: WS_TABLE,
      Item: marshall({
        PK: `CONNECTION#${connectionId}`,
        SK: 'METADATA',
        GSI1PK: `ORG#${orgId}`,
        GSI1SK: `MEMBER#${memberId}#CONNECTION#${connectionId}`,
        type: 'WS_CONNECTION',
        connectionId,
        memberId,
        orgId,
        connectedAt,
        ttl,
      }),
    }),
  );

  return { statusCode: 200, body: 'Connected' };
};
