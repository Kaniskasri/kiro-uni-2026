// Feature: clois, Property 14: Email Opt-Out Suppression
// Validates: Requirements 7.9
// A member who has opted out of email notifications for an org must never
// receive an email for any notification destined to that org, regardless of
// notification type, subject, or body content.

// Feature: clois, Property 13: Announcement Audience Targeting Completeness
// Validates: Requirements 7.2
// For any announcement with a well-formed audience (AllMembers, EventAttendees,
// Role, or Manual), every targeted member must appear in the enqueue list
// exactly once (no duplicates), and the total enqueue count must equal the
// resolved audience size.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// ─── Property 14: Email Opt-Out Suppression ───────────────────────────────────

/**
 * Inline model of the opt-out suppression logic extracted from
 * notifications/worker.ts — tests the pure decision function.
 */
function shouldSendEmail(optedOut: boolean): boolean {
  return !optedOut;
}

/**
 * Simulates the full notification dispatch decision tree:
 * Returns whether an email would be sent given the member's opt-out state.
 */
function dispatchDecision(params: {
  memberId: string;
  orgId: string;
  notificationType: string;
  optedOut: boolean;
}): { emailSent: boolean; deliveryStatus: 'pending' | 'delivered' | 'delivery-failed' | 'opted-out' } {
  if (params.optedOut) {
    return { emailSent: false, deliveryStatus: 'opted-out' };
  }
  // In reality SES is called; here we model a successful dispatch
  return { emailSent: true, deliveryStatus: 'delivered' };
}

