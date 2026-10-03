import { APIGatewayTokenAuthorizerEvent, APIGatewayAuthorizerResult, Context } from 'aws-lambda';
import * as jwt from 'jsonwebtoken';
import { getPublicKey, decodeTokenHeader } from './jwksClient';
import { CloisJwtClaims, OrgRole, OrgRolesMap } from './types';

const COGNITO_REGION = process.env['COGNITO_REGION'] ?? 'us-east-1';
const USER_POOL_ID = process.env['USER_POOL_ID'] ?? '';
const EXPECTED_ISSUER = 'https://cognito-idp.' + COGNITO_REGION + '.amazonaws.com/' + USER_POOL_ID;
const EXPECTED_AUDIENCE = process.env['COGNITO_CLIENT_ID'] ?? '';

function extractOrgIdFromArn(methodArn: string): string | null {
  const parts = methodArn.split('/');
  const segs = parts.slice(4);
  const idx = segs.indexOf('orgs');
  if (idx !== -1 && segs[idx + 1]) return segs[idx + 1];
  return null;
}

function buildPolicy(principalId: string, effect: 'Allow' | 'Deny', resource: string, ctx?: Record<string, string>): APIGatewayAuthorizerResult {
  return { principalId, policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }] }, context: ctx ?? {} };
}

export const handler = async (event: APIGatewayTokenAuthorizerEvent, _context: Context): Promise<APIGatewayAuthorizerResult> => {
  const correlationId = 'auth-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
  const authHeader = event.authorizationToken ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  if (!token || token.trim() === '') throw new Error('Unauthorized');

  let claims: CloisJwtClaims;
  try {
    const header = decodeTokenHeader(token);
    const publicKey = await getPublicKey(header.kid);
    const decoded = jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer: EXPECTED_ISSUER, ...(EXPECTED_AUDIENCE ? { audience: EXPECTED_AUDIENCE } : {}) }) as CloisJwtClaims;
    if (!decoded.sub || !decoded['custom:orgRoles']) throw new Error('Missing claims');
    if (decoded.token_use !== 'access') throw new Error('Invalid token_use');
    claims = decoded;
  } catch { throw new Error('Unauthorized'); }

  const memberId = claims.sub;
  let orgRolesMap: OrgRolesMap = {};
  try { orgRolesMap = JSON.parse(claims['custom:orgRoles']) as OrgRolesMap; }
  catch { return buildPolicy(memberId, 'Deny', event.methodArn, { correlationId }); }

  const orgId = extractOrgIdFromArn(event.methodArn);
  if (!orgId) return buildPolicy(memberId, 'Allow', event.methodArn, { orgId: '', memberId, role: '', correlationId });

  const role = orgRolesMap[orgId] as OrgRole | undefined;
  if (!role) return buildPolicy(memberId, 'Deny', event.methodArn, { correlationId });

  return buildPolicy(memberId, 'Allow', event.methodArn, { orgId, memberId, role, correlationId });
};
