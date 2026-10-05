import { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';

/**
 * WSMessageFn — $default route handler.
 * Routes inbound WebSocket messages. Currently, the system is push-only
 * from the server side; client messages are acknowledged but not processed.
 */
export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const connectionId = event.requestContext.connectionId;
  let body: unknown;

  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const message = body as Record<string, unknown>;
  const action = typeof message['action'] === 'string' ? message['action'] : 'unknown';

  // Log inbound message for observability (no PII)
  process.stdout.write(
    JSON.stringify({
      level: 'INFO',
      event: 'ws.message_received',
      connectionId,
      action,
    }) + '\n',
  );

  // Ping/pong support for keep-alive
  if (action === 'ping') {
    return { statusCode: 200, body: JSON.stringify({ action: 'pong' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ action: 'acknowledged' }) };
};
