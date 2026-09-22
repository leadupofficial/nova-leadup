/**
 * NOVA — Admin permission catalog and role model.
 *
 * This is the **single source of truth** for what an admin may do. Both the API
 * (enforcement) and the console (which buttons to show) read it from here, so the
 * two can never drift into disagreeing about who may press what.
 *
 * Two hard rules this module encodes:
 *
 * 1. **The frontend is never the authority.** `hasPermission` is called on every
 *    privileged route via `requirePermission()`. Hiding a button is a UX nicety;
 *    the 403 is the control.
 *
 * 2. **Not every admin is a super-admin.** The platform previously gated every
 *    `/admin/*` route on `role IN ('owner','admin')`, which made `admin` a synonym
 *    for root: the same principal who may read an audit log could also rotate the
 *    Anthropic key and suspend any user. Roles below decompose that into
 *    capabilities, and the `admin` role deliberately keeps only read plus safe
 *    user support actions.
 *
 * Platform roles are stored in the JWT `role` claim (issued by `services/api`'s
 * auth routes). `owner` is the legacy super-user; it maps to SUPER_ADMIN and is
 * kept because existing tokens and the seeded owner account carry it.
 */

import { HttpError } from '../middleware/error-handler.js';

// ─── Permissions ─────────────────────────────────────────────────────────────

export const PERMISSIONS = [
	// Users
	'users.read',
	'users.write',
	'users.suspend',
	'users.delete',
	'users.sessions_revoke',
	'users.impersonate',

	// Assistant domain (conversations, tasks, reminders, memory, proactive)
	'conversations.read',
	'conversations.content_read',
	'tasks.read',
	'tasks.content_read',
	'tasks.manage',
	'reminders.read',
	'reminders.content_read',
	'reminders.manage',
	'memory.read',
	'memory.content_read',
	'memory.manage',
	'proactive.read',
	'proactive.manage',

	// AI & voice
	'ai.read',
	'ai.configure',
	'ai.secrets',
	'voice.read',
	'voice.configure',
	'avatar.read',
	'avatar.configure',

	// Operations
	'jobs.read',
	'jobs.manage',
	'notifications.read',
	'notifications.send',
	'realtime.read',
	'services.read',
	'logs.read',
	'traces.read',
	'incidents.manage',

	// Configuration
	'config.read',
	'config.write',
	'config.secrets',
	'feature_flags.read',
	'feature_flags.write',
	'environment.manage',
	'maintenance.manage',
	'kill_switch.manage',

	// Analytics & cost
	'analytics.read',
	'cost.read',

	// Security & administration
	'security.read',
	'admin_users.read',
	'admin_users.manage',
	'audit.read',
	'audit.export',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS);

export function isPermission(value: string): value is Permission {
	return PERMISSION_SET.has(value);
}

// ─── Roles ───────────────────────────────────────────────────────────────────

