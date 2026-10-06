import { create } from 'zustand';
import { MemberRole, Organization } from '../types';

interface OrgState {
  currentOrg: Organization | null;
  role: MemberRole | null;
  permissions: string[];
  setOrg: (org: Organization, role: MemberRole) => void;
  clearOrg: () => void;
}

const ROLE_PERMISSIONS: Record<MemberRole, string[]> = {
  Owner: [
    'org:delete', 'org:transfer', 'org:update', 'org:deactivate',
    'members:invite', 'members:remove', 'members:role-change',
    'events:create', 'events:edit', 'events:cancel', 'events:publish',
    'venues:create', 'venues:edit', 'venues:delete',
    'analytics:view-all', 'audit-log:view',
    'announcements:send',
  ],
  Admin: [
    'org:update',
    'members:invite', 'members:remove', 'members:role-change',
    'events:create', 'events:edit', 'events:cancel', 'events:publish',
    'venues:create', 'venues:edit', 'venues:delete',
    'analytics:view-all', 'audit-log:view',
    'announcements:send',
  ],
  Organizer: [
    'events:create', 'events:edit', 'events:cancel', 'events:publish',
    'venues:create', 'venues:edit',
    'analytics:view-own',
    'announcements:send',
  ],
  Member: [
    'events:rsvp', 'tickets:cancel-own', 'profile:view',
  ],
};

export const useOrgStore = create<OrgState>()((set) => ({
  currentOrg: null,
  role: null,
  permissions: [],

  setOrg: (org, role) =>
    set({ currentOrg: org, role, permissions: ROLE_PERMISSIONS[role] ?? [] }),

  clearOrg: () => set({ currentOrg: null, role: null, permissions: [] }),
}));
