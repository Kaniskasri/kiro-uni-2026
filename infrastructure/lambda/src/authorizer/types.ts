export type OrgRole = 'Owner' | 'Admin' | 'Organizer' | 'Member';

export type OrgRolesMap = Record<string, OrgRole>;

export interface AuthorizerContext {
  orgId: string;
  memberId: string;
  role: OrgRole | '';
  correlationId: string;
}

export interface CloisJwtClaims {
  sub: string;
  'custom:orgRoles': string;
  'custom:memberId'?: string;
  email?: string;
  exp: number;
  iss: string;
  aud: string | string[];
  token_use: string;
}