export const ADMIN_ROLES = [
	'SUPER_ADMIN',
	'PLATFORM_ADMIN',
	'SUPPORT_ADMIN',
	'OPERATIONS_ADMIN',
	'ANALYTICS_ADMIN',
	'DEVELOPER',
	'READ_ONLY',
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

/**
 * Every permission in the catalog. Written as an explicit spread of PERMISSIONS
 * rather than a wildcard string: a wildcard would mean a newly added permission
 * silently belongs to SUPER_ADMIN before anyone decides that it should, which is
 * exactly the accident least likely to be noticed.
 */
const ALL: readonly Permission[] = PERMISSIONS;

/**
 * Role → permission matrix.
 *
 * The shape of each role is deliberate:
 *
 * - `SUPER_ADMIN` — everything. The only role that may manage admin users or
 *   touch secrets.
 * - `PLATFORM_ADMIN` — run the platform: configure AI/voice, flags, maintenance
 *   and kill switches. Cannot read plaintext secret values (only rotate them via
 *   the audited path) and cannot grant roles.
 * - `SUPPORT_ADMIN` — help a human: read users and their assistant state, revoke
 *   sessions, suspend. No configuration, no AI keys, no conversation *content*.
 * - `OPERATIONS_ADMIN` — keep the machinery running: jobs, queues, services,
 *   incidents, notifications, realtime. Read-only on users.
 * - `ANALYTICS_ADMIN` — metrics and cost, no personal data.
 * - `DEVELOPER` — read everything for debugging including logs, traces and
 *   conversation content, but change nothing. Deliberately *not* able to write
 *   config: a debugger with production write access is how outages happen.
 * - `READ_ONLY` — the floor. Dashboard and aggregate counts only.
 */
export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
	SUPER_ADMIN: ALL,

	PLATFORM_ADMIN: [
		'users.read',
		'users.write',
		'users.suspend',
		'users.sessions_revoke',
		'conversations.read',
		'tasks.read',
		'tasks.manage',
		'reminders.read',
		'reminders.manage',
		'memory.read',
		'proactive.read',
		'ai.read',
		'ai.configure',
		'voice.read',
		'voice.configure',
		'avatar.read',
		'avatar.configure',
		'jobs.read',
		'jobs.manage',
		'notifications.read',
		'notifications.send',
		'realtime.read',
		'services.read',
		'logs.read',
		'traces.read',
		'incidents.manage',
		'config.read',
		'config.write',
		'feature_flags.read',
		'feature_flags.write',
		'maintenance.manage',
		'kill_switch.manage',
		'analytics.read',
		'cost.read',
		'security.read',
		'admin_users.read',
		'audit.read',
	],

	SUPPORT_ADMIN: [
		'users.read',
		'users.write',
		'users.suspend',
		'users.sessions_revoke',
		'conversations.read',
		'tasks.read',
		'tasks.manage',
		'reminders.read',
		'reminders.manage',
		'memory.read',
		'proactive.read',
		'notifications.read',
		'notifications.send',
		'realtime.read',
		'services.read',
		'ai.read',
		'voice.read',
		'analytics.read',
		'audit.read',
	],

	OPERATIONS_ADMIN: [
		'users.read',
		'conversations.read',
		'tasks.read',
		'reminders.read',
		'proactive.read',
		'jobs.read',
		'jobs.manage',
		'notifications.read',
		'notifications.send',
		'realtime.read',
		'services.read',
		'logs.read',
		'traces.read',
		'incidents.manage',
		'maintenance.manage',
		'kill_switch.manage',
		'ai.read',
		'voice.read',
		'config.read',
		'feature_flags.read',
		'analytics.read',
		'cost.read',
		'audit.read',
	],

	ANALYTICS_ADMIN: [
		'analytics.read',
		'cost.read',
		'users.read',
		'tasks.read',
		'reminders.read',
		'ai.read',
		'voice.read',
		'services.read',
		'config.read',
		'feature_flags.read',
	],

	DEVELOPER: [
		'users.read',
		'conversations.read',
		'conversations.content_read',
		'tasks.read',
		'tasks.content_read',
		'reminders.read',
		'reminders.content_read',
		'memory.read',
		'memory.content_read',
		'proactive.read',
		'ai.read',
		'voice.read',
		'avatar.read',
		'jobs.read',
		'notifications.read',
		'realtime.read',
		'services.read',
		'logs.read',
		'traces.read',
		'config.read',
		'feature_flags.read',
		'analytics.read',
		'cost.read',
		'security.read',
		'audit.read',
	],

	READ_ONLY: ['analytics.read', 'services.read', 'config.read', 'feature_flags.read'],
};

/**
 * Maps the platform role carried in the JWT to an admin role.
 *
 * `owner` and `admin` are the two values `services/api`'s auth routes actually
 * issue today. `owner` was always intended as the top role; `admin` is mapped to
 * PLATFORM_ADMIN rather than SUPER_ADMIN so the existing `admin` account keeps the
 * operational capabilities it had without silently retaining the ability to grant
 * itself more. Anything not listed gets no admin permissions at all — an unknown
 * role must fail closed.
 */
