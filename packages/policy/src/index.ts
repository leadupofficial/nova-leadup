/**
 * @nova/policy — Permission levels, policy engine, confirmation requirements,
 * tenant isolation, and RBAC for NOVA tool calls.
 *
 * Per blueprint Section 10.1 (Permission Levels) and Section 15.1 (RBAC).
 *
 * Permission levels:
 * L0 — Read-only (search memory, view tasks, fetch calendar)
 * L1 — Personal low-risk write (create personal task/reminder)
 * L2 — External communication (send email/WhatsApp, shared CRM note)
 * L3 — Sensitive/consequential (delete cloud data, change settings)
 * L4 — Financial/high risk (payment, transfer) — out of scope for MVP
 *
 * Exports:
 * - PERMISSION_LABELS, PERMISSION_DESCRIPTIONS
 * - ROLE_PERMISSIONS: default permission maps per role
 * - PolicyEngine: evaluates tool calls against policies
 * - ConfirmationChecker: determines if confirmation is required
 * - TenantIsolationEnforcer: validates tenant boundaries
 * - RBACChecker: role-based access validation
 * - RateLimiter, TIER_CONFIGS, CATEGORY_LIMITS (from rate-limiter.ts)
 */

import type {
	PermissionLevel,
	PermissionPolicy,
	ApprovalContext,
	PolicyDecision,
} from '@nova/shared-types';
import { RateLimiter, type RateLimitResult } from './rate-limiter';

// ─── Permission Level Constants ───────────────────────────────────────────────

export const PERMISSION_LABELS: Record<PermissionLevel, string> = {
	0: 'Read-only',
	1: 'Personal low-risk write',
	2: 'External communication',
	3: 'Sensitive/consequential',
	4: 'Financial/high risk',
};

export const PERMISSION_DESCRIPTIONS: Record<PermissionLevel, string> = {
	0: 'Read operations. No side effects. May run without confirmation.',
	1: 'Personal writes. Configurable; confirm during beta per blueprint.',
	2: 'External communication. Always show full payload + confirm.',
	3: 'Sensitive/consequential. Explicit confirm + re-auth.',
	4: 'Financial/high risk. Out of scope for MVP.',
};

/**
 * Check if a permission level requires confirmation.
 * Per blueprint Section 10.1:
 * L0: may run without confirmation
 * L1: configurable (we default to requiring confirmation in beta)
 * L2+: always require confirmation
 */
export function requiresConfirmation(level: PermissionLevel, betaMode = true): boolean {
	if (level === 0) return false;
	if (level === 1 && !betaMode) return false;
	return true;
}

// ─── RBAC ────────────────────────────────────────────────────────────────────

/**
 * Default role → permission mapping per blueprint Section 15.1.
 *
 * Roles:
 * owner — full access within tenant
 * admin — manage users, settings, integrations
 * manager — manage team resources
 * member — standard user
 * auditor — read-only access to audit logs
 * support-limited — restricted support access
 */
export type Role = 'owner' | 'admin' | 'manager' | 'member' | 'auditor' | 'support-limited';

export const ROLE_HIERARCHY: Record<Role, number> = {
	owner: 6,
	admin: 5,
	manager: 4,
	member: 3,
	auditor: 2,
	'support-limited': 1,
};

export const ROLE_PERMISSIONS: Record<Role, { maxLevel: PermissionLevel; allowedTools: string[] }> = {
	owner: {
		maxLevel: 4,
		allowedTools: ['*'],
	},
	admin: {
		maxLevel: 3,
		allowedTools: [
			'create_task', 'set_reminder', 'search_memory', 'update_memory',
			'send_email', 'send_whatsapp', 'manage_integrations', 'manage_users',
			'view_audit_logs', 'delete_data',
		],
	},
	manager: {
		maxLevel: 2,
		allowedTools: [
			'create_task', 'set_reminder', 'search_memory', 'update_memory',
			'send_email', 'send_whatsapp',
		],
	},
	member: {
		maxLevel: 1,
		allowedTools: [
			'create_task', 'set_reminder', 'search_memory',
		],
	},
	auditor: {
		maxLevel: 0,
		allowedTools: ['search_memory', 'view_audit_logs'],
	},
	'support-limited': {
		maxLevel: 0,
		allowedTools: [],
	},
};

// ─── RBACChecker ─────────────────────────────────────────────────────────────

export interface RBACContext {
	readonly userId: string;
	readonly tenantId: string | null;
	readonly role: Role;
	readonly organizationId?: string;
}

export class RBACChecker {
	/**
	 * Check if a user can call a tool at the given permission level.
	 */
	canCall(context: RBACContext, toolPermissionLevel: PermissionLevel): boolean {
		const rolePerms = ROLE_PERMISSIONS[context.role];
		if (!rolePerms) return false;
		return toolPermissionLevel <= rolePerms.maxLevel;
	}

