import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { errorMiddleware, httpError } from '../shared/middleware/errorMiddleware';
import { validatePayload } from '../shared/middleware/validatePayload';
import * as authService from './service';

const SCHEMAS = {
  register: {
    type: 'object',
    required: ['email', 'password', 'name'],
    properties: {
      email: { type: 'string', format: 'email', maxLength: 254 },
      password: { type: 'string', minLength: 12, maxLength: 256 },
      name: { type: 'string', minLength: 1, maxLength: 100 },
    },
    additionalProperties: false,
  },
  login: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 1 },
      totpCode: { type: 'string', minLength: 6, maxLength: 6 },
    },
    additionalProperties: false,
  },
  verifyEmail: {
    type: 'object',
    required: ['email', 'code'],
    properties: {
      email: { type: 'string', format: 'email' },
      code: { type: 'string', minLength: 6, maxLength: 6 },
    },
    additionalProperties: false,
  },
  refresh: {
    type: 'object',
    required: ['refreshToken'],
    properties: { refreshToken: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  },
  forgotPassword: {
    type: 'object',
    required: ['email'],
    properties: { email: { type: 'string', format: 'email' } },
    additionalProperties: false,
  },
  resetPassword: {
    type: 'object',
    required: ['email', 'code', 'newPassword'],
    properties: {
      email: { type: 'string', format: 'email' },
      code: { type: 'string', minLength: 1 },
      newPassword: { type: 'string', minLength: 12, maxLength: 256 },
    },
    additionalProperties: false,
  },
  mfaVerify: {
    type: 'object',
    required: ['totpCode'],
    properties: { totpCode: { type: 'string', minLength: 6, maxLength: 6 } },
    additionalProperties: false,
  },
};

function parseBody(event: APIGatewayProxyEvent): unknown {
  if (!event.body) throw httpError(400, 'validation.missing_body', 'Request body is required');
  try {
    return JSON.parse(event.body);
  } catch {
    throw httpError(400, 'validation.invalid_json', 'Invalid JSON in request body');
  }
}

function ok(body: unknown, statusCode = 200): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const rawHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const path = event.path;
  const method = event.httpMethod;

  // POST /v1/auth/register
  if (method === 'POST' && path.endsWith('/auth/register')) {
    const body = validatePayload<{ email: string; password: string; name: string }>(
      SCHEMAS.register, parseBody(event), 'register',
    );
    await authService.register(body.email, body.password, body.name);
    return ok({ message: 'Registration successful. Please check your email to verify your account.' }, 201);
  }

  // POST /v1/auth/verify-email
  if (method === 'POST' && path.endsWith('/auth/verify-email')) {
    const body = validatePayload<{ email: string; code: string }>(
      SCHEMAS.verifyEmail, parseBody(event), 'verifyEmail',
    );
    await authService.verifyEmail(body.email, body.code);
    return ok({ message: 'Email verified successfully. You can now log in.' });
  }

  // POST /v1/auth/login
  if (method === 'POST' && path.endsWith('/auth/login')) {
    const body = validatePayload<{ email: string; password: string; totpCode?: string }>(
      SCHEMAS.login, parseBody(event), 'login',
    );
    const tokens = await authService.login(body.email, body.password, body.totpCode);
    return ok({ message: 'Login successful.', tokens });
  }

  // POST /v1/auth/refresh
  if (method === 'POST' && path.endsWith('/auth/refresh')) {
    const body = validatePayload<{ refreshToken: string }>(
      SCHEMAS.refresh, parseBody(event), 'refresh',
    );
    const tokens = await authService.refreshTokens(body.refreshToken);
    return ok({ message: 'Token refreshed.', tokens });
  }

  // POST /v1/auth/forgot-password
  if (method === 'POST' && path.endsWith('/auth/forgot-password')) {
    const body = validatePayload<{ email: string }>(
      SCHEMAS.forgotPassword, parseBody(event), 'forgotPassword',
    );
    await authService.forgotPassword(body.email);
    // Always return 200 even if email not found (prevent enumeration)
    return ok({ message: 'If that email exists, a password reset link has been sent.' });
  }

  // POST /v1/auth/reset-password
  if (method === 'POST' && path.endsWith('/auth/reset-password')) {
    const body = validatePayload<{ email: string; code: string; newPassword: string }>(
      SCHEMAS.resetPassword, parseBody(event), 'resetPassword',
    );
    await authService.resetPassword(body.email, body.code, body.newPassword);
    return ok({ message: 'Password reset successful.' });
  }

  // PUT /v1/auth/mfa/enable
  if (method === 'PUT' && path.endsWith('/auth/mfa/enable')) {
    const accessToken = event.headers?.['authorization']?.replace('Bearer ', '') ?? '';
    if (!accessToken) throw httpError(401, 'auth.unauthorized', 'Authorization header required');
    const secretCode = await authService.enableMfa(accessToken);
    return ok({ message: 'MFA setup initiated. Use this secret to configure your authenticator app.', secretCode });
  }

  // PUT /v1/auth/mfa/verify — verify TOTP and enable MFA
  if (method === 'PUT' && path.endsWith('/auth/mfa/verify')) {
    const accessToken = event.headers?.['authorization']?.replace('Bearer ', '') ?? '';
    if (!accessToken) throw httpError(401, 'auth.unauthorized', 'Authorization header required');
    const body = validatePayload<{ totpCode: string }>(SCHEMAS.mfaVerify, parseBody(event), 'mfaVerify');
    await authService.verifyAndEnableMfa(accessToken, body.totpCode);
    return ok({ message: 'MFA enabled successfully.' });
  }

  // PUT /v1/auth/mfa/disable
  if (method === 'PUT' && path.endsWith('/auth/mfa/disable')) {
    const accessToken = event.headers?.['authorization']?.replace('Bearer ', '') ?? '';
    if (!accessToken) throw httpError(401, 'auth.unauthorized', 'Authorization header required');
    await authService.disableMfa(accessToken);
    return ok({ message: 'MFA disabled successfully.' });
  }

  throw httpError(404, 'http.not_found', 'Route not found');
};

export const handler = errorMiddleware(rawHandler);