const PLATFORM_ROLE_MAP: Record<string, AdminRole> = {
	owner: 'SUPER_ADMIN',
	admin: 'PLATFORM_ADMIN',
	superadmin: 'SUPER_ADMIN',
	super_admin: 'SUPER_ADMIN',
	platform_admin: 'PLATFORM_ADMIN',
	support: 'SUPPORT_ADMIN',
	support_admin: 'SUPPORT_ADMIN',
	operations: 'OPERATIONS_ADMIN',
	operations_admin: 'OPERATIONS_ADMIN',
	analytics: 'ANALYTICS_ADMIN',
	analytics_admin: 'ANALYTICS_ADMIN',
	developer: 'DEVELOPER',
	read_only: 'READ_ONLY',
	readonly: 'READ_ONLY',
};

export function toAdminRole(platformRole: string | undefined | null): AdminRole | null {
	if (!platformRole) return null;
	return PLATFORM_ROLE_MAP[platformRole.toLowerCase()] ?? null;
}

/** Roles that may use the admin console at all. */
export function isAdminPlatformRole(platformRole: string | undefined | null): boolean {
	return toAdminRole(platformRole) !== null;
}

export function permissionsForRole(role: AdminRole): readonly Permission[] {
	return ROLE_PERMISSIONS[role];
}

/**
 * Does this principal hold the permission?
 *
 * `granted` is the per-request permission set resolved by the auth layer. It
 * defaults to the role's static set, but is passed explicitly so a future
 * database-backed grant (see `roles`/`role_bindings`) can narrow or widen it
 * without touching every call site.
 */
export function hasPermission(
	platformRole: string | undefined | null,
	permission: Permission,
	granted?: readonly string[],
): boolean {
	if (granted) return granted.includes(permission);
	const adminRole = toAdminRole(platformRole);
	if (!adminRole) return false;
	return ROLE_PERMISSIONS[adminRole].includes(permission);
}

/** Every permission a principal holds, for the console to render its navigation. */
export function effectivePermissions(platformRole: string | undefined | null): Permission[] {
	const adminRole = toAdminRole(platformRole);
	if (!adminRole) return [];
	return [...ROLE_PERMISSIONS[adminRole]];
}

/**
 * Throws 403 unless the principal holds `permission`.
 *
 * Fails closed on an unknown role: `toAdminRole` returns null and no permission
 * matches, so a token with a role this build does not know is denied rather than
 * treated as a member.
 */
export function assertPermission(
	platformRole: string | undefined | null,
	permission: Permission,
	granted?: readonly string[],
): void {
	if (!hasPermission(platformRole, permission, granted)) {
		throw new HttpError(
			403,
			`Forbidden — this action requires the "${permission}" permission`,
			'FORBIDDEN',
		);
	}
}

export type PermissionDescriptor = {
	permission: Permission;
	group: string;
	label: string;
	description: string;
	dangerous: boolean;
};

/**
 * Human-facing metadata for the permissions matrix screen.
 *
 * Kept beside the catalog so adding a permission without describing it is a
 * visible omission rather than a blank row nobody notices.
 */