	/**
	 * Check if a tool is in the user's allowed tool list.
	 */
	isToolAllowed(context: RBACContext, toolId: string): boolean {
		const rolePerms = ROLE_PERMISSIONS[context.role];
		if (!rolePerms) return false;
		if (rolePerms.allowedTools.includes('*')) return true;
		return rolePerms.allowedTools.includes(toolId);
	}

	/**
	 * Get the maximum permission level for a role.
	 */
	getMaxLevel(role: Role): PermissionLevel {
		return ROLE_PERMISSIONS[role]?.maxLevel ?? 0;
	}

	/**
	 * Get all tools a role can use.
	 */
	getAllowedTools(role: Role): readonly string[] {
		return ROLE_PERMISSIONS[role]?.allowedTools ?? [];
	}
}

// ─── TenantIsolationEnforcer ──────────────────────────────────────────────────

export interface TenantContext {
	readonly userId: string;
	readonly tenantId: string;
	readonly requestedTenantId?: string;
}

export class TenantIsolationEnforcer {
	/**
	 * Validate that the user belongs to the requested tenant.
	 *
	 * Per blueprint Section 15.1: "never trust a client-supplied user_id/organization_id".
	 * The tenantId is resolved from the verified session, never from client input.
	 */
	validate(context: TenantContext): { valid: boolean; tenantId: string; error?: string } {
		// If no requested tenant, use the session tenant
		const effectiveTenant = context.requestedTenantId ?? context.tenantId;

		if (!effectiveTenant) {
			return {
				valid: false,
				tenantId: context.tenantId,
				error: 'No tenant context available',
			};
		}

		if (context.requestedTenantId && context.requestedTenantId !== context.tenantId) {
			return {
				valid: false,
				tenantId: context.tenantId,
				error: `Tenant mismatch: user belongs to ${context.tenantId}, requested ${context.requestedTenantId}`,
			};
		}

		return { valid: true, tenantId: effectiveTenant };
	}

	/**
	 * Validate that a resource belongs to the user's tenant.
	 */
	validateResourceOwnership(
		userId: string,
		tenantId: string,
		resourceTenantId: string | null,
	): boolean {
		// Null tenant means personal (no org)
		if (resourceTenantId === null) return true;
		return resourceTenantId === tenantId;
	}

	/**
	 * Build a tenant-scoped query filter.
	 */
	buildTenantFilter(tenantId: string) {
		return { tenantId };
	}
}

// ─── ConfirmationChecker ──────────────────────────────────────────────────────

export interface ConfirmationCheckResult {
	readonly requiresConfirmation: boolean;
	readonly reason?: string;
	readonly expirySeconds: number;
}

export class ConfirmationChecker {
	private readonly defaultExpirySeconds = 300; // 5 minutes per blueprint

	/**
	 * Determine if a tool call requires user confirmation.
	 *
	 * Rules per blueprint Section 10.1:
	 * - L0: no confirmation
	 * - L1: configurable (beta = confirm)
	 * - L2+: always confirm
	 */
	check(
		permissionLevel: PermissionLevel,
		toolId: string,
		userId: string,
	): ConfirmationCheckResult {
		const needsConfirm = requiresConfirmation(permissionLevel, true);

		if (!needsConfirm) {
			return {
				requiresConfirmation: false,
				expirySeconds: this.defaultExpirySeconds,
			};
		}

		const reason = `Tool "${toolId}" is a L${permissionLevel} operation and requires explicit confirmation.`;

		return {
			requiresConfirmation: true,
			reason,
			expirySeconds: this.defaultExpirySeconds,
		};
	}

	/**
	 * Check if a confirmation token is still valid.
	 */
	isConfirmationValid(decidedAt: string, expiresAt: string): boolean {
		const decided = new Date(decidedAt).getTime();
		const expires = new Date(expiresAt).getTime();
		return decided <= expires && Date.now() <= expires;
	}
}

// ─── PolicyEngine ─────────────────────────────────────────────────────────────

export interface PolicyEngineOptions {
	readonly rbac?: RBACChecker;
	readonly tenantEnforcer?: TenantIsolationEnforcer;
	readonly confirmationChecker?: ConfirmationChecker;
	readonly rateLimiter?: RateLimiter | null;
	readonly betaMode?: boolean;
}

export interface ToolPolicyInput {
	readonly toolId: string;
	readonly toolInput: Record<string, unknown>;
	readonly permissionLevel: PermissionLevel;
	readonly userId: string;
	readonly tenantId?: string;
	readonly role: Role;
	readonly requestId: string;
	readonly sessionId?: string;
}

/**
 * Central policy engine that evaluates whether a tool call is allowed.
 *
 * Evaluation order:
 * 1. Rate limit check
 * 2. Tenant isolation check
 * 3. RBAC permission check
 * 4. Confirmation requirement check
 */
