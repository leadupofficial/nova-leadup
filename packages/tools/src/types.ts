/**
 * @nova/tools — Core type definitions for the tool system.
 *
 * Defines the canonical types for tool registration, execution context,
 * and results. All tool definitions in @nova/tools and @nova/ai-core
 * conform to these interfaces.
 */

// ─── Tool Definition ────────────────────────────────────────────────────────────

/**
 * Severity level for side-effects a tool may cause.
 *
 * Level 0: Read-only (no side effects)
 * Level 1: Local state mutation
 * Level 2: External communication / write
 * Level 3: Destructive action (delete, revoke)
 * Level 4: Financial / legal action
 */
export type PermissionLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Definition of a callable tool, conforming to the NOVA tool contract.
 *
 * Per blueprint Section 10: every tool declares its permission level,
 * whether confirmation is required, and an input schema for validation.
 */
export interface NovaToolDefinition {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly version: string;
	readonly permissionLevel: PermissionLevel;
	readonly confirmationRequired: boolean;
	readonly idempotencyRequired: boolean;
	readonly inputSchema: {
		readonly type: 'object';
		readonly properties?: Record<string, unknown>;
		readonly required?: readonly string[];
	};
	readonly outputSchema?: {
		readonly type: 'object';
		readonly properties?: Record<string, unknown>;
	};
	execute: (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResult>;
}

/**
 * Context provided to every tool execution.
 *
 * Carries identity, tenancy, request correlation, and policy information.
 */
export interface ToolExecutionContext {
	readonly userId: string;
	readonly tenantId: string | null;
	readonly requestId: string;
	readonly userRole: string;
	readonly permissionLevel: PermissionLevel;
	readonly approvalToken?: string;
}

/**
 * Standardized result from tool execution.
 */
export interface ToolResult {
	readonly success: boolean;
	readonly data?: unknown;
	readonly error?: string;
	readonly errorCode?: string;
}

// ─── Tool Registration ──────────────────────────────────────────────────────────

export interface ToolRegistration {
	readonly tool: NovaToolDefinition;
	readonly registeredAt: number;
	readonly tags?: readonly string[];
}

// ─── Tool Execution Request ─────────────────────────────────────────────────────

export interface ToolExecutionRequest {
	readonly toolId: string;
	readonly toolName: string;
	readonly input: Record<string, unknown>;
	readonly context: ToolExecutionContext;
	readonly approvalRequired?: boolean;
}

export interface ToolExecutionResult {
	readonly requestId: string;
	readonly toolId: string;
	readonly toolName: string;
	readonly success: boolean;
	readonly data?: unknown;
	readonly error?: string;
	readonly errorCode?: string;
	readonly durationMs: number;
	readonly executedAt: string;
}

// ─── Approval Flow ─────────────────────────────────────────────────────────────

export interface ApprovalRequest {
	readonly id: string;
	readonly toolId: string;
	readonly toolName: string;
	readonly toolInput: Record<string, unknown>;
	readonly context: ToolExecutionContext;
	readonly reason: string;
	readonly expiresAt: string;
	readonly status: 'pending' | 'approved' | 'denied' | 'expired';
}

export interface ApprovalDecision {
	readonly approvalId: string;
	readonly approved: boolean;
	readonly decidedBy: string;
	readonly decidedAt: string;
	readonly note?: string;
}

// ─── Registry Types ─────────────────────────────────────────────────────────────

export type ToolFilterCriteria = {
	readonly permissionLevel?: PermissionLevel;
	readonly tags?: readonly string[];
	readonly searchQuery?: string;
};

export type RegistryStats = {
	readonly totalTools: number;
	readonly byPermissionLevel: Record<PermissionLevel, number>;
	readonly byTag: Record<string, number>;
};

// ─── Permission Constants ───────────────────────────────────────────────────────

export const PERMISSION_LABELS: Record<PermissionLevel, string> = {
	0: 'read',
	1: 'write',
	2: 'external',
	3: 'destructive',
	4: 'financial',
};

export const PERMISSION_DESCRIPTIONS: Record<PermissionLevel, string> = {
	0: 'Read-only — no side effects',
	1: 'Local state mutation',
	2: 'External communication or write',
	3: 'Destructive action (delete, revoke)',
	4: 'Financial or legal action',
};

export const ROLE_PERMISSIONS: Record<string, PermissionLevel> = {
	user: 1,
	admin: 3,
	superadmin: 4,
};

export function requiresConfirmation(level: PermissionLevel): boolean {
	return level >= 2;
}