export const PERMISSION_METADATA: readonly PermissionDescriptor[] = [
	{ permission: 'users.read', group: 'Users', label: 'Read users', description: 'List and view user accounts and their profile metadata.', dangerous: false },
	{ permission: 'users.write', group: 'Users', label: 'Edit users', description: 'Change a user\'s name, email verification state and locale.', dangerous: false },
	{ permission: 'users.suspend', group: 'Users', label: 'Suspend users', description: 'Disable or reactivate an account. The user is signed out of the app.', dangerous: true },
	{ permission: 'users.delete', group: 'Users', label: 'Delete users', description: 'Permanently erase an account and its owned data.', dangerous: true },
	{ permission: 'users.sessions_revoke', group: 'Users', label: 'Revoke sessions', description: 'Force-logout a user\'s devices by revoking their refresh sessions.', dangerous: true },
	{ permission: 'users.impersonate', group: 'Users', label: 'Impersonate', description: 'Act as a user for support. Reserved; not implemented.', dangerous: true },

	{ permission: 'conversations.read', group: 'Assistant', label: 'Read conversation metadata', description: 'List sessions with counts, mode, model and latency. No message text.', dangerous: false },
	{ permission: 'conversations.content_read', group: 'Assistant', label: 'Read conversation content', description: 'Read the actual user and NOVA message text. Personal data.', dangerous: true },
	{ permission: 'tasks.read', group: 'Assistant', label: 'Read tasks', description: 'View tasks with status, priority, due date and owner. No task text.', dangerous: false },
	{ permission: 'tasks.content_read', group: 'Assistant', label: 'Read task content', description: 'Read the title and description a user wrote on a task. Personal data.', dangerous: true },
	{ permission: 'tasks.manage', group: 'Assistant', label: 'Manage tasks', description: 'Change task status or priority, or cancel a task.', dangerous: false },
	{ permission: 'reminders.read', group: 'Assistant', label: 'Read reminders', description: 'View reminders with schedule, channel and execution history. No reminder text.', dangerous: false },
	{ permission: 'reminders.content_read', group: 'Assistant', label: 'Read reminder content', description: 'Read what a user asked to be reminded about. Personal data.', dangerous: true },
	{ permission: 'reminders.manage', group: 'Assistant', label: 'Manage reminders', description: 'Retry, reschedule, snooze or cancel a reminder.', dangerous: false },
	{ permission: 'memory.read', group: 'Assistant', label: 'Read memory metadata', description: 'View stored memory entries with category, importance and owner. No memory text.', dangerous: false },
	{ permission: 'memory.content_read', group: 'Assistant', label: 'Read memory content', description: 'Read what NOVA has stored about a person. Personal data.', dangerous: true },
	{ permission: 'memory.manage', group: 'Assistant', label: 'Manage memory', description: 'Delete specific memory entries on a user\'s behalf.', dangerous: true },
	{ permission: 'proactive.read', group: 'Assistant', label: 'Read proactive events', description: 'Inspect proactive assistant triggers, actions and outcomes.', dangerous: false },
	{ permission: 'proactive.manage', group: 'Assistant', label: 'Manage proactive AI', description: 'Enable or disable proactive behaviour per user.', dangerous: false },

	{ permission: 'ai.read', group: 'AI & Voice', label: 'Read AI config', description: 'View providers, models, routing and health.', dangerous: false },
	{ permission: 'ai.configure', group: 'AI & Voice', label: 'Configure AI', description: 'Change default/fallback models, timeouts, retries and routing.', dangerous: true },
	{ permission: 'ai.secrets', group: 'AI & Voice', label: 'Manage AI keys', description: 'Add, replace, test, rotate or disable AI provider credentials.', dangerous: true },
	{ permission: 'voice.read', group: 'AI & Voice', label: 'Read voice config', description: 'View STT/TTS providers, voices and health.', dangerous: false },
	{ permission: 'voice.configure', group: 'AI & Voice', label: 'Configure voice', description: 'Change STT/TTS provider, model, voice, speed and language.', dangerous: true },
	{ permission: 'avatar.read', group: 'AI & Voice', label: 'Read avatar config', description: 'View avatar assets, animation state and version.', dangerous: false },
	{ permission: 'avatar.configure', group: 'AI & Voice', label: 'Configure avatar', description: 'Change avatar enablement, asset and animation settings.', dangerous: false },

	{ permission: 'jobs.read', group: 'Operations', label: 'Read jobs', description: 'View queues, workers, executions, retries and failures.', dangerous: false },
	{ permission: 'jobs.manage', group: 'Operations', label: 'Manage jobs', description: 'Retry, cancel or replay a job execution.', dangerous: true },
	{ permission: 'notifications.read', group: 'Operations', label: 'Read notifications', description: 'View delivery, failures and click tracking.', dangerous: false },
	{ permission: 'notifications.send', group: 'Operations', label: 'Send test notifications', description: 'Send a test push, voice or deep-link notification to a user.', dangerous: true },
	{ permission: 'realtime.read', group: 'Operations', label: 'Read realtime state', description: 'View active websocket connections and their health.', dangerous: false },
	{ permission: 'services.read', group: 'Operations', label: 'Read service health', description: 'View service status, uptime and dependency health.', dangerous: false },
	{ permission: 'logs.read', group: 'Operations', label: 'Read logs', description: 'Search application, service and provider errors.', dangerous: false },
	{ permission: 'traces.read', group: 'Operations', label: 'Read traces', description: 'Follow a correlation id across services.', dangerous: false },
	{ permission: 'incidents.manage', group: 'Operations', label: 'Manage incidents', description: 'Create and resolve incident records.', dangerous: false },

	{ permission: 'config.read', group: 'Configuration', label: 'Read configuration', description: 'View runtime configuration keys and their sources.', dangerous: false },
	{ permission: 'config.write', group: 'Configuration', label: 'Write configuration', description: 'Change non-secret runtime configuration values.', dangerous: true },
	{ permission: 'config.secrets', group: 'Configuration', label: 'Manage secrets', description: 'Write, rotate and delete encrypted secrets. Values are never readable.', dangerous: true },
	{ permission: 'feature_flags.read', group: 'Configuration', label: 'Read feature flags', description: 'View global flags, overrides and rollout state.', dangerous: false },
	{ permission: 'feature_flags.write', group: 'Configuration', label: 'Write feature flags', description: 'Change flag state, rollout percentage and overrides.', dangerous: true },
	{ permission: 'environment.manage', group: 'Configuration', label: 'Manage environments', description: 'Change environment-scoped configuration.', dangerous: true },
	{ permission: 'maintenance.manage', group: 'Configuration', label: 'Manage maintenance mode', description: 'Put NOVA into maintenance and set the user-facing message.', dangerous: true },
	{ permission: 'kill_switch.manage', group: 'Configuration', label: 'Operate kill switches', description: 'Emergency disable of AI, voice, TTS, STT, background jobs and realtime.', dangerous: true },

	{ permission: 'analytics.read', group: 'Analytics', label: 'Read analytics', description: 'View usage, retention and reliability metrics.', dangerous: false },
	{ permission: 'cost.read', group: 'Analytics', label: 'Read cost', description: 'View estimated AI, voice and infrastructure spend.', dangerous: false },

	{ permission: 'security.read', group: 'Security', label: 'Read security events', description: 'View failed logins, suspicious activity and credential status.', dangerous: false },
	{ permission: 'admin_users.read', group: 'Security', label: 'Read admins', description: 'List admin accounts, roles and active sessions.', dangerous: false },
	{ permission: 'admin_users.manage', group: 'Security', label: 'Manage admins', description: 'Grant and revoke admin roles. Effectively grants all other permissions.', dangerous: true },
	{ permission: 'audit.read', group: 'Security', label: 'Read audit log', description: 'Search the admin action audit log.', dangerous: false },
	{ permission: 'audit.export', group: 'Security', label: 'Export audit log', description: 'Export audit records out of the platform.', dangerous: true },
];

/** Permissions metadata for a group, preserving catalog order. */
export function permissionsByGroup(): Map<string, PermissionDescriptor[]> {
	const groups = new Map<string, PermissionDescriptor[]>();
	for (const descriptor of PERMISSION_METADATA) {
		const existing = groups.get(descriptor.group);
		if (existing) existing.push(descriptor);
		else groups.set(descriptor.group, [descriptor]);
	}
	return groups;
}
