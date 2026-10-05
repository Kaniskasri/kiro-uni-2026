import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { errorMiddleware, httpError } from '../shared/middleware/errorMiddleware';

const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' }),
);
const TABLE = process.env['MAIN_TABLE'] ?? 'clois-main';

// ─── RFC 5545 iCalendar builder ───────────────────────────────────────────────

function escapeICSText(value: string): string {
  // RFC 5545: escape backslash, semicolon, comma, newlines
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

function foldICSLine(line: string): string {
  // RFC 5545: lines must be ≤75 octets; fold with CRLF + space
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const parts: string[] = [];
  let current = '';
  for (const char of line) {
    if (Buffer.byteLength(current + char, 'utf8') > 75) {
      parts.push(current);
      current = ' ' + char;
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts.join('\r\n');
}

/**
 * Converts a UTC ISO 8601 string to a local datetime string for iCal with TZID.
 * Format: YYYYMMDDTHHMMSS
 */
function toICSDateTime(isoString: string): string {
  const d = new Date(isoString);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

interface ICSEventData {
  uid: string;
  dtstart: string;      // UTC ISO 8601
  dtend: string;        // UTC ISO 8601
  timezone: string;     // IANA timezone
  summary: string;
  description?: string;
  location?: string;
  url?: string;
}

/**
 * Generates RFC 5545 compliant .ics content.
 * Exported for property testing.
 */
export function generateICS(data: ICSEventData): string {
  const dtstartLocal = toICSDateTime(data.dtstart);
  const dtendLocal = toICSDateTime(data.dtend);
  const now = toICSDateTime(new Date().toISOString());

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CLOIS//CLOIS Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${escapeICSText(data.uid)}`,
    `DTSTAMP:${now}Z`,
    `DTSTART;TZID=${escapeICSText(data.timezone)}:${dtstartLocal}`,
    `DTEND;TZID=${escapeICSText(data.timezone)}:${dtendLocal}`,
    `SUMMARY:${escapeICSText(data.summary)}`,
  ];

  if (data.description) {
    lines.push(`DESCRIPTION:${escapeICSText(data.description)}`);
  }

  if (data.location) {
    lines.push(`LOCATION:${escapeICSText(data.location)}`);
  } else if (data.url) {
    lines.push(`URL:${data.url}`);
  }

  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');

  return lines.map(foldICSLine).join('\r\n');
}

// ─── Route handler ─────────────────────────────────────────────────────────────

const rawHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const path = event.path;

  // GET /v1/orgs/{orgId}/events/{eventId}/tickets/{ticketId}/ical
  if (
    method === 'GET' &&
    /^\/v1\/orgs\/[^/]+\/events\/[^/]+\/tickets\/[^/]+\/ical\/?$/.test(path)
  ) {
    const ctx = event.requestContext?.authorizer as
      | { orgId?: string; memberId?: string; role?: string }
      | undefined;

    const tenantId = ctx?.orgId ?? '';
    if (!tenantId) {
      throw httpError(401, 'auth.unauthorized', 'Missing authorization context');
    }

    const pathOrgId = event.pathParameters?.['orgId'] ?? '';
    const eventId = event.pathParameters?.['eventId'];
    const ticketId = event.pathParameters?.['ticketId'];

    if (!eventId || !ticketId) {
      throw httpError(400, 'validation.missing_param', 'eventId and ticketId are required');
    }

    // Cross-org guard — 403 not 404
    if (tenantId !== pathOrgId) {
      throw httpError(403, 'calendar.access_denied', 'Access denied');
    }

    // Fetch event
    const eventResult = await dynamo.send(
      new GetCommand({
        TableName: TABLE,
        Key: {
          PK: `ORG#${pathOrgId}#EVENT#${eventId}`,
          SK: 'METADATA',
        },
      }),
    );

    if (!eventResult.Item || eventResult.Item['tenantId'] !== tenantId) {
      throw httpError(403, 'calendar.access_denied', 'Event not found or access denied');
    }

    const ev = eventResult.Item;

    // Fetch ticket to verify ownership
    const ticketResult = await dynamo.send(
      new GetCommand({
        TableName: TABLE,
        Key: {
          PK: `ORG#${pathOrgId}#EVENT#${eventId}#TICKET#${ticketId}`,
          SK: 'METADATA',
        },
      }),
    );

    if (!ticketResult.Item || ticketResult.Item['tenantId'] !== tenantId) {
      throw httpError(403, 'calendar.access_denied', 'Ticket not found or access denied');
    }

    const icsContent = generateICS({
      uid: `${ticketId}@clois`,
      dtstart: ev['startAt'] as string,
      dtend: ev['endAt'] as string,
      timezone: ev['timezone'] as string,
      summary: ev['title'] as string,
      description: ev['description'] as string | undefined,
      location: ev['isVirtual'] ? undefined : (ev['address'] as string | undefined),
      url: ev['isVirtual'] ? (ev['meetingUrl'] as string | undefined) : undefined,
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="event-${eventId}.ics"`,
      },
      body: icsContent,
    };
  }

  throw httpError(404, 'http.not_found', 'Route not found');
};

export const handler = errorMiddleware(rawHandler);
