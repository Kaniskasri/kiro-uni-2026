// Feature: clois, Property 2: JWT Authorizer Rejects All Invalid Tokens
// Validates: Requirements 1.11, 15.3
// Uses fast-check to generate arbitrary invalid token strings and verify they are all rejected

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// --- Unit under test (pure logic extracted from handler) ---

type OrgRole = 'Owner' | 'Admin' | 'Organizer' | 'Member';
type OrgRolesMap = Record<string, OrgRole>;

interface CloisJwtClaims {
  sub: string;
  'custom:orgRoles': string;
  token_use: string;
  exp: number;
  iss: string;
}

function extractOrgIdFromArn(methodArn: string): string | null {
  const parts = methodArn.split('/');
  const resourceSegments = parts.slice(4);
  const orgsIndex = resourceSegments.indexOf('orgs');
  if (orgsIndex !== -1 && resourceSegments[orgsIndex + 1]) {
    return resourceSegments[orgsIndex + 1];
  }
  return null;
}

type AuthResult =
  | { type: 'unauthorized' }
  | { type: 'allow'; orgId: string; memberId: string; role: string }
  | { type: 'deny' };

function processToken(
  token: string,
  methodArn: string,
  verifyFn: (t: string) => CloisJwtClaims,
): AuthResult {
  if (!token || token.trim() === '') return { type: 'unauthorized' };

  let claims: CloisJwtClaims;
  try {
    claims = verifyFn(token);
    if (!claims.sub || !claims['custom:orgRoles']) return { type: 'unauthorized' };
    if (claims.token_use !== 'access') return { type: 'unauthorized' };
  } catch {
    return { type: 'unauthorized' };
  }

  const memberId = claims.sub;
  let orgRolesMap: OrgRolesMap = {};
  try {
    orgRolesMap = JSON.parse(claims['custom:orgRoles']) as OrgRolesMap;
  } catch {
    return { type: 'deny' };
  }

  const orgId = extractOrgIdFromArn(methodArn);
  if (!orgId) return { type: 'allow', orgId: '', memberId, role: '' };

  const role = orgRolesMap[orgId] as OrgRole | undefined;
  if (!role) return { type: 'deny' };

  return { type: 'allow', orgId, memberId, role };
}

const VALID_METHOD_ARN =
  'arn:aws:execute-api:us-east-1:123456789012/abc123/prod/GET/v1/orgs/org-1/events';

describe('Property 2: JWT Authorizer Rejects All Invalid Tokens', () => {
  it('rejects empty token strings', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('', ' ', '  ', '\t', '\n'),
        (token) => {
          const throwingVerify = () => { throw new Error('verify called'); };
          const result = processToken(token, VALID_METHOD_ARN, throwingVerify as never);
          expect(result.type).toBe('unauthorized');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects arbitrary non-JWT strings', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }).filter(
          (s) => !s.includes('.') || s.split('.').length !== 3,
        ),
        (token) => {
          const throwingVerify = (_t: string): CloisJwtClaims => {
            throw new Error('JsonWebTokenError');
          };
          const result = processToken(token, VALID_METHOD_ARN, throwingVerify);
          expect(result.type).toBe('unauthorized');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects JWTs missing required sub claim', () => {
    fc.assert(
      fc.property(
        fc.record({
          orgRoles: fc.jsonValue().map((v) => JSON.stringify(v)),
          tokenUse: fc.constantFrom('access', 'id', ''),
        }),
        ({ orgRoles, tokenUse }) => {
          const badVerify = (_t: string): CloisJwtClaims => ({
            sub: '',  // empty sub
            'custom:orgRoles': orgRoles,
            token_use: tokenUse,
            exp: Date.now() / 1000 + 3600,
            iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
          });
          const result = processToken('any.token.here', VALID_METHOD_ARN, badVerify);
          expect(result.type).toBe('unauthorized');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects JWTs with token_use !== access', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => s !== 'access'),
        (tokenUse) => {
          const badVerify = (_t: string): CloisJwtClaims => ({
            sub: 'member-123',
            'custom:orgRoles': JSON.stringify({ 'org-1': 'Member' }),
            token_use: tokenUse,
            exp: Date.now() / 1000 + 3600,
            iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
          });
          const result = processToken('any.token.here', VALID_METHOD_ARN, badVerify);
          expect(result.type).toBe('unauthorized');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('never returns allow for tokens that throw during verification', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        (token) => {
          const alwaysThrows = (_t: string): CloisJwtClaims => {
            throw new Error('Invalid signature');
          };
          const result = processToken(token, VALID_METHOD_ARN, alwaysThrows);
          expect(result.type).not.toBe('allow');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('valid token with no org membership returns deny (never allow or unauthorized)', () => {
    fc.assert(
      fc.property(
        fc.record({
          memberId: fc.uuid(),
          orgId: fc.uuid(),
          targetOrgId: fc.uuid(),
        }).filter(({ orgId, targetOrgId }) => orgId !== targetOrgId),
        ({ memberId, orgId, targetOrgId }) => {
          const validVerify = (_t: string): CloisJwtClaims => ({
            sub: memberId,
            'custom:orgRoles': JSON.stringify({ [orgId]: 'Member' }),
            token_use: 'access',
            exp: Date.now() / 1000 + 3600,
            iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
          });
          const methodArn = 'arn:aws:execute-api:us-east-1:123456789012/abc/prod/GET/v1/orgs/' + targetOrgId + '/events';
          const result = processToken('valid.jwt.token', methodArn, validVerify);
          // Cross-org access must be denied, not unauthorized or allowed
          expect(result.type).toBe('deny');
        },
      ),
      { numRuns: 100 },
    );
  });
});