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
  it('reads the access fields of a record, ignoring its derived type', () => {
    const user = { email: 'a@x.org', accessVersion: 1, isAdmin: false, commsCadre: true, councilRole: 'CommunicationsManager', userType: 'Public', roles: [] };
    expect(accessOf(user)).toEqual({ isAdmin: false, commsCadre: true, councilRole: 'CommunicationsManager', council: true });
    expect(accessOf({ ...user, councilRole: 'Bogus' })).toMatchObject({ councilRole: null, council: false });
    expect(accessOf({ ...user, councilRole: null })).toMatchObject({ councilRole: null, council: false });
  });

  it('reads an older record\'s councilRoles list as its first known role, and drops it (and approved) on save', () => {
    const old = { email: 'a@x.org', approved: false, accessVersion: 1, isAdmin: false, commsCadre: false, councilRoles: ['Bogus', 'IntakeManager', 'CommunicationsManager'] };
    expect(accessOf(old)).toMatchObject({ councilRole: 'IntakeManager', council: true });
    expect(accessOf({ email: 'a@x.org', councilRoles: [] })).toMatchObject({ councilRole: null, council: false });
    const saved: any = withDerivedAccess(old);
    expect(saved).toMatchObject({ councilRole: 'IntakeManager', userType: 'CouncilManager' });
    expect('councilRoles' in saved).toBe(false);
    expect('approved' in saved).toBe(false);
  });

  it('falls back to the type and roles of a record from before the migration', () => {
    expect(accessOf({ email: 'a@x.org', userType: 'Admin', isAdmin: false, roles: [] })).toMatchObject({ isAdmin: true });
    expect(accessOf({ email: 'a@x.org', userType: 'Member', roles: ['CommsCadre'] })).toMatchObject({ commsCadre: true, council: false });
    expect(accessOf({ email: 'a@x.org', userType: 'CouncilManager', roles: [] })).toMatchObject({ council: true, councilRole: null });
    expect(accessOf(null)).toMatchObject({ isAdmin: false, commsCadre: false, council: false });
  });

  it('treats a verified bootstrap address as Admin, but not an unverified one', () => {
    const env = { BOOTSTRAP_ADMIN_EMAILS: ['Boss@X.org'] };
    const base = { email: 'boss@x.org', accessVersion: 1, isAdmin: false, commsCadre: false, councilRole: null };
    expect(accessOf({ ...base, verified: true }, env)).toMatchObject({ isAdmin: true });
    expect(accessOf({ ...base, verified: false }, env)).toMatchObject({ isAdmin: false });
  });

  it('derives the legacy type and roles', () => {
    const both = { isAdmin: false, commsCadre: true, councilRole: 'IntakeManager' as any, council: true };
    expect(derivedUserType(both)).toBe('CouncilManager');
    expect(derivedRoles(both)).toEqual(['CommsCadre', 'CouncilManager']);
    // No role: a Member (anyone signed in)
    expect(derivedUserType({ ...both, commsCadre: false, councilRole: null, council: false })).toBe('Member');
    expect(derivedRoles({ ...both, commsCadre: false, councilRole: null, council: false })).toEqual(['Member']);
    const saved = withDerivedAccess({ email: 'a@x.org', userType: 'Lead', roles: ['Public'] }, both);
    expect(saved).toMatchObject({ userType: 'CouncilManager', roles: ['CommsCadre', 'CouncilManager'], accessVersion: 1, commsCadre: true });
  });

  it('counts an approval for a gate by what the approver held then or holds now', () => {
    expect(approverCounts({ approverType: 'CommsCadre' })).toEqual({ council: false, commsCadre: true });
    expect(approverCounts({ approverType: 'Member', approverRoles: ['CommsCadre', 'CouncilManager'] })).toEqual({ council: true, commsCadre: true });
    expect(approverCounts({ approverType: 'Member' }, accessOf({ accessVersion: 1, councilRole: 'IntakeManager' }))).toEqual({ council: true, commsCadre: false });
  });

  it('gives reviewers the review permissions and others none', () => {
    expect(isReviewer({ accessVersion: 1, councilRole: 'IntakeManager' })).toBe(true);
    expect(isReviewer({ accessVersion: 1 })).toBe(false);
    expect(rolesResponse({ accessVersion: 1, commsCadre: true, councilRole: 'CommunicationsManager' })).toEqual({
      roles: ['CommsCadre', 'CouncilManager'],
      permissions: expect.objectContaining({ canApprove: true, canViewFilteredSubmissions: true }),
    });
    expect(rolesResponse({ accessVersion: 1 }).roles).toEqual([]);
  });
});
