/**
 * NOVA — the Security Center's read model.
 *
 * §29 of the acceptance criteria asks for a security dashboard: failed admin logins, suspicious
 * activity, expired credentials, API key status, configuration changes, permission changes, active
 * and revoked admin sessions, and service authentication failures. The console had the pieces
 * scattered across four pages and no place that answers *"is somebody abusing the control plane
 * right now"*.
 *
 * ## What this can and cannot say, and why that is written down twice
 *
 * Every number here comes from a table that exists. Where a signal is genuinely absent — there is
 * no failed-*admin*-login concept separate from a failed login, because the console signs in through
 * the same `/auth/login` route as the mobile app — the field says so rather than being left out
 * silently, because a dashboard that omits a row reads as "nothing to report".
 *
 * ## Two sources, on purpose
 *
 *  - **`audit_logs`** holds sign-in attempts (`auth.login`, `auth.login_failed`). This is where
 *    failures live, and it is the only place: nothing recorded them before this round.
 *  - **`admin_audit_logs`** holds everything an operator did to the platform, including refusals.
 *
 * They are reported side by side and never merged, because "a stranger guessed at the login form"
 * and "an operator was refused a permission" are different events with different responses.
 */

import { getDbPool } from '../db/connection.js';
import { listConfigViews } from './config.js';
import { PROVIDER_CREDENTIAL_KEYS } from './config.js';

/** The window every count in this report covers. */
export const SECURITY_WINDOW_DAYS = 7;

/**
 * How many refusals from one actor in the window put them on the watchlist.
 *
 * Chosen low deliberately. A legitimate operator who is refused a permission usually is refused
 * once, learns, and stops; five refusals of the *same* permission is a person hitting a wall that
 * is not going to move. The list is a prompt to look, not an accusation — a support engineer
 * working outside their role during an incident can easily reach five, which is why the entry says
 * which permissions and when rather than labelling the actor.
 */
export const WATCHLIST_THRESHOLD = 5;

/** Row shape shared by the list queries here. */
type AuditRow = {
	id: string;
	action: string;
	outcome: string;
	actor_id: string | null;
	actor_email: string | null;
	actor_role: string | null;
	permission: string | null;
	target_type: string | null;
	target_id: string | null;
	reason: string | null;
	ip_address: string | null;
	user_agent: string | null;
	request_id: string | null;
	occurred_at: Date;
};

export type SecurityOverview = {
	window: { days: number; since: string };
	signIns: {
		succeeded: number;
		failed: number;
		byReason: Array<{ reason: string; count: number }>;
		topAttemptedEmails: Array<{ email: string | null; attempts: number }>;
		topSourceAddresses: Array<{ ip: string | null; attempts: number }>;
		recentFailures: Array<Record<string, unknown>>;
		/**
		 * True when no failed attempt has been recorded at all. Distinguished from "zero failures"
		 * because a brand-new instrumentation and a quiet week look identical in a count.
		 */
		instrumented: boolean;
	};
	refusals: {
		total: number;
		topActors: Array<{ actorEmail: string | null; role: string | null; refusals: number }>;
		topPermissions: Array<{ permission: string | null; refusals: number }>;
		topActions: Array<{ action: string; refusals: number }>;
		recent: Array<Record<string, unknown>>;
	};
	adminSessions: {
		active: number;
		revoked: number;
		expired: number;
		soonestExpiring: Array<Record<string, unknown>>;
	};
	privilegeChanges: Array<Record<string, unknown>>;
	configurationChanges: Array<Record<string, unknown>>;
	credentials: Array<{
		key: string;
		configured: boolean;
		source: string;
		lastTestStatus: string | null;
		lastTestedAt: string | null;
		testStale: boolean;
		testedBy: string[];
	}>;
	watchlist: Array<{
		actorEmail: string | null;
		role: string | null;
		refusals: number;
		distinctPermissions: number;
		firstSeen: string;
		lastSeen: string;
	}>;
	notes: string[];
};

function iso(value: Date | null | undefined): string | null {
	return value ? new Date(value).toISOString() : null;
}

/** `admin_audit_logs` rows, projected for the console. */
function toAuditRow(row: AuditRow) {
	return {
		id: row.id,
		action: row.action,
		outcome: row.outcome,
		actorEmail: row.actor_email,
		actorRole: row.actor_role,
		permission: row.permission,
		targetType: row.target_type,
		targetId: row.target_id,
		reason: row.reason,
		ipAddress: row.ip_address,
		userAgent: row.user_agent,
		requestId: row.request_id,
		occurredAt: iso(row.occurred_at),
	};
}

