import { describe, it, expect } from 'vitest';
import { ROLE_PERMISSIONS, roleHasPermission, getHighestRole } from '@nova/auth-types';

describe('Role permissions', () => {
 it('Owner has all permissions', () => {
 const allPerms = Object.values(ROLE_PERMISSIONS.owner);
 expect(allPerms.length).toBeGreaterThan(0);
 expect(roleHasPermission('owner', 'org:delete')).toBe(true);
 expect(roleHasPermission('owner', 'data:delete')).toBe(true);
 });

 it('Member has limited permissions', () => {
 expect(roleHasPermission('member', 'org:view')).toBe(true);
 expect(roleHasPermission('member', 'org:delete')).toBe(false);
 expect(roleHasPermission('member', 'data:delete')).toBe(false);
 });

 it('SupportLimited cannot access audit or data', () => {
 expect(roleHasPermission('support_limited', 'audit:view')).toBe(false);
 expect(roleHasPermission('support_limited', 'data:export')).toBe(false);
 expect(roleHasPermission('support_limited', 'org:view')).toBe(true);
 });

 it('Auditor cannot write data', () => {
 expect(roleHasPermission('auditor', 'org:update')).toBe(false);
 expect(roleHasPermission('auditor', 'data:delete')).toBe(false);
 expect(roleHasPermission('auditor', 'audit:view')).toBe(true);
 });
});

describe('getHighestRole', () => {
 it('returns the highest role in the list', () => {
 expect(getHighestRole(['member', 'owner'])).toBe('owner');
 expect(getHighestRole(['manager', 'member'])).toBe('manager');
 expect(getHighestRole(['member'])).toBe('member');
 });
});
