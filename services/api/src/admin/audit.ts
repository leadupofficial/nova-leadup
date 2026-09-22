/**
 * NOVA — Admin audit logging.
 *
 * Every privileged admin action writes exactly one row to `admin_audit_logs`,
 * including refusals. A denial is the more interesting record of the two: "who
 * tried to rotate the ElevenLabs key and was told no" is the security question,
 * and it is unanswerable if only successful calls are logged.
 *
 * Three properties are enforced here rather than promised:
 *
 * - **Append-only.** The migration installs a trigger that rejects UPDATE and
 *   DELETE on the table, so even a direct database session cannot rewrite
 *   history. Nothing in this module offers an update path.
 *
 * - **Secrets never land in the row.** `redact()` walks a snapshot and replaces
 *   the value of any secret-shaped key before it is serialised. This is applied
 *   centrally, inside `recordAdminAction`, so a caller cannot forget it.
 *
 * - **A logging failure never masks the operation.** If the insert throws, the
 *   error is logged and swallowed: losing an audit row is bad, but turning a
 *   successful suspension into a 500 *after the user was already disabled* is
 *   worse, because the operator then retries against unknown state.
 */

import type { Request } from 'express';
import { adminAuditLogs } from '@nova/database';
import { getDb } from '../db/connection.js';
import { logger } from '../utils/logger.js';
import { type Permission, effectivePermissions, toAdminRole } from './permissions.js';

// ─── Redaction ───────────────────────────────────────────────────────────────

/**
 * Key fragments that mark a value as secret.
 *
 * Matched case-insensitively as a substring of the key, so `api_key`,
 * `ANTHROPIC_API_KEY`, `secretCiphertext`, `refreshToken` and `passwordHash` are
 * all covered. Erring toward redacting too much is deliberate: an over-redacted
 * audit row is still a useful record, whereas a leaked key in a log is not
 * recoverable.
 */
const SECRET_KEY_PATTERNS = [
	'secret',
	'password',
	'passwd',
	'token',
	'api_key',
	'apikey',
	'auth_key',
	'private_key',
	'credential',
	'authorization',
	'cookie',
	'session_id',
	'ciphertext',
	'salt',
	'hash',
];

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;

export function isSecretKey(key: string): boolean {
	const lower = key.toLowerCase();
	return SECRET_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Deep-copy a value with secret-shaped values replaced.
 *
 * Bounded in both depth and array length so a pathological payload cannot turn an
 * audit write into an unbounded traversal.
 */
export function redact(value: unknown, depth = 0): unknown {
	if (depth > MAX_DEPTH) return '[TRUNCATED]';
	if (value === null || value === undefined) return value ?? null;

	if (Array.isArray(value)) {
		const limited = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redact(item, depth + 1));
		if (value.length > MAX_ARRAY_ITEMS) limited.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
		return limited;
	}

	if (typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
			out[key] = isSecretKey(key) && nested !== null && nested !== undefined ? REDACTED : redact(nested, depth + 1);
		}
		return out;
	}

	return value;
}

// ─── Actor context ───────────────────────────────────────────────────────────

export type AdminActor = {
	id: string;
	email: string;
	platformRole: string;
	adminRole: string | null;
	ipAddress: string | null;
	userAgent: string | null;
	requestId: string | null;
	jti?: string;
};

/** Shape `authenticate` attaches to the request. */
type RequestUser = { id: string; email: string; role: string; jti?: string };

/**
 * Extracts the acting principal from the request.
 *
 * `X-Forwarded-For` is only trusted for its first hop and only to *record*, never
 * to authorise. The value is operator-facing context ("this action came from a
 * new address"), not a security decision.
 */
export function actorFromRequest(req: Request): AdminActor | null {
	const user = (req as Request & { user?: RequestUser }).user;
	if (!user) return null;

	const forwarded = req.headers['x-forwarded-for'];
	const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
	const ipAddress = (forwardedValue ? forwardedValue.split(',')[0]?.trim() : null) || req.ip || null;

	const requestIdHeader = req.headers['x-request-id'];
	const requestId = (Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader) || null;

	return {
		id: user.id,
		email: user.email,
		platformRole: user.role,
		adminRole: toAdminRole(user.role),
		ipAddress,
		userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
		requestId: typeof requestId === 'string' ? requestId : null,
		jti: user.jti,
	};
}