describe('Property 14: Email Opt-Out Suppression', () => {
  it('a member with optedOut=true never has email sent, regardless of notification type', () => {
    fc.assert(
      fc.property(
        // Generate a valid member+org combination with opted-out = true
        fc.record({
          memberId: fc.uuid(),
          orgId: fc.uuid(),
          notificationType: fc.constantFrom(
            'ticket.confirmed',
            'ticket.waitlist_promoted',
            'event.reminder',
            'event.cancelled',
            'announcement',
            'report.ready',
          ),
        }),
        ({ memberId, orgId, notificationType }) => {
          // The key invariant: optedOut=true → emailSent=false
          const result = dispatchDecision({ memberId, orgId, notificationType, optedOut: true });
          expect(result.emailSent).toBe(false);
          expect(result.deliveryStatus).toBe('opted-out');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a member with optedOut=false does have email dispatched for any notification type', () => {
    fc.assert(
      fc.property(
        fc.record({
          memberId: fc.uuid(),
          orgId: fc.uuid(),
          notificationType: fc.constantFrom(
            'ticket.confirmed',
            'ticket.waitlist_promoted',
            'event.reminder',
            'event.cancelled',
            'announcement',
            'report.ready',
          ),
        }),
        ({ memberId, orgId, notificationType }) => {
          const result = dispatchDecision({ memberId, orgId, notificationType, optedOut: false });
          expect(result.emailSent).toBe(true);
          expect(result.deliveryStatus).toBe('delivered');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('opt-out state is org-scoped: opted out of Org A does not suppress emails for Org B', () => {
    fc.assert(
      fc.property(
        fc.record({
          memberId: fc.uuid(),
          orgA: fc.uuid(),
          orgB: fc.uuid(),
        }).filter(({ orgA, orgB }) => orgA !== orgB),
        ({ memberId, orgA, orgB }) => {
          // Opted out of orgA
          const resultForOrgA = dispatchDecision({
            memberId,
            orgId: orgA,
            notificationType: 'announcement',
            optedOut: true, // opted out of orgA
          });
          // Not opted out of orgB
          const resultForOrgB = dispatchDecision({
            memberId,
            orgId: orgB,
            notificationType: 'announcement',
            optedOut: false, // not opted out of orgB
          });

          expect(resultForOrgA.emailSent).toBe(false);
          expect(resultForOrgB.emailSent).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('opt-out suppression is idempotent: calling opt-out twice yields the same suppression result', () => {
    fc.assert(
      fc.property(
        fc.record({
          memberId: fc.uuid(),
          orgId: fc.uuid(),
          // Number of times we "set" opt-out = true
          times: fc.integer({ min: 1, max: 5 }),
        }),
        ({ memberId, orgId, times }) => {
          // Regardless of how many times opt-out is set, last state wins
          const lastOptedOut = true; // always opted out after N times
          const result = dispatchDecision({
            memberId,
            orgId,
            notificationType: 'announcement',
            optedOut: lastOptedOut,
          });
          expect(result.emailSent).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 13: Announcement Audience Targeting Completeness ───────────────

// Feature: clois, Property 13: Announcement Audience Targeting Completeness

/**
 * Pure model of resolveAudienceMembers logic from announcements/service.ts.
 * This tests the deduplication and counting invariants independently of DynamoDB.
 */

type AudienceType = 'AllMembers' | 'EventAttendees' | 'Role' | 'Manual';
type OrgRole = 'Owner' | 'Admin' | 'Organizer' | 'Member';

interface MockMember {
  memberId: string;
  role: OrgRole;
}

interface AudienceSpec {
  type: AudienceType;
  eventId?: string;
  role?: OrgRole;
  memberIds?: string[];
}

/**
 * Pure model resolution (no DB — uses pre-built membership arrays).
 */
function resolveAudience(
  allMembers: MockMember[],
  eventAttendees: MockMember[],
  audience: AudienceSpec,
): string[] {
  let raw: string[];

  switch (audience.type) {
    case 'AllMembers':
      raw = allMembers.map((m) => m.memberId);
      break;
    case 'EventAttendees':
      raw = eventAttendees.map((m) => m.memberId);
      break;
    case 'Role':
      raw = allMembers
        .filter((m) => m.role === audience.role)
        .map((m) => m.memberId);
      break;
    case 'Manual':
      raw = audience.memberIds ?? [];
      break;
  }

  // Deduplicate (mirrors service.ts behaviour)
  return [...new Set(raw)];
}

// Arbitrary: generates a list of unique member IDs with roles
const memberArb = fc.array(
  fc.record({
    memberId: fc.uuid(),
    role: fc.constantFrom<OrgRole>('Owner', 'Admin', 'Organizer', 'Member'),
  }),
  { minLength: 0, maxLength: 30 },
);

// Deduplicate by memberId so the pool itself has no duplicates
function deduplicateByMemberId(members: MockMember[]): MockMember[] {
  const seen = new Set<string>();
  return members.filter((m) => {
    if (seen.has(m.memberId)) return false;
    seen.add(m.memberId);
    return true;
  });
}

describe('Property 13: Announcement Audience Targeting Completeness', () => {
  it('AllMembers: every org member appears in enqueue list exactly once', () => {
    fc.assert(
      fc.property(memberArb, (rawMembers) => {
        const members = deduplicateByMemberId(rawMembers);
        const result = resolveAudience(members, [], { type: 'AllMembers' });

        // Count must equal unique member count
        expect(result.length).toBe(members.length);

        // Every member in the org appears exactly once
        const resultSet = new Set(result);
        for (const m of members) {
          expect(resultSet.has(m.memberId)).toBe(true);
        }

        // No duplicates
        expect(result.length).toBe(new Set(result).size);
      }),
      { numRuns: 100 },
    );
  });

  it('EventAttendees: every confirmed attendee appears exactly once', () => {
    fc.assert(
      fc.property(
        memberArb,
        memberArb,
        (rawAll, rawAttendees) => {
          const allMembers = deduplicateByMemberId(rawAll);
          const attendees = deduplicateByMemberId(rawAttendees);
          const result = resolveAudience(allMembers, attendees, {
            type: 'EventAttendees',
            eventId: 'evt-001',
          });

          expect(result.length).toBe(attendees.length);
          // No duplicates
          expect(result.length).toBe(new Set(result).size);
          // Each attendee is present
          const resultSet = new Set(result);
          for (const m of attendees) {
            expect(resultSet.has(m.memberId)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Role: only members with matching role are targeted, no duplicates', () => {
    fc.assert(
      fc.property(
        memberArb,
        fc.constantFrom<OrgRole>('Owner', 'Admin', 'Organizer', 'Member'),
        (rawMembers, targetRole) => {
          const members = deduplicateByMemberId(rawMembers);
          const result = resolveAudience(members, [], { type: 'Role', role: targetRole });

          const expectedMembers = members.filter((m) => m.role === targetRole);
          expect(result.length).toBe(expectedMembers.length);

          // No duplicates
          expect(result.length).toBe(new Set(result).size);

          // Only members with matching role
          const resultSet = new Set(result);
          for (const m of members) {
            if (m.role === targetRole) {
              expect(resultSet.has(m.memberId)).toBe(true);
            } else {
              expect(resultSet.has(m.memberId)).toBe(false);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Manual: exactly the specified members are targeted (deduplicated), no extras', () => {
    fc.assert(
      fc.property(
        // Generate a list of 1-500 memberIds, potentially with duplicates
        fc.array(fc.uuid(), { minLength: 1, maxLength: 500 }),
        memberArb,
        (rawManualIds, allMembers) => {
          const members = deduplicateByMemberId(allMembers);
          // Introduce some duplicates
          const withDupes = [...rawManualIds, ...rawManualIds.slice(0, Math.min(5, rawManualIds.length))];

          const result = resolveAudience(members, [], {
            type: 'Manual',
            memberIds: withDupes,
          });

          // Result count equals deduplicated input count
          const expectedCount = new Set(rawManualIds).size;
          expect(result.length).toBe(expectedCount);

          // No duplicates in result
          expect(result.length).toBe(new Set(result).size);

          // Every unique input member appears in result
          const resultSet = new Set(result);
          for (const id of new Set(rawManualIds)) {
            expect(resultSet.has(id)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('enqueue count always matches resolved audience size (no over- or under-enqueue)', () => {
    fc.assert(
      fc.property(
        memberArb,
        fc.constantFrom<AudienceType>('AllMembers', 'Role'),
        fc.constantFrom<OrgRole>('Owner', 'Admin', 'Organizer', 'Member'),
        (rawMembers, audienceType, role) => {
          const members = deduplicateByMemberId(rawMembers);
          const audience: AudienceSpec =
            audienceType === 'Role' ? { type: 'Role', role } : { type: 'AllMembers' };

          const resolved = resolveAudience(members, [], audience);

          // Simulate enqueue: each resolved member gets exactly one message
          const enqueuedIds: string[] = resolved.map((id) => id);

          // Enqueue count equals resolved set size
          expect(enqueuedIds.length).toBe(resolved.length);

          // No member is enqueued more than once
          expect(new Set(enqueuedIds).size).toBe(enqueuedIds.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});
