import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

export type LambdaHandler = (
  event: APIGatewayProxyEvent,
  context: Context,
) => Promise<APIGatewayProxyResult>;

interface HttpError extends Error {
  statusCode?: number;
  errorCode?: string;
}

function getCorrelationId(event: APIGatewayProxyEvent): string {
  return (
    (event.headers?.['x-correlation-id'] as string | undefined) ??
    event.requestContext?.requestId ??
    ('req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9))
  );
}

export function errorMiddleware(handler: LambdaHandler): LambdaHandler {
  return async (event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> => {
    const correlationId = getCorrelationId(event);
    try {
      return await handler(event, context);
    } catch (err) {
      const error = err as HttpError;
      const statusCode = error.statusCode ?? 500;

      if (!error.statusCode || error.statusCode >= 500) {
        process.stderr.write(
          JSON.stringify({
            level: 'ERROR',
            correlationId,
            message: error.message,
            stack: error.stack,
            requestId: context.awsRequestId,
            path: event.path,
            method: event.httpMethod,
          }) + '\n',
        );
        return {
          statusCode: 500,
          headers: { 'Content-Type': 'application/json', 'X-Correlation-ID': correlationId },
          body: JSON.stringify({
            errorCode: 'internal.server_error',
            message: 'An unexpected error occurred. Please try again later.',
            correlationId,
          }),
        };
      }

      return {
        statusCode,
        headers: { 'Content-Type': 'application/json', 'X-Correlation-ID': correlationId },
        body: JSON.stringify({
          errorCode: error.errorCode ?? ('http.' + statusCode),
          message: (error.message ?? 'Request failed').slice(0, 500),
          correlationId,
        }),
      };
    }
  };
}

export function httpError(statusCode: number, errorCode: string, message: string): HttpError {
  return Object.assign(new Error(message), { statusCode, errorCode });
}