// ─── Recording ───────────────────────────────────────────────────────────────

export type AuditOutcome = 'success' | 'failure' | 'denied';

export type AuditEntry = {
	actor: AdminActor | null;
	action: string;
	permission?: Permission | null;
	targetType?: string | null;
	targetId?: string | null;
	outcome: AuditOutcome;
	reason?: string | null;
	before?: unknown;
	after?: unknown;
	traceId?: string | null;
};

/**
 * Writes one audit row.
 *
 * Never throws. See the module comment for why.
 */
export async function recordAdminAction(entry: AuditEntry): Promise<void> {
	try {
		const db = getDb();
		await db.insert(adminAuditLogs).values({
			actorId: entry.actor?.id ?? null,
			actorEmail: entry.actor?.email ?? null,
			actorRole: entry.actor?.platformRole ?? null,
			action: entry.action,
			permission: entry.permission ?? null,
			targetType: entry.targetType ?? null,
			targetId: entry.targetId ?? null,
			outcome: entry.outcome,
			reason: entry.reason ?? null,
			before: redact(entry.before ?? {}) as Record<string, unknown>,
			after: redact(entry.after ?? {}) as Record<string, unknown>,
			requestId: entry.actor?.requestId ?? null,
			ipAddress: entry.actor?.ipAddress ?? null,
			userAgent: entry.actor?.userAgent ?? null,
			traceId: entry.traceId ?? entry.actor?.requestId ?? null,
		});
	} catch (error) {
		logger.error(
			{ err: error, action: entry.action, outcome: entry.outcome, actorId: entry.actor?.id },
			'[admin-audit] failed to record admin action',
		);
	}
}

/**
 * Updates the last-seen timestamp on an admin's console session.
 *
 * Fire-and-forget: a failed heartbeat must not fail the request it rides on.
 */
export async function touchAdminSession(actor: AdminActor): Promise<void> {
	if (!actor.jti || !actor.adminRole) return;
	try {
		const { adminSessions } = await import('@nova/database');
		const { eq } = await import('drizzle-orm');
		const db = getDb();
		await db
			.update(adminSessions)
			.set({ lastSeenAt: new Date(), ipAddress: actor.ipAddress, userAgent: actor.userAgent })
			.where(eq(adminSessions.jti, actor.jti));
	} catch (error) {
		logger.debug?.({ err: error }, '[admin-audit] session heartbeat failed');
	}
}

// ─── Route-level helpers ─────────────────────────────────────────────────────

/**
 * Convenience wrapper for the common "do a thing, record what changed" shape.
 *
 * The `describe` callback receives the value the operation returned and produces
 * the before/after snapshots, so redaction and insert happen in one place.
 */
export async function auditedOperation<T>(options: {
	req: Request;
	action: string;
	permission?: Permission | null;
	targetType?: string | null;
	targetId?: string | null;
	reason?: string | null;
	before?: unknown;
	/** Runs the mutation. Its return value is available to `after`. */
	run: () => Promise<T>;
	/** Snapshot for the `after` column. Defaults to the operation's result. */
	after?: (result: T) => unknown;
}): Promise<T> {
	const actor = actorFromRequest(options.req);
	try {
		const result = await options.run();
		await recordAdminAction({
			actor,
			action: options.action,
			permission: options.permission ?? null,
			targetType: options.targetType ?? null,
			targetId: options.targetId ?? null,
			outcome: 'success',
			reason: options.reason ?? null,
			before: options.before,
			after: options.after ? options.after(result) : result,
		});
		void (actor ? touchAdminSession(actor) : Promise.resolve());
		return result;
	} catch (error) {
		await recordAdminAction({
			actor,
			action: options.action,
			permission: options.permission ?? null,
			targetType: options.targetType ?? null,
			targetId: options.targetId ?? null,
			outcome: 'failure',
			reason: options.reason ?? null,
			before: options.before,
			after: { error: error instanceof Error ? error.message : String(error) },
		});
		throw error;
	}
}

/** The permission set the actor holds, for the console's navigation payload. */
export function actorPermissions(actor: AdminActor | null): Permission[] {
	if (!actor) return [];
	return effectivePermissions(actor.platformRole);
}