export class PolicyEngine {
	private readonly rbac: RBACChecker;
	private readonly tenantEnforcer: TenantIsolationEnforcer;
	private readonly confirmationChecker: ConfirmationChecker;
	private readonly rateLimiter: RateLimiter | null;
	private readonly betaMode: boolean;

	constructor(options: PolicyEngineOptions = {}) {
		this.rbac = options.rbac ?? new RBACChecker();
		this.tenantEnforcer = options.tenantEnforcer ?? new TenantIsolationEnforcer();
		this.confirmationChecker = options.confirmationChecker ?? new ConfirmationChecker();
		this.rateLimiter = options.rateLimiter ?? null;
		this.betaMode = options.betaMode ?? true;
	}

	/**
	 * Evaluate a tool call against all policies.
	 */
	evaluate(input: ToolPolicyInput): PolicyDecision {
		// Step 1: Rate limit
		if (this.rateLimiter) {
			const rateResult = this.rateLimiter.check(
				RateLimiter.buildKey([input.userId, input.tenantId ?? 'personal', 'tool']),
				'tool',
				'free', // tier resolution is caller's responsibility
			);
			if (!rateResult.allowed) {
				return {
					allowed: false,
					reason: `Rate limit exceeded: ${rateResult.label}. Retry after ${new Date(rateResult.resetAt).toISOString()}`,
				};
			}
		}

		// Step 2: Tenant isolation
		if (input.tenantId) {
			const tenantResult = this.tenantEnforcer.validate({
				userId: input.userId,
				tenantId: input.tenantId,
			});
			if (!tenantResult.valid) {
				return { allowed: false, reason: tenantResult.error ?? 'Tenant validation failed' };
			}
		}

		// Step 3: RBAC
		const rbacContext = {
			userId: input.userId,
			tenantId: input.tenantId ?? null,
			role: input.role,
		};

		if (!this.rbac.isToolAllowed(rbacContext, input.toolId)) {
			return {
				allowed: false,
				reason: `Tool "${input.toolId}" is not permitted for role "${input.role}"`,
			};
		}

		if (!this.rbac.canCall(rbacContext, input.permissionLevel)) {
			return {
				allowed: false,
				reason: `Permission level L${input.permissionLevel} exceeds maximum L${this.rbac.getMaxLevel(input.role)} for role "${input.role}"`,
			};
		}

		// Step 4: Confirmation requirement
		const confirmation = this.confirmationChecker.check(
			input.permissionLevel,
			input.toolId,
			input.userId,
		);

		if (confirmation.requiresConfirmation) {
			return {
				allowed: true,
				requiresConfirmation: true,
			};
		}

		return { allowed: true, requiresConfirmation: false };
	}

	/**
	 * Build an approval context from a policy decision.
	 */
	buildApprovalContext(input: ToolPolicyInput): ApprovalContext {
		return {
			toolId: input.toolId,
			toolInput: input.toolInput,
			permissionLevel: input.permissionLevel,
			userId: input.userId,
			tenantId: input.tenantId ?? null,
			requestId: input.requestId,
		};
	}
}

// ─── Policy Module Facade ─────────────────────────────────────────────────────

export interface PolicyModule {
	readonly engine: PolicyEngine;
	readonly rbac: RBACChecker;
	readonly tenantIsolation: TenantIsolationEnforcer;
	readonly confirmation: ConfirmationChecker;
	evaluate(input: ToolPolicyInput): PolicyDecision;
}

export class DefaultPolicyModule implements PolicyModule {
	readonly engine: PolicyEngine;
	readonly rbac: RBACChecker;
	readonly tenantIsolation: TenantIsolationEnforcer;
	readonly confirmation: ConfirmationChecker;

	constructor(options: PolicyEngineOptions = {}) {
		this.rbac = options.rbac ?? new RBACChecker();
		this.tenantIsolation = options.tenantEnforcer ?? new TenantIsolationEnforcer();
		this.confirmation = options.confirmationChecker ?? new ConfirmationChecker();
		this.engine = new PolicyEngine({
			rbac: this.rbac,
			tenantEnforcer: this.tenantIsolation,
			confirmationChecker: this.confirmation,
			rateLimiter: options.rateLimiter ?? null,
			betaMode: options.betaMode,
		});
	}

	evaluate(input: ToolPolicyInput): PolicyDecision {
		return this.engine.evaluate(input);
	}
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let defaultPolicyModule: DefaultPolicyModule | null = null;

export function getPolicyModule(): PolicyModule {
	if (!defaultPolicyModule) {
		defaultPolicyModule = new DefaultPolicyModule();
	}
	return defaultPolicyModule;
}

export function setPolicyModule(module: PolicyModule): void {
	defaultPolicyModule = module as DefaultPolicyModule;
}
