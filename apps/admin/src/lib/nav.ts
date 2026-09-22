/**
 * Admin console — navigation model.
 *
 * Navigation is driven by the same permission names the API enforces
 * (`services/api/src/admin/permissions.ts`). The console never decides *whether* an
 * operator may do something — the server does that and answers 403 — but hiding a
 * destination they cannot use keeps the console legible, and the shared vocabulary is
 * what stops the two lists drifting into disagreement.
 *
 * Groups follow the operator's mental model (Dashboard → Users → Assistant → AI & Voice
 * → Operations → Analytics → System → Security) rather than the API's route layout,
 * because an operator looking for "why did this reminder not fire" thinks in tasks, not
 * in HTTP paths.
 */

export type NavItem = {
	href: string;
	label: string;
	/** Short description used on the dashboard and in empty states. */
	description: string;
	/** Any one of these grants visibility. Empty means always visible. */
	permissions: string[];
	/** Shown as a badge when the destination needs a follow-up. */
	requiresAttention?: boolean;
};

export type NavGroup = {
	id: string;
	label: string;
	items: NavItem[];
};

export const NAV_GROUPS: NavGroup[] = [
	{
		id: 'dashboard',
		label: 'Dashboard',
		items: [
			{
				href: '/',
				label: 'Overview',
				description: 'Platform health, NOVA activity, AI usage and open incidents.',
				permissions: [],
			},
			{
				href: '/environment',
				label: 'Environment',
				description: 'Which deployment this console is talking to, and a loud warning when it is production.',
				permissions: ['config.read'],
			},
		],
	},
	{
		id: 'users',
		label: 'Users',
		items: [
			{
				href: '/users',
				label: 'Users',
				description: 'Search accounts, inspect NOVA state, suspend and revoke sessions.',
				permissions: ['users.read'],
			},
			{
				href: '/sessions',
				label: 'Sessions',
				description: 'Active and revoked sessions across all accounts.',
				permissions: ['users.read'],
			},
			{
				href: '/organizations',
				label: 'Organizations',
				description: 'Tenants, plans and membership counts.',
				permissions: ['users.read'],
			},
		],
	},
	{
		id: 'assistant',
		label: 'Assistant',
		items: [
			{
				href: '/conversations',
				label: 'Conversations',
				description: 'Session metadata, models and token usage. Content is separately permissioned.',
				permissions: ['conversations.read'],
			},
			{
				href: '/tasks',
				label: 'Tasks',
				description: 'Task state, priority, due dates and overdue work.',
				permissions: ['tasks.read'],
			},
			{
				href: '/reminders',
				label: 'Reminders',
				description: 'Upcoming, overdue and dismissed reminders with revision history.',
				permissions: ['reminders.read'],
			},
			{
				href: '/memory',
				label: 'Memory',
				description: 'What NOVA has stored about users, by type and importance.',
				permissions: ['memory.read'],
			},
			{
				href: '/proactive',
				label: 'Proactive AI',
				description: 'What NOVA initiated unprompted, and the honest limits of that record.',
				permissions: ['proactive.read'],
			},
		],
	},
	{
		id: 'ai-voice',
		label: 'AI & Voice',
		items: [
			{
				href: '/ai',
				label: 'AI Providers',
				description: 'Providers, models, routing, health and per-model cost.',
				permissions: ['ai.read'],
			},
			{
				href: '/ai/secrets',
				label: 'API Keys',
				description: 'Add, rotate, test and disable provider credentials. Values are never readable.',
				permissions: ['config.secrets', 'ai.secrets'],
			},
			{
				href: '/voice',
				label: 'Voice',
				description: 'STT, TTS, language, wake word availability and real provider tests.',
				permissions: ['voice.read'],
			},
			{
				href: '/avatar',
				label: 'Avatar',
				description: 'Avatar enablement and asset inventory.',
				permissions: ['avatar.read'],
			},
		],
	},
	{
		id: 'operations',
		label: 'Operations',
		items: [
			{
				href: '/jobs',
				label: 'Jobs & Queues',
				description: 'Background engines, executions, failures and scheduled work.',
				permissions: ['jobs.read'],
			},
			{
				href: '/notifications',
				label: 'Notifications',
				description: 'Notification volume by type, with the delivery record\'s limitations stated.',
				permissions: ['notifications.read'],
			},
			{
				href: '/realtime',
				label: 'Realtime',
				description: 'Live voice connections held by this process, and what is not countable.',
				permissions: ['realtime.read'],
			},
		],
	},
	{
		id: 'analytics',
		label: 'Analytics',
		items: [
			{
				href: '/analytics',
				label: 'Usage',
				description: 'Users, NOVA activity, assistant metrics and reliability.',
				permissions: ['analytics.read'],
			},
			{
				href: '/cost',
				label: 'AI Cost',
				description: 'Estimated token spend per model and per day, with unknown models flagged.',
				permissions: ['cost.read'],
			},
		],
	},
	{
		id: 'system',
		label: 'System',
		items: [
			{
				href: '/services',
				label: 'Services',
				description: 'Service reachability, dependencies, database size and migrations.',
				permissions: ['services.read'],
			},
			{
				href: '/configuration',
				label: 'Configuration',
				description: 'Runtime configuration, sources and what each change affects.',
				permissions: ['config.read'],
			},
			{
				href: '/configuration/validate',
				label: 'Config Validator',
				description: 'Configuration health including live provider connectivity tests.',
				permissions: ['config.read'],
			},
			{
				href: '/feature-flags',
				label: 'Feature Flags',
				description: 'Flags, rollout percentage and per-user overrides that reach the mobile app.',
				permissions: ['feature_flags.read'],
			},
			{
				href: '/maintenance',
				label: 'Maintenance & Safeguards',
				description: 'Maintenance mode and the emergency kill switches for AI, voice and jobs.',
				permissions: ['config.read'],
			},
			{
				href: '/incidents',
				label: 'Incidents',
				description: 'Recorded incidents and their resolution state.',
				permissions: ['services.read'],
			},
			{
				href: '/languages',
				label: 'Languages',
				description: 'Translation coverage records.',
				permissions: ['config.read'],
			},
			{
				href: '/deletion-requests',
				label: 'Deletion Requests',
				description: 'Account-erasure requests awaiting an owner decision.',
				permissions: ['users.read'],
			},
		],
	},
	{
		id: 'security',
		label: 'Security',
		items: [
			{
				href: '/security',
				label: 'Security Overview',
				description: 'Failed sign-ins, refused privileged actions, operator sessions, credential status and a watchlist.',
				permissions: ['security.read'],
			},
			{
				href: '/security/audit-log',
				label: 'Audit Log',
				description: 'Every privileged admin action, including refused attempts. Append-only at the database level.',
				permissions: ['audit.read'],
			},
			{
				href: '/logs',
				label: 'Logs & Traces',
				description: 'Correlation-id lookup across audit, job and tool records, with the gaps stated.',
				permissions: ['logs.read'],
			},
			{
				href: '/security/mfa',
				label: 'Two-Factor Auth',
				description: 'Your own account: enrol an authenticator app, manage recovery codes, or remove the factor.',
				permissions: [],
			},
			{
				href: '/security/sessions',
				label: 'Admin Sessions',
				description: 'Live console sessions, the client each token is used from, and immediate force-logout.',
				permissions: ['admin_users.read'],
			},
			{
				href: '/security/admins',
				label: 'Admins & Roles',
				description: 'Who has acted in the control plane, and with what role claim.',
				permissions: ['admin_users.read'],
			},
			{
				href: '/permissions',
				label: 'Permissions',
				description: 'The full permission catalog and which roles hold each one.',
				permissions: ['admin_users.read'],
			},
		],
	},
];

