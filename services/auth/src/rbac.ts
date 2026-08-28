import { ROLE_PERMISSIONS } from '@nova/auth-types';

export interface AuthContext {
 userId: string;
 orgId: string;
 workspaceId: string;
 role: string;
 permissions: string[];
}

export function hasPermission(role: string, permission: string): boolean {
 return (ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS] ?? []).includes(permission as any);
}

export function checkRbac(ctx: AuthContext, permission: string, message?: string): void {
 if (!ctx.permissions.includes(permission)) {
 const err = new Error(message ?? `Forbidden — requires ${permission}`);
 err.name = 'ForbiddenError';
 (err as any).statusCode = 403;
 throw err;
 }
}

export function enforceOrgMatch(ctx: AuthContext, resourceOrgId: string): void {
 if (ctx.orgId !== resourceOrgId) {
 const err = new Error('Cross-tenant access denied');
 err.name = 'ForbiddenError';
 (err as any).statusCode = 403;
 throw err;
 }
}

export function getHighestRole(roles: string[]): string {
 const hierarchy: string[] = ['owner', 'admin', 'manager', 'auditor', 'member', 'support_limited'];
 for (const role of hierarchy) {
 if (roles.includes(role)) return role;
 }
 return 'member';
}
