import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient, QueryCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const WS_TABLE = process.env['WS_CONNECTIONS_TABLE'] ?? 'clois-ws-connections';
const WS_ENDPOINT = process.env['WS_API_ENDPOINT'] ?? '';

const dynamo = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });

// ─── Broadcast utility ────────────────────────────────────────────────────────

/**
 * Broadcasts a typed WebSocket event to all active connections for an org.
 * Stale connections (GoneException) are deleted from the connections table.
 *
 * This is a stub implementation — in production the WS_API_ENDPOINT
 * environment variable is set to the ApiGateway Management API endpoint.
 */
export async function broadcastToOrg(
  orgId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!WS_ENDPOINT) {
    // No WebSocket endpoint configured — skip broadcast (graceful degradation)
    return;
  }

  const apigw = new ApiGatewayManagementApiClient({ endpoint: WS_ENDPOINT });

  // Query all connections for this org
  let lastKey: Record<string, unknown> | undefined;
  const connectionIds: string[] = [];

  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: WS_TABLE,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: marshall({ ':pk': `ORG#${orgId}` }),
        ExclusiveStartKey: lastKey
          ? marshall(lastKey as Record<string, string>)
          : undefined,
      }),
    );

    for (const item of result.Items ?? []) {
      const conn = unmarshall(item) as { connectionId?: string };
      if (conn.connectionId) {
        connectionIds.push(conn.connectionId);
      }
    }

    lastKey = result.LastEvaluatedKey
      ? (unmarshall(result.LastEvaluatedKey) as Record<string, unknown>)
      : undefined;
  } while (lastKey);

  const message = JSON.stringify({ type: eventType, data: payload });
  const data = Buffer.from(message);

  // Post to each connection in parallel; remove stale connections
  await Promise.all(
    connectionIds.map(async (connectionId) => {
      try {
        await apigw.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: data }));
      } catch (err) {
        if (err instanceof GoneException) {
          // Connection is stale — remove it
          try {
            await dynamo.send(
              new DeleteItemCommand({
                TableName: WS_TABLE,
                Key: marshall({ PK: `ORG#${orgId}`, SK: `CONN#${connectionId}` }),
              }),
            );
          } catch {
            // Best-effort cleanup
          }
        }
        // Other errors are swallowed — broadcast failures are non-fatal
      }
    }),
  );
}
