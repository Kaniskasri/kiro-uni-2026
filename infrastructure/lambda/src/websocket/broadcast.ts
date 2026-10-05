import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import {
  DynamoDBClient,
  QueryCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const dynamo = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
const WS_TABLE = process.env['WS_CONNECTIONS_TABLE'] ?? 'clois-ws-connections';

interface WsConnectionItem {
  PK: string;
  SK: string;
  connectionId: string;
  memberId: string;
  orgId: string;
}

/**
 * Fetches all active connections for an org by querying GSI1 (ORG#{orgId}).
 */
async function getOrgConnections(orgId: string): Promise<WsConnectionItem[]> {
  const connections: WsConnectionItem[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: WS_TABLE,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :gsi1pk',
        ExpressionAttributeValues: marshall({ ':gsi1pk': `ORG#${orgId}` }),
        ExclusiveStartKey: lastKey
          ? marshall(lastKey)
          : undefined,
      }),
    );

    for (const item of result.Items ?? []) {
      connections.push(unmarshall(item) as WsConnectionItem);
    }

    lastKey = result.LastEvaluatedKey
      ? (unmarshall(result.LastEvaluatedKey) as Record<string, unknown>)
      : undefined;
  } while (lastKey);

  return connections;
}

/**
 * Deletes a stale connection record (called when ApiGateway returns GoneException).
 */
async function deleteStaleConnection(connectionId: string): Promise<void> {
  await dynamo.send(
    new DeleteItemCommand({
      TableName: WS_TABLE,
      Key: marshall({ PK: `CONNECTION#${connectionId}`, SK: 'METADATA' }),
    }),
  );
}

/**
 * Broadcasts a payload to all active WebSocket connections for an org.
 * On GoneException (410) the stale connection record is deleted.
 *
 * @param orgId - The organization ID to broadcast to
 * @param payload - The JSON-serializable message payload
 * @param wsEndpoint - ApiGateway Management API endpoint URL
 */
export async function broadcastToOrg(
  orgId: string,
  payload: Record<string, unknown>,
  wsEndpoint?: string,
): Promise<void> {
  const endpoint = wsEndpoint ?? process.env['WS_ENDPOINT'];
  if (!endpoint) {
    process.stderr.write('[broadcast] WS_ENDPOINT not configured, skipping broadcast\n');
    return;
  }

  const apigw = new ApiGatewayManagementApiClient({ endpoint });
  const connections = await getOrgConnections(orgId);

  if (connections.length === 0) return;

  const data = Buffer.from(JSON.stringify(payload));

  const results = await Promise.allSettled(
    connections.map(async (conn) => {
      try {
        await apigw.send(
          new PostToConnectionCommand({
            ConnectionId: conn.connectionId,
            Data: data,
          }),
        );
      } catch (err) {
        if (err instanceof GoneException) {
          // Connection is stale — clean it up
          await deleteStaleConnection(conn.connectionId);
          return;
        }
        throw err;
      }
    }),
  );

  // Log failures (non-fatal)
  for (const result of results) {
    if (result.status === 'rejected') {
      process.stderr.write(
        `[broadcast] Failed to send to a connection: ${String(result.reason)}\n`,
      );
    }
  }
}