/**
 * Actions that changed how the platform behaves, as opposed to how an account is administered.
 *
 * Listed explicitly rather than matched with a prefix, so adding a new mutating route does not
 * silently appear in a security view whose copy describes something narrower.
 */
const CONFIGURATION_ACTIONS = [
	'config.update',
	'config.secret_write',
	'config.secret_delete',
	'config.provider_test',
	'control.update',
	'maintenance.update',
	'feature_flag.create',
	'feature_flag.update',
	'feature_flag.delete',
	'feature_flag.override_upsert',
	'feature_flag.override_delete',
];

/** Actions that changed who can administer the platform. */
const PRIVILEGE_ACTIONS = ['platform_role.grant', 'platform_role.revoke'];

/**
 * Assembles the whole report.
 *
 * Every query is bounded by the window and a `LIMIT`, and the failures of individual sections are
 * contained: a section that cannot be read reports zero rows rather than failing the page, because
 * the Security Center is something an operator opens *during* an incident and a single unreadable
 * table must not blank the rest.
 */
export async function getSecurityOverview(
	windowDays: number = SECURITY_WINDOW_DAYS,
): Promise<SecurityOverview> {
	const pool = getDbPool();
	const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

	const safe = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
		try {
			return await run();
		} catch {
			return fallback;
		}
	};

	const signIns = await safe(async () => {
		const totals = await pool.query<{ action: string; n: string }>(
			`SELECT action, count(*)::int AS n FROM audit_logs
			 WHERE action IN ('auth.login', 'auth.login_failed') AND occurred_at >= $1
			 GROUP BY action`,
			[since],
		);
		const byAction = new Map(totals.rows.map((row) => [row.action, Number(row.n)]));

		// `details` is jsonb, so the reason and the attempted address are read with `->>` rather
		// than joined from a column. That is a deliberate consequence of `audit_logs` having no
		// columns for them; the values are written by `services/auth-events.ts`.
		const reasons = await pool.query<{ reason: string; n: string }>(
			`SELECT coalesce(details->>'reason', 'unrecorded') AS reason, count(*)::int AS n
			 FROM audit_logs
			 WHERE action = 'auth.login_failed' AND occurred_at >= $1
			 GROUP BY 1 ORDER BY n DESC`,
			[since],
		);
		const emails = await pool.query<{ email: string | null; n: string }>(
			`SELECT details->>'attemptedEmail' AS email, count(*)::int AS n
			 FROM audit_logs
			 WHERE action = 'auth.login_failed' AND occurred_at >= $1
			 GROUP BY 1 ORDER BY n DESC LIMIT 10`,
			[since],
		);
		const addresses = await pool.query<{ ip: string | null; n: string }>(
			`SELECT details->>'clientIp' AS ip, count(*)::int AS n
			 FROM audit_logs
			 WHERE action = 'auth.login_failed' AND occurred_at >= $1
			 GROUP BY 1 ORDER BY n DESC LIMIT 10`,
			[since],
		);
		const recent = await pool.query<{
			action: string;
			outcome: string;
			occurred_at: Date;
			details: Record<string, unknown> | null;
			source_device: string | null;
			request_id: string | null;
		}>(
			`SELECT action, outcome, occurred_at, details, source_device, request_id
			 FROM audit_logs
			 WHERE action = 'auth.login_failed' AND occurred_at >= $1
			 ORDER BY occurred_at DESC LIMIT 25`,
			[since],
		);

		const succeeded = byAction.get('auth.login') ?? 0;
		const failed = byAction.get('auth.login_failed') ?? 0;

		return {
			succeeded,
			failed,
			byReason: reasons.rows.map((row) => ({ reason: row.reason, count: Number(row.n) })),
			topAttemptedEmails: emails.rows.map((row) => ({ email: row.email, attempts: Number(row.n) })),
			topSourceAddresses: addresses.rows.map((row) => ({ ip: row.ip, attempts: Number(row.n) })),
			recentFailures: recent.rows.map((row) => ({
				action: row.action,
				outcome: row.outcome,
				occurredAt: iso(row.occurred_at),
				attemptedEmail: (row.details ?? {}).attemptedEmail ?? null,
				reason: (row.details ?? {}).reason ?? null,
				clientIp: (row.details ?? {}).clientIp ?? null,
				userAgent: row.source_device,
				requestId: row.request_id,
			})),
			// `succeeded + failed === 0` means the instrumentation has no rows at all, which the
			// console must not render as "no failed logins this week".
			instrumented: succeeded + failed > 0,
		};
	}, {
		succeeded: 0,
		failed: 0,
		byReason: [],
		topAttemptedEmails: [],
		topSourceAddresses: [],
		recentFailures: [],
		instrumented: false,
	});

	const refusals = await safe(async () => {
		const [total] = (
			await pool.query<{ n: string }>(
				`SELECT count(*)::int AS n FROM admin_audit_logs WHERE outcome = 'denied' AND occurred_at >= $1`,
				[since],
			)
		).rows;

		const actors = await pool.query<{ actor_email: string | null; actor_role: string | null; n: string }>(
			`SELECT actor_email, actor_role, count(*)::int AS n FROM admin_audit_logs
			 WHERE outcome = 'denied' AND occurred_at >= $1
			 GROUP BY 1, 2 ORDER BY n DESC LIMIT 10`,
			[since],
		);
		const permissions = await pool.query<{ permission: string | null; n: string }>(
			`SELECT permission, count(*)::int AS n FROM admin_audit_logs
			 WHERE outcome = 'denied' AND occurred_at >= $1
			 GROUP BY 1 ORDER BY n DESC LIMIT 10`,
			[since],
		);
		const actions = await pool.query<{ action: string; n: string }>(
			`SELECT action, count(*)::int AS n FROM admin_audit_logs
			 WHERE outcome = 'denied' AND occurred_at >= $1
			 GROUP BY 1 ORDER BY n DESC LIMIT 10`,
			[since],
		);
		const recent = await pool.query<AuditRow>(
			`SELECT id, action, outcome, actor_id, actor_email, actor_role, permission, target_type,
			        target_id, reason, ip_address, user_agent, request_id, occurred_at
			 FROM admin_audit_logs
			 WHERE outcome = 'denied' AND occurred_at >= $1
			 ORDER BY occurred_at DESC LIMIT 25`,
			[since],
		);

		return {
			total: Number(total?.n ?? 0),
			topActors: actors.rows.map((row) => ({
				actorEmail: row.actor_email,
				role: row.actor_role,
				refusals: Number(row.n),
			})),
			topPermissions: permissions.rows.map((row) => ({
				permission: row.permission,
				refusals: Number(row.n),
			})),
			topActions: actions.rows.map((row) => ({ action: row.action, refusals: Number(row.n) })),
			recent: recent.rows.map(toAuditRow),
		};
	}, { total: 0, topActors: [], topPermissions: [], topActions: [], recent: [] });

	const adminSessions = await safe(async () => {
		const [tally] = (
			await pool.query<{ active: string; revoked: string; expired: string }>(
				`SELECT
					count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now())::int AS active,
					count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked,
					count(*) FILTER (WHERE revoked_at IS NULL AND expires_at <= now())::int AS expired
				 FROM admin_sessions`,
			)
		).rows;
		const soonest = await pool.query<{
			id: string;
			role: string;
			expires_at: Date;
			last_seen_at: Date;
			ip_address: string | null;
			email: string | null;
		}>(
			`SELECT s.id, s.role, s.expires_at, s.last_seen_at, s.ip_address, u.email
			 FROM admin_sessions s LEFT JOIN users u ON u.id = s.user_id
			 WHERE s.revoked_at IS NULL AND s.expires_at > now()
			 ORDER BY s.expires_at ASC LIMIT 10`,
		);

		return {
			active: Number(tally?.active ?? 0),
			revoked: Number(tally?.revoked ?? 0),
			expired: Number(tally?.expired ?? 0),
			soonestExpiring: soonest.rows.map((row) => ({
				id: row.id,
				role: row.role,
				email: row.email,
				ipAddress: row.ip_address,
				expiresAt: iso(row.expires_at),
				lastSeenAt: iso(row.last_seen_at),
			})),
		};
	}, { active: 0, revoked: 0, expired: 0, soonestExpiring: [] });

	const privilegeChanges = await safe(async () => {
		const { rows } = await pool.query<AuditRow>(
			`SELECT id, action, outcome, actor_id, actor_email, actor_role, permission, target_type,
			        target_id, reason, ip_address, user_agent, request_id, occurred_at
			 FROM admin_audit_logs
			 WHERE action = ANY($1) AND occurred_at >= $2
			 ORDER BY occurred_at DESC LIMIT 25`,
			[PRIVILEGE_ACTIONS, since],
		);
		return rows.map(toAuditRow);
	}, []);

	const configurationChanges = await safe(async () => {
		const { rows } = await pool.query<AuditRow>(
			`SELECT id, action, outcome, actor_id, actor_email, actor_role, permission, target_type,
			        target_id, reason, ip_address, user_agent, request_id, occurred_at
			 FROM admin_audit_logs
			 WHERE action = ANY($1) AND occurred_at >= $2
			 ORDER BY occurred_at DESC LIMIT 25`,
			[CONFIGURATION_ACTIONS, since],
		);
		return rows.map(toAuditRow);
	}, []);

	const credentials = await safe(async () => {
		const views = await listConfigViews();
		return views
			.filter((view) => view.scope === 'secret')
			.map((view) => ({
				key: view.key,
				configured: view.effectiveSource !== 'unset',
				source: view.effectiveSource,
				lastTestStatus: view.lastTestStatus,
				lastTestedAt: view.lastTestedAt,
				// Carried through so the Security Center cannot show a pass that describes a value
				// the operator has since replaced. Without it this page would contradict itself: the
				// untested-credential note is right there, while a stale pass renders as healthy.
				testStale: view.testStale,
				testedBy: view.testedBy,
			}));
	}, [] as SecurityOverview['credentials']);

	const watchlist = await safe(async () => {
		// `count(DISTINCT permission)` is what separates "kept trying the one thing they cannot do"
		// from "systematically probing the whole permission surface" — the second is the pattern
		// worth acting on, and a bare count hides it.
		const { rows } = await pool.query<{
			actor_email: string | null;
			actor_role: string | null;
			n: string;
			permissions: string;
			first_seen: Date;
			last_seen: Date;
		}>(
			`SELECT actor_email, actor_role, count(*)::int AS n,
			        count(DISTINCT permission)::int AS permissions,
			        min(occurred_at) AS first_seen, max(occurred_at) AS last_seen
			 FROM admin_audit_logs
			 WHERE outcome = 'denied' AND occurred_at >= $1
			 GROUP BY 1, 2
			 HAVING count(*) >= $2
			 ORDER BY n DESC LIMIT 10`,
			[since, WATCHLIST_THRESHOLD],
		);
		return rows.map((row) => ({
			actorEmail: row.actor_email,
			role: row.actor_role,
			refusals: Number(row.n),
			distinctPermissions: Number(row.permissions),
			firstSeen: iso(row.first_seen) ?? '',
			lastSeen: iso(row.last_seen) ?? '',
		}));
	}, [] as SecurityOverview['watchlist']);

	const credentialProviders = Object.values(PROVIDER_CREDENTIAL_KEYS).flat();
	// A stale result is counted here too. "Every configured credential has a recorded connectivity
	// test" is false when the recorded test was against a value that no longer exists — the note has
	// to agree with what the table beside it shows.
	const untestedKeys = credentials.filter(
		(entry) => entry.configured && (entry.lastTestStatus === null || entry.testStale),
	);

	return {
		window: { days: windowDays, since: since.toISOString() },
		signIns,
		refusals,
		adminSessions,
		privilegeChanges,
		configurationChanges,
		credentials,
		watchlist,
		notes: [
			'Sign-in attempts are recorded by `services/auth-events.ts`. Before that they were not recorded anywhere: `users.last_login_at` kept the most recent success with no client information, and a failed attempt left no trace. History before this instrumentation does not exist and is not reconstructed.',
			'A failed attempt names the address the caller typed. When it matches no account the row is `actorType = "anonymous"` with no account id, so it can never be joined to a user — "this address was tried" is a fact, "this account was attacked" is not.',
			'There is no separate "admin login": the console authenticates through the same `/auth/login` route as the mobile app, so these counts cover every NOVA account. The watchlist below separates operators by their role.',
			'Refusals are rows the platform itself wrote when a permission check denied an action. A refusal can be a legitimate action attempted from the wrong role — during an incident a support engineer routinely reaches for something they do not hold — which is why the watchlist names the permissions and times rather than labelling the account.',
			`The watchlist threshold is ${WATCHLIST_THRESHOLD} refusals in ${windowDays} days, deliberately low: a person who is refused the same permission five times is hitting a wall that will not move, and the cost of looking is one click.`,
			untestedKeys.length > 0
				? `${untestedKeys.length} configured credential(s) have no current connectivity test — either none was recorded or the value has changed since the last one — so their status is unknown rather than healthy: ${untestedKeys.map((entry) => entry.key).join(', ')}.`
				: 'Every configured credential has a recorded connectivity test.',
			'Suspicious-activity detection beyond refusals is not implemented: there is no anomaly scoring, no impossible-travel check and no device fingerprint. What is here is counts of things the platform recorded, with the thresholds written down.',
			`Credential tests cover ${new Set(credentialProviders).size} keys; a key no provider test covers stays "unknown" rather than being marked healthy.`,
		],
	};
}
