export type OrgRole = 'Owner' | 'Admin' | 'Organizer' | 'Member';

export const ROLE_HIERARCHY: Record<OrgRole, number> = {
  Owner: 4,
  Admin: 3,
  Organizer: 2,
  Member: 1,
};

export function hasPermission(userRole: OrgRole | string, requiredRole: OrgRole): boolean {
  const userLevel = ROLE_HIERARCHY[userRole as OrgRole] ?? 0;
  const requiredLevel = ROLE_HIERARCHY[requiredRole];
  return userLevel >= requiredLevel;
}

export const PERMISSION_MAP: Record<string, OrgRole> = {
  'org:delete': 'Owner',
  'org:transfer-ownership': 'Owner',
  'org:update': 'Admin',
  'org:deactivate': 'Owner',
  'members:invite': 'Admin',
  'members:invite-bulk': 'Admin',
  'members:remove': 'Admin',
  'members:change-role': 'Admin',
  'events:create': 'Organizer',
  'events:edit': 'Organizer',
  'events:cancel': 'Organizer',
  'events:publish': 'Organizer',
  'events:transition-admin': 'Admin',
  'venues:create': 'Organizer',
  'venues:edit': 'Organizer',
  'venues:delete': 'Admin',
  'tickets:list-all': 'Organizer',
  'tickets:cancel-any': 'Organizer',
  'checkin:perform': 'Organizer',
  'analytics:view-own': 'Organizer',
  'analytics:view-all': 'Admin',
  'analytics:export': 'Admin',
  'announcements:send': 'Organizer',
  'auditlog:view': 'Admin',
  'ai:describe-event': 'Organizer',
  'ai:suggest-schedule': 'Organizer',
  'ai:analyze-sentiment': 'Admin',
  'data:member-map': 'Admin',
};

export function assertPermission(userRole: OrgRole | string, operation: string): void {
  const required = PERMISSION_MAP[operation];
  if (!required) {
    throw new Error('Unknown operation: ' + operation);
  }
  if (!hasPermission(userRole, required)) {
    throw Object.assign(new Error('Insufficient role for operation: ' + operation), {
      statusCode: 403,
      errorCode: 'auth.insufficient_role',
    });
  }
}