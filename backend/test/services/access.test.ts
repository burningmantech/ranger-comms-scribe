import { describe, it, expect } from '@jest/globals';
import {
  accessOf,
  approverCounts,
  derivedRoles,
  derivedUserType,
  isReviewer,
  rolesResponse,
  withDerivedAccess,
} from '../../src/services/access';

describe('access', () => {
  it('reads the access fields of a migrated record, ignoring its derived type', () => {
    const user = { email: 'a@x.org', approved: true, accessVersion: 1, isAdmin: false, commsCadre: true, councilRoles: ['CommunicationsManager', 'Bogus'], userType: 'Public', roles: [] };
    expect(accessOf(user)).toEqual({ approved: true, isAdmin: false, commsCadre: true, councilRoles: ['CommunicationsManager'], council: true });
  });

  it('falls back to the type and roles of a record from before the migration', () => {
    expect(accessOf({ email: 'a@x.org', userType: 'Admin', isAdmin: false, roles: [] })).toMatchObject({ isAdmin: true });
    expect(accessOf({ email: 'a@x.org', userType: 'Member', roles: ['CommsCadre'] })).toMatchObject({ commsCadre: true, council: false });
    expect(accessOf({ email: 'a@x.org', userType: 'CouncilManager', roles: [] })).toMatchObject({ council: true, councilRoles: [] });
    expect(accessOf(null)).toMatchObject({ isAdmin: false, commsCadre: false, council: false });
  });

  it('treats a verified bootstrap address as Admin, but not an unverified one', () => {
    const env = { BOOTSTRAP_ADMIN_EMAILS: ['Boss@X.org'] };
    const base = { email: 'boss@x.org', accessVersion: 1, isAdmin: false, approved: false, commsCadre: false, councilRoles: [] };
    expect(accessOf({ ...base, verified: true }, env)).toMatchObject({ isAdmin: true, approved: true });
    expect(accessOf({ ...base, verified: false }, env)).toMatchObject({ isAdmin: false, approved: false });
  });

  it('derives the legacy type and roles', () => {
    const both = { approved: true, isAdmin: false, commsCadre: true, councilRoles: ['IntakeManager' as any], council: true };
    expect(derivedUserType(both)).toBe('CouncilManager');
    expect(derivedRoles(both)).toEqual(['CommsCadre', 'CouncilManager']);
    expect(derivedUserType({ ...both, commsCadre: false, councilRoles: [], council: false })).toBe('Member');
    expect(derivedRoles({ ...both, approved: false, commsCadre: false, councilRoles: [], council: false })).toEqual(['Public']);
    const saved = withDerivedAccess({ email: 'a@x.org', userType: 'Lead', roles: ['Public'] }, both);
    expect(saved).toMatchObject({ userType: 'CouncilManager', roles: ['CommsCadre', 'CouncilManager'], accessVersion: 1, commsCadre: true });
  });

  it('counts an approval for a gate by what the approver held then or holds now', () => {
    expect(approverCounts({ approverType: 'CommsCadre' })).toEqual({ council: false, commsCadre: true });
    expect(approverCounts({ approverType: 'Member', approverRoles: ['CommsCadre', 'CouncilManager'] })).toEqual({ council: true, commsCadre: true });
    expect(approverCounts({ approverType: 'Member' }, accessOf({ accessVersion: 1, councilRoles: ['IntakeManager'] }))).toEqual({ council: true, commsCadre: false });
  });

  it('gives reviewers the review permissions and others none', () => {
    expect(isReviewer({ accessVersion: 1, councilRoles: ['IntakeManager'] })).toBe(true);
    expect(isReviewer({ accessVersion: 1, approved: true })).toBe(false);
    expect(rolesResponse({ accessVersion: 1, commsCadre: true, councilRoles: ['CommunicationsManager'] })).toEqual({
      roles: ['CommsCadre', 'CouncilManager'],
      permissions: expect.objectContaining({ canApprove: true, canViewFilteredSubmissions: true }),
    });
    expect(rolesResponse({ accessVersion: 1, approved: true }).roles).toEqual([]);
  });
});
