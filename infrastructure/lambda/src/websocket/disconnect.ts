import { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import { DynamoDBClient, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const dynamo = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
const WS_TABLE = process.env['WS_CONNECTIONS_TABLE'] ?? 'clois-ws-connections';

/**
 * WSDisconnectFn — $disconnect route handler.
 * Deletes the connection record from clois-ws-connections.
 */
export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const connectionId = event.requestContext.connectionId;

  await dynamo.send(
    new DeleteItemCommand({
      TableName: WS_TABLE,
      Key: marshall({
        PK: `CONNECTION#${connectionId}`,
        SK: 'METADATA',
      }),
    }),
  );

  return { statusCode: 200, body: 'Disconnected' };
};