/** Human label for a permission, used where the catalog is rendered. */
export const PERMISSION_LABELS: Record<string, string> = {
	'users.read': 'Read users',
	'users.write': 'Edit users',
	'users.suspend': 'Suspend users',
	'users.delete': 'Delete users',
	'users.sessions_revoke': 'Revoke sessions',
	'users.impersonate': 'Impersonate',
	'conversations.read': 'Read conversation metadata',
	'conversations.content_read': 'Read conversation content',
	'tasks.read': 'Read tasks',
	'tasks.manage': 'Manage tasks',
	'reminders.read': 'Read reminders',
	'reminders.manage': 'Manage reminders',
	'memory.read': 'Read memory',
	'memory.manage': 'Manage memory',
	'proactive.read': 'Read proactive events',
	'proactive.manage': 'Manage proactive AI',
	'ai.read': 'Read AI config',
	'ai.configure': 'Configure AI',
	'ai.secrets': 'Manage AI keys',
	'voice.read': 'Read voice config',
	'voice.configure': 'Configure voice',
	'avatar.read': 'Read avatar config',
	'avatar.configure': 'Configure avatar',
	'jobs.read': 'Read jobs',
	'jobs.manage': 'Manage jobs',
	'notifications.read': 'Read notifications',
	'notifications.send': 'Send test notifications',
	'realtime.read': 'Read realtime state',
	'services.read': 'Read service health',
	'logs.read': 'Read logs',
	'traces.read': 'Read traces',
	'incidents.manage': 'Manage incidents',
	'config.read': 'Read configuration',
	'config.write': 'Write configuration',
	'config.secrets': 'Manage secrets',
	'feature_flags.read': 'Read feature flags',
	'feature_flags.write': 'Write feature flags',
	'environment.manage': 'Manage environments',
	'maintenance.manage': 'Manage maintenance mode',
	'kill_switch.manage': 'Operate kill switches',
	'analytics.read': 'Read analytics',
	'cost.read': 'Read cost',
	'security.read': 'Read security events',
	'admin_users.read': 'Read admins',
	'admin_users.manage': 'Manage admins',
	'audit.read': 'Read audit log',
	'audit.export': 'Export audit log',
};

/** Filter the navigation to what a permission set can use. */
export function visibleNavGroups(permissions: string[]): NavGroup[] {
	const granted = new Set(permissions);
	return NAV_GROUPS.map((group) => ({
		...group,
		items: group.items.filter(
			(item) => item.permissions.length === 0 || item.permissions.some((p) => granted.has(p)),
		),
	})).filter((group) => group.items.length > 0);
}

/** The group that owns a path, used to keep the sidebar section expanded. */
export function groupForPath(pathname: string): string | null {
	// Longest matching href wins so `/ai/secrets` resolves to its item in the AI group
	// rather than being shadowed by `/ai`.
	let bestHref = '';
	let bestGroup: string | null = null;
	for (const group of NAV_GROUPS) {
		for (const item of group.items) {
			if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
				if (item.href.length > bestHref.length) {
					bestHref = item.href;
					bestGroup = group.id;
				}
			}
		}
	}
	return bestGroup;
}
