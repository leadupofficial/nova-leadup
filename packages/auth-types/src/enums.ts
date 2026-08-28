// String literal types
export type Role = 'owner' | 'admin' | 'manager' | 'member' | 'auditor' | 'support_limited';
export type Permission =
 | 'org:delete' | 'org:update' | 'org:view' | 'org:billing'
 | 'workspace:create' | 'workspace:update' | 'workspace:delete' | 'workspace:view'
 | 'user:invite' | 'user:remove' | 'user:update_role' | 'user:view'
 | 'settings:update' | 'settings:view'
 | 'api_key:create' | 'api_key:revoke' | 'api_key:view'
 | 'audit:view' | 'data:export' | 'data:delete';
export type AuthProvider = 'email' | 'phone' | 'google' | 'apple';
export type SessionStatus = 'active' | 'revoked' | 'expired';
export type OtpChannel = 'sms' | 'whatsapp';
export type MfaMethod = 'totp' | 'sms' | 'backup_code';
export type ApiKeyScope = 'read' | 'write' | 'admin';

export const Roles = {
 Owner: 'owner', Admin: 'admin', Manager: 'manager', Member: 'member', Auditor: 'auditor', SupportLimited: 'support_limited',
} as const satisfies Record<string, Role>;

export const OtpChannels = {
 Sms: 'sms', WhatsApp: 'whatsapp',
} as const;

export const MfaMethods = {
 Totp: 'totp', Sms: 'sms', BackupCode: 'backup_code',
} as const;

export const AuthProviders = {
 Email: 'email', Phone: 'phone', Google: 'google', Apple: 'apple',
} as const;

export const ApiKeyScopes = {
 Read: 'read', Write: 'write', Admin: 'admin',
} as const;

export const Permissions = {
 OrgDelete: 'org:delete', OrgUpdate: 'org:update', OrgView: 'org:view', OrgBilling: 'org:billing',
 WorkspaceCreate: 'workspace:create', WorkspaceUpdate: 'workspace:update', WorkspaceDelete: 'workspace:delete', WorkspaceView: 'workspace:view',
 UserInvite: 'user:invite', UserRemove: 'user:remove', UserUpdateRole: 'user:update_role', UserView: 'user:view',
 SettingsUpdate: 'settings:update', SettingsView: 'settings:view',
 ApiKeyCreate: 'api_key:create', ApiKeyRevoke: 'api_key:revoke', ApiKeyView: 'api_key:view',
 AuditView: 'audit:view', DataExport: 'data:export', DataDelete: 'data:delete',
} as const;

export const ALL_ROLES = Object.values(Roles) as Role[];
export const ALL_PROVIDERS = Object.values(AuthProviders) as AuthProvider[];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
 owner: Object.values(Permissions) as Permission[],
 admin: [
 'org:view', 'org:update', 'org:billing',
 'workspace:create', 'workspace:update', 'workspace:delete', 'workspace:view',
 'user:invite', 'user:remove', 'user:update_role', 'user:view',
 'settings:update', 'settings:view',
 'api_key:create', 'api_key:revoke', 'api_key:view',
 'audit:view', 'data:export',
 ],
 manager: [
 'org:view', 'workspace:view', 'workspace:create', 'workspace:update',
 'user:invite', 'user:view', 'settings:view', 'api_key:view', 'data:export',
 ],
 member: ['org:view', 'workspace:view', 'user:view', 'settings:view'],
 auditor: ['org:view', 'workspace:view', 'user:view', 'audit:view'],
 support_limited: ['org:view', 'user:view'],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
 return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

export function getHighestRole(roles: Role[]): Role {
 const hierarchy: Role[] = ['owner', 'admin', 'manager', 'auditor', 'member', 'support_limited'];
 for (const role of hierarchy) {
 if (roles.includes(role)) return role;
 }
 return 'member';
}
