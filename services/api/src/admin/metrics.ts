/**
 * NOVA — Admin analytics queries.
 *
 * Every number the console shows comes from one of these functions, and every
 * function is written against the columns that actually exist (verified against the
 * loaded database, not assumed):
 *
 *   - `conversation_messages.token_usage` is `{"inputTokens": n, "outputTokens": n}`
 *   - `conversation_messages.model` holds the model id per assistant message
 *   - `usage_records.metric` currently holds `recording_seconds` and `voice_seconds`
 *   - `reminders.dismissed` is the cancel flag; `reminders.triggered_at` records the first
 *     time a user *acknowledged* a reminder, written by `POST /reminders/:id/acknowledge`
 *     (migration 0010 journals it). It is not a delivery record — the OS fires the alarm
 *     with the app closed — and the metric says so in its caveat.
 *   - `devices` is empty because the mobile client never registers a device
 *
 * Two consequences are baked into the return types rather than hidden:
 *
 * 1. **A metric that cannot be computed is reported as unavailable**, with the
 *    reason and what would make it computable — never as a zero that reads as
 *    "nothing happened".
 *
 * 2. **A metric whose signal is not trustworthy is flagged**, via `caveat`. The
 *    clearest example is DAU/WAU/MAU: they are derived from `sessions.created_at`,
 *    and this environment's sessions were bulk-created during seeding, so all three
 *    return nearly the same number. Presenting that as engagement would be a lie
 *    the UI could not recover from.
 */

import { getDbPool } from '../db/connection.js';
import { AI_PRICING, estimateCost } from './pricing.js';

export type MetricAvailability = {
	value: number | null;
	/** Null when the metric is straightforward; a sentence when it needs context. */
	caveat: string | null;
	/** Why it is unavailable, when `value` is null. */
	unavailableReason: string | null;
	/** What would make it available. */
	instrumentationNeeded: string | null;
};

function available(value: number, caveat: string | null = null): MetricAvailability {
	return { value, caveat, unavailableReason: null, instrumentationNeeded: null };
}

function unavailable(reason: string, instrumentation: string): MetricAvailability {
	return { value: null, caveat: null, unavailableReason: reason, instrumentationNeeded: instrumentation };
}

// ─── Platform ────────────────────────────────────────────────────────────────

export type PlatformMetrics = {
	totalUsers: number;
	disabledUsers: number;
	verifiedUsers: number;
	newUsersToday: number;
	newUsersThisWeek: number;
	newUsersThisMonth: number;
	totalOrganizations: number;
	activeSessions: number;
	distinctSessionUsers: number;
	devices: MetricAvailability;
	dau: MetricAvailability;
	wau: MetricAvailability;
	mau: MetricAvailability;
	platforms: Array<{ platform: string; count: number }>;
	/** App builds in the field, from device registration. */
	appVersions: Array<{ version: string; count: number }>;
	/** OS versions in the field, from device registration. */
	platformVersions: Array<{ version: string; count: number }>;
	deviceModels: Array<{ model: string; count: number }>;
	locales: Array<{ locale: string; count: number }>;
	timezones: Array<{ timezone: string; count: number }>;
};

export async function getPlatformMetrics(): Promise<PlatformMetrics> {
	const pool = getDbPool();

	const [users] = (
		await pool.query<{
			total: string;
			disabled: string;
			verified: string;
			today: string;
			week: string;
			month: string;
		}>(`
		SELECT
			count(*)::int AS total,
			count(*) FILTER (WHERE disabled)::int AS disabled,
			count(*) FILTER (WHERE email_verified)::int AS verified,
			count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS today,
			count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week,
			count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS month
		FROM users`)
	).rows;

	const [orgs] = (await pool.query<{ total: string }>(`SELECT count(*)::int AS total FROM organizations`)).rows;

	const [sessions] = (
		await pool.query<{ active: string; users: string }>(`
		SELECT
			count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now())::int AS active,
			count(DISTINCT user_id) FILTER (WHERE revoked_at IS NULL AND expires_at > now())::int AS users
		FROM sessions`)
	).rows;

	const [deviceRow] = (await pool.query<{ total: string }>(`SELECT count(*)::int AS total FROM devices`)).rows;
	const deviceCount = Number(deviceRow?.total ?? 0);

	const platforms = (
		await pool.query<{ platform: string | null; count: string }>(`
		SELECT platform, count(*)::int AS count FROM devices GROUP BY 1 ORDER BY count DESC LIMIT 20`)
	).rows.map((r) => ({ platform: r.platform ?? 'unknown', count: Number(r.count) }));

	// App and OS version adoption. These were impossible before device registration existed —
	// the client reported neither, so `devices` was empty by construction.
	const appVersions = (
		await pool.query<{ version: string | null; count: string }>(`
		SELECT app_version AS version, count(*)::int AS count FROM devices
		GROUP BY 1 ORDER BY count DESC LIMIT 20`)
	).rows.map((r) => ({ version: r.version ?? 'not reported', count: Number(r.count) }));

	const platformVersions = (
		await pool.query<{ version: string | null; count: string }>(`
		SELECT platform_version AS version, count(*)::int AS count FROM devices
		GROUP BY 1 ORDER BY count DESC LIMIT 20`)
	).rows.map((r) => ({ version: r.version ?? 'not reported', count: Number(r.count) }));

	const deviceModels = (
		await pool.query<{ model: string | null; count: string }>(`
		SELECT model, count(*)::int AS count FROM devices GROUP BY 1 ORDER BY count DESC LIMIT 20`)
	).rows.map((r) => ({ model: r.model ?? 'not reported', count: Number(r.count) }));

	const locales = (
		await pool.query<{ locale: string | null; count: string }>(`
		SELECT locale, count(*)::int AS count FROM users GROUP BY 1 ORDER BY count DESC LIMIT 20`)
	).rows.map((r) => ({ locale: r.locale ?? 'unset', count: Number(r.count) }));

	const timezones = (
		await pool.query<{ timezone: string | null; count: string }>(`
		SELECT timezone, count(*)::int AS count FROM users GROUP BY 1 ORDER BY count DESC LIMIT 20`)
	).rows.map((r) => ({ timezone: r.timezone ?? 'unset', count: Number(r.count) }));

	// Activity from sessions. See the module comment: the caveat is computed, not
	// hard-coded, so a healthy environment stops showing it automatically.
	const [activity] = (
		await pool.query<{ dau: string; wau: string; mau: string; all_time: string; last_week: string }>(`
		SELECT
			count(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '1 day')::int AS dau,
			count(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '7 days')::int AS wau,
			count(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '30 days')::int AS mau,
			count(DISTINCT user_id)::int AS all_time,
			count(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '8 days'
				AND created_at <= now() - interval '1 day')::int AS last_week
		FROM sessions`)
	).rows;

	const totalUsers = Number(users?.total ?? 0);
	const dau = Number(activity?.dau ?? 0);
	const wau = Number(activity?.wau ?? 0);
	const mau = Number(activity?.mau ?? 0);
	const allTime = Number(activity?.all_time ?? 0);

	// A session row is only created when a user signs in, so a user who stays signed
	// in for a month contributes one row in the current month and nothing afterwards.
	// When the 30-day count equals the all-time count *and* the 1-day count is a large
	// share of it, the data is a sign-in burst rather than daily engagement.
	const looksLikeBurst = allTime > 0 && mau === allTime && dau >= Math.max(5, Math.floor(allTime * 0.5));
	const activityCaveat = looksLikeBurst
		? 'Session rows are created on sign-in, not per active day, so these counts reflect sign-ins in the window rather than distinct daily active users. Treat them as an upper bound.'
		: null;

	return {
		totalUsers,
		disabledUsers: Number(users?.disabled ?? 0),
		verifiedUsers: Number(users?.verified ?? 0),
		newUsersToday: Number(users?.today ?? 0),
		newUsersThisWeek: Number(users?.week ?? 0),
		newUsersThisMonth: Number(users?.month ?? 0),
		totalOrganizations: Number(orgs?.total ?? 0),
		activeSessions: Number(sessions?.active ?? 0),
		distinctSessionUsers: Number(sessions?.users ?? 0),
		devices:
			deviceCount === 0
				? unavailable(
						'No device has registered yet. The endpoint that writes this table exists (POST /api/v1/device/register) and the client calls it after sign-in; an empty table means no client has reported since it was added.',
						'Nothing further is needed server-side — the first signed-in launch populates it.',
					)
				: available(deviceCount),
		dau: available(dau, activityCaveat),
		wau: available(wau, activityCaveat),
		mau: available(mau, activityCaveat),
		platforms,
		appVersions,
		platformVersions,
		deviceModels,
		locales,
		timezones,
	};
}

// ─── NOVA activity ───────────────────────────────────────────────────────────

/**
 * Stated wherever a voice count is shown.
 *
 * **Both paths are metered now**, so this no longer warns about a gap — it names what the units
 * mean, which is the thing an operator will otherwise misread. A voice turn that contained six
 * sentences is **one** TTS request, because the client made one call; the character count is what
 * distinguishes a long reply from a short one. Without saying so, a low request count on a busy
 * deployment looks like a broken meter.
 *
 * The previous version of this constant warned that the realtime path was unmetered. That was true
 * when written and stopped being true when `realtime/session.ts` began metering its turns, so the
 * warning was replaced rather than left to mislead.
 */
const REALTIME_METERING_CAVEAT =
	'Voice requests are counted per call, not per sentence: one turn is one STT request and one TTS request however many sentences it spoke. Characters and seconds give the volume.';

export type ActivityMetrics = {
	conversationsToday: number;
	conversationsThisWeek: number;
	conversationsTotal: number;
	voiceConversations: number;
	textConversations: number;
	messagesTotal: number;
	userMessagesTotal: number;
	assistantMessagesTotal: number;
	aiRequests: number;
	aiInputTokens: number;
	aiOutputTokens: number;
	aiTotalTokens: number;
	aiLatency: MetricAvailability;
	sttRequests: MetricAvailability;
	ttsRequests: MetricAvailability;
	voiceSeconds: number;
	recordingSeconds: number;
	/** Seconds of audio transcribed, from the usage meter. */
	sttSeconds: number;
	/** Characters synthesized, which is the unit TTS providers bill for. */
	ttsCharacters: number;
	tasksTotal: number;
	tasksCreatedToday: number;
	tasksCompleted: number;
	tasksPending: number;
	tasksOverdue: number;
	remindersTotal: number;
	remindersUpcoming: number;
	remindersOverdue: number;
	remindersDismissed: number;
	remindersTriggered: MetricAvailability;
	notificationsTotal: number;
	notificationsUnread: number;
	memoriesTotal: number;
	toolExecutionsTotal: number;
};

export async function getActivityMetrics(): Promise<ActivityMetrics> {
	const pool = getDbPool();

	const [conversations] = (
		await pool.query<{
			total: string;
			today: string;
			week: string;
			voice: string;
			text: string;
		}>(`
		SELECT
			count(*)::int AS total,
			count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS today,
			count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week,
			count(*) FILTER (WHERE mode = 'voice')::int AS voice,
			count(*) FILTER (WHERE mode IS DISTINCT FROM 'voice')::int AS text
		FROM conversations`)
	).rows;

	const [messages] = (
		await pool.query<{
			total: string;
			user_msgs: string;
			assistant_msgs: string;
			input_tokens: string;
			output_tokens: string;
		}>(`
		SELECT
			count(*)::int AS total,
			count(*) FILTER (WHERE role = 'user')::int AS user_msgs,
			count(*) FILTER (WHERE role = 'assistant')::int AS assistant_msgs,
			COALESCE(SUM((token_usage->>'inputTokens')::bigint), 0)::bigint AS input_tokens,
			COALESCE(SUM((token_usage->>'outputTokens')::bigint), 0)::bigint AS output_tokens
		FROM conversation_messages`)
	).rows;

	const [tasks] = (
		await pool.query<{
			total: string;
			today: string;
			completed: string;
			pending: string;
			overdue: string;
		}>(`
		SELECT
			count(*)::int AS total,
			count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS today,
			count(*) FILTER (WHERE status = 'completed' OR completed_at IS NOT NULL)::int AS completed,
			count(*) FILTER (WHERE status <> 'completed' AND completed_at IS NULL)::int AS pending,
			count(*) FILTER (WHERE status <> 'completed' AND completed_at IS NULL AND due_at IS NOT NULL AND due_at < now())::int AS overdue
		FROM tasks`)
	).rows;

	const [reminders] = (
		await pool.query<{
			total: string;
			upcoming: string;
			overdue: string;
			dismissed: string;
			triggered: string;
		}>(`
		SELECT
			count(*)::int AS total,
			count(*) FILTER (WHERE NOT dismissed AND trigger_at > now())::int AS upcoming,
			count(*) FILTER (WHERE NOT dismissed AND trigger_at <= now())::int AS overdue,
			count(*) FILTER (WHERE dismissed)::int AS dismissed,
			count(*) FILTER (WHERE triggered_at IS NOT NULL)::int AS triggered
		FROM reminders`)
	).rows;

	const [notifications] = (
		await pool.query<{ total: string; unread: string }>(`
		SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT read)::int AS unread FROM notifications`)
	).rows;

	const [memories] = (await pool.query<{ total: string }>(`SELECT count(*)::int AS total FROM memories`)).rows;
	const [tools] = (await pool.query<{ total: string }>(`SELECT count(*)::int AS total FROM tool_executions`)).rows;
	const [usage] = (
		await pool.query<{
			voice_seconds: string;
			recording_seconds: string;
			stt_requests: string;
			stt_seconds: string;
			tts_requests: string;
			tts_characters: string;
		}>(`
		SELECT
			COALESCE(SUM(value) FILTER (WHERE metric = 'voice_seconds'), 0)::bigint AS voice_seconds,
			COALESCE(SUM(value) FILTER (WHERE metric = 'recording_seconds'), 0)::bigint AS recording_seconds,
			COALESCE(SUM(value) FILTER (WHERE metric = 'stt_requests'), 0)::bigint AS stt_requests,
			COALESCE(SUM(value) FILTER (WHERE metric = 'stt_seconds'), 0)::bigint AS stt_seconds,
			COALESCE(SUM(value) FILTER (WHERE metric = 'tts_requests'), 0)::bigint AS tts_requests,
			COALESCE(SUM(value) FILTER (WHERE metric = 'tts_characters'), 0)::bigint AS tts_characters
		FROM usage_records`)
	).rows;

	const sttRequests = Number(usage?.stt_requests ?? 0);
	const ttsRequests = Number(usage?.tts_requests ?? 0);

/**
 * What "reminders triggered" measures, stated because the obvious reading of the label is
 * the wrong one.
 *
 * The column is written by `POST /reminders/:id/acknowledge`, which the app calls when the
 * user **opens** the reminder's notification. The OS arms the alarm and fires it with the
 * app closed, so the instant of firing is not observable server-side — a tap is. So this
 * counts reminders the user acknowledged, not reminders the platform delivered, and a
 * reminder the user ignored is correctly absent from it.
 *
 * A recurring reminder contributes once, because `triggered_at` is set only on the first
 * acknowledgement and nothing server-side advances `trigger_at` for a repeat — the client
 * re-arms each occurrence from the rule. That under-counts repeat firings, which is why the
 * caveat is unconditional rather than shown only when the numbers look odd.
 */
const REMINDER_TRIGGERED_CAVEAT =
	'Counts reminders the user acknowledged by opening the notification, not reminders the server delivered: the OS fires the alarm with the app closed, so the firing itself is not visible here. A recurring reminder counts once, because the server records only the first acknowledgement and the client re-arms later occurrences from the repeat rule.';

const triggered = Number(reminders?.triggered ?? 0);
const remindersTriggered = triggered;

	return {
		conversationsToday: Number(conversations?.today ?? 0),
		conversationsThisWeek: Number(conversations?.week ?? 0),
		conversationsTotal: Number(conversations?.total ?? 0),
		voiceConversations: Number(conversations?.voice ?? 0),
		textConversations: Number(conversations?.text ?? 0),
		messagesTotal: Number(messages?.total ?? 0),
		userMessagesTotal: Number(messages?.user_msgs ?? 0),
		assistantMessagesTotal: Number(messages?.assistant_msgs ?? 0),
		aiRequests: Number(messages?.assistant_msgs ?? 0),
		aiInputTokens: Number(messages?.input_tokens ?? 0),
		aiOutputTokens: Number(messages?.output_tokens ?? 0),
		aiTotalTokens: Number(messages?.input_tokens ?? 0) + Number(messages?.output_tokens ?? 0),
		// Latency is recorded on the assistant message by the chat and conversations routes;
		// `getAiMetrics` computes the figure and the sample caveat, so it is reused here rather
		// than derived a second way.
		aiLatency: await (async () => {
			const metrics = await getAiMetrics(30);
			return metrics.latency;
		})(),
		// Metered by `services/voice-usage.ts` on the STT and TTS routes. A zero here means no
		// speech has been processed since the meter was added, which is a real zero rather than a
		// missing signal — the distinction that matters. The caveat names the one path not yet
		// covered, so a low count cannot be misread as complete coverage.
		sttRequests:
			sttRequests === 0
				? available(0, 'No speech has been transcribed since the meter was added (REST and realtime are both counted).')
				: available(sttRequests, REALTIME_METERING_CAVEAT),
		ttsRequests:
			ttsRequests === 0
				? available(0, 'No speech has been synthesized since the meter was added (REST and realtime are both counted).')
				: available(ttsRequests, REALTIME_METERING_CAVEAT),
		voiceSeconds: Number(usage?.voice_seconds ?? 0),
		recordingSeconds: Number(usage?.recording_seconds ?? 0),
		sttSeconds: Number(usage?.stt_seconds ?? 0),
		ttsCharacters: Number(usage?.tts_characters ?? 0),
		tasksTotal: Number(tasks?.total ?? 0),
		tasksCreatedToday: Number(tasks?.today ?? 0),
		tasksCompleted: Number(tasks?.completed ?? 0),
		tasksPending: Number(tasks?.pending ?? 0),
		tasksOverdue: Number(tasks?.overdue ?? 0),
		remindersTotal: Number(reminders?.total ?? 0),
		remindersUpcoming: Number(reminders?.upcoming ?? 0),
		remindersOverdue: Number(reminders?.overdue ?? 0),
		remindersDismissed: Number(reminders?.dismissed ?? 0),
		remindersTriggered: available(remindersTriggered, REMINDER_TRIGGERED_CAVEAT),
		notificationsTotal: Number(notifications?.total ?? 0),
		notificationsUnread: Number(notifications?.unread ?? 0),
		memoriesTotal: Number(memories?.total ?? 0),
		toolExecutionsTotal: Number(tools?.total ?? 0),
	};
}

// ─── AI usage and cost ───────────────────────────────────────────────────────

export type ModelUsage = {
	model: string;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	estimatedCostUsd: number;
	pricingKnown: boolean;
	/** Mean wall-clock model-call duration, when any row recorded one. */
	avgLatencyMs: number | null;
	/** How many of this model's requests have a recorded duration. */
	latencySamples: number;
};

export type AiMetrics = {
	requestsToday: number;
	requestsThisWeek: number;
	requestsThisMonth: number;
	totalRequests: number;
	totalTokens: number;
	estimatedCostUsd: number;
	byModel: ModelUsage[];
	byDay: Array<{ day: string; requests: number; tokens: number; estimatedCostUsd: number }>;
	/** Requests with no model recorded — usually a failed or interrupted call. */
	unattributedRequests: number;
	/** Mean model-call duration across requests that recorded one. */
	latency: MetricAvailability;
	/** p95 model-call duration, which is what a user notices rather than the mean. */
	latencyP95Ms: number | null;
};

export async function getAiMetrics(days = 30): Promise<AiMetrics> {
	const pool = getDbPool();

	const [totals] = (
		await pool.query<{
			today: string;
			week: string;
			month: string;
			total: string;
			tokens: string;
			unattributed: string;
		}>(
			`
		SELECT
			count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS today,
			count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week,
			count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS month,
			count(*)::int AS total,
			COALESCE(SUM(COALESCE((token_usage->>'inputTokens')::bigint, 0)
				+ COALESCE((token_usage->>'outputTokens')::bigint, 0)), 0)::bigint AS tokens,
			count(*) FILTER (WHERE model IS NULL AND token_usage IS NOT NULL)::int AS unattributed
		FROM conversation_messages
		WHERE role = 'assistant'`,
		)
	).rows;

	const modelRows = (
		await pool.query<{
			model: string | null;
			requests: string;
			input_tokens: string;
			output_tokens: string;
			avg_latency_ms: string | null;
			latency_samples: string;
		}>(`
		SELECT
			model,
			count(*)::int AS requests,
			COALESCE(SUM(COALESCE((token_usage->>'inputTokens')::bigint, 0)), 0)::bigint AS input_tokens,
			COALESCE(SUM(COALESCE((token_usage->>'outputTokens')::bigint, 0)), 0)::bigint AS output_tokens,
			AVG(duration_ms)::float AS avg_latency_ms,
			count(duration_ms)::int AS latency_samples
		FROM conversation_messages
		WHERE role = 'assistant'
		GROUP BY model
		ORDER BY requests DESC`)
	).rows;

	const byModel: ModelUsage[] = modelRows.map((row) => {
		const model = row.model ?? '(not recorded)';
		const inputTokens = Number(row.input_tokens);
		const outputTokens = Number(row.output_tokens);
		const cost = estimateCost(model, inputTokens, outputTokens);
		return {
			model,
			requests: Number(row.requests),
			inputTokens,
			outputTokens,
			totalTokens: inputTokens + outputTokens,
			estimatedCostUsd: cost.costUsd,
			pricingKnown: cost.pricingKnown,
			avgLatencyMs: row.avg_latency_ms === null ? null : Math.round(Number(row.avg_latency_ms)),
			latencySamples: Number(row.latency_samples ?? 0),
		};
	});

	// Day series. `generate_series` so days with no activity appear as zero rather
	// than being absent — a gap in a chart otherwise reads as missing data.
	const dayRows = (
		await pool.query<{ day: string; requests: string; tokens: string }>(
			`
		SELECT
			to_char(d.day, 'YYYY-MM-DD') AS day,
			COALESCE(count(m.id), 0)::int AS requests,
			COALESCE(SUM(COALESCE((m.token_usage->>'inputTokens')::bigint, 0)
				+ COALESCE((m.token_usage->>'outputTokens')::bigint, 0)), 0)::bigint AS tokens
		FROM generate_series(
			date_trunc('day', now()) - ($1::int - 1) * interval '1 day',
			date_trunc('day', now()),
			interval '1 day'
		) AS d(day)
		LEFT JOIN conversation_messages m
			ON m.role = 'assistant'
			AND date_trunc('day', m.created_at) = d.day
		GROUP BY d.day
		ORDER BY d.day`,
			[days],
		)
	).rows;

	const byDay = dayRows.map((row) => {
		const tokens = Number(row.tokens);
		// Day-level cost uses the blended default rate: the per-model split is not
		// available per day without a second aggregation, and the headline number is
		// an estimate either way. The per-model table above carries the precise split.
		const cost = estimateCost(null, tokens, 0);
		return { day: row.day, requests: Number(row.requests), tokens, estimatedCostUsd: cost.costUsd };
	});

	// Latency. `percentile_cont` is PostgreSQL's interpolating percentile, which is what a
	// p95 should be for a continuous measure like milliseconds.
	const [latencyRow] = (
		await pool.query<{
			samples: string;
			requests: string;
			avg_ms: string | null;
			p95_ms: string | null;
		}>(`
		SELECT
			count(duration_ms)::int AS samples,
			count(*)::int AS requests,
			AVG(duration_ms)::float AS avg_ms,
			percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::float AS p95_ms
		FROM conversation_messages
		WHERE role = 'assistant'`)
	).rows;

	const latencySamples = Number(latencyRow?.samples ?? 0);
	const latencyTotal = Number(latencyRow?.requests ?? 0);

	// Coverage matters: an average over 3 of 500 requests is not "AI latency", it is a
	// curiosity. The caveat says so rather than letting a thin sample read as a full picture.
	const latency =
		latencySamples === 0
			? unavailable(
					'No model call has recorded a duration yet. The column and the instrumentation exist; history written before they were added has no timing.',
					'Nothing further — the next assistant reply records `conversation_messages.duration_ms`.',
				)
			: available(Math.round(Number(latencyRow?.avg_ms ?? 0)), latencySamples < latencyTotal
					? `Measured on ${latencySamples} of ${latencyTotal} assistant replies; the rest predate the instrumentation.`
					: null);

	return {
		requestsToday: Number(totals?.today ?? 0),
		requestsThisWeek: Number(totals?.week ?? 0),
		requestsThisMonth: Number(totals?.month ?? 0),
		totalRequests: Number(totals?.total ?? 0),
		totalTokens: Number(totals?.tokens ?? 0),
		estimatedCostUsd: byModel.reduce((sum, m) => sum + m.estimatedCostUsd, 0),
		byModel,
		byDay,
		unattributedRequests: Number(totals?.unattributed ?? 0),
		latency,
		latencyP95Ms: latencyRow?.p95_ms === null || latencyRow?.p95_ms === undefined ? null : Math.round(Number(latencyRow.p95_ms)),
	};
}

// ─── Reliability ─────────────────────────────────────────────────────────────

export type ReliabilityMetrics = {
	incidentsTotal: number;
	incidentsOpen: number;
	incidentsBySeverity: Array<{ severity: string; count: number }>;
	toolExecutionsTotal: number;
	toolFailures: number;
	toolFailureRate: number | null;
	jobExecutionsTotal: number;
	jobFailures: number;
	jobFailureRate: number | null;
	deadLetterCount: number;
	auditActionsToday: number;
	auditDenialsToday: number;
	adminActionsToday: number;
};

export async function getReliabilityMetrics(): Promise<ReliabilityMetrics> {
	const pool = getDbPool();

	const [incidents] = (
		await pool.query<{ total: string; open: string }>(
			`SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT resolved)::int AS open FROM incident_events`,
		)
	).rows;

	const incidentsBySeverity = (
		await pool.query<{ severity: string; count: string }>(
			`SELECT severity, count(*)::int AS count FROM incident_events GROUP BY 1 ORDER BY count DESC`,
		)
	).rows.map((r) => ({ severity: r.severity, count: Number(r.count) }));

	const [tools] = (
		await pool.query<{ total: string; failures: string }>(
			`SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT success)::int AS failures FROM tool_executions`,
		)
	).rows;

	const [jobs] = (
		await pool.query<{ total: string; failures: string; dead: string }>(`
		SELECT
			count(*)::int AS total,
			count(*) FILTER (WHERE status = 'failed')::int AS failures,
			count(*) FILTER (WHERE status = 'dead_letter')::int AS dead
		FROM job_executions`)
	).rows;

	const [audit] = (
		await pool.query<{ actions: string; denials: string }>(`
		SELECT
			count(*) FILTER (WHERE occurred_at > now() - interval '1 day')::int AS actions,
			count(*) FILTER (WHERE occurred_at > now() - interval '1 day' AND outcome = 'denied')::int AS denials
		FROM admin_audit_logs`)
	).rows;

	const toolTotal = Number(tools?.total ?? 0);
	const toolFailures = Number(tools?.failures ?? 0);
	const jobTotal = Number(jobs?.total ?? 0);
	const jobFailures = Number(jobs?.failures ?? 0);

	return {
		incidentsTotal: Number(incidents?.total ?? 0),
		incidentsOpen: Number(incidents?.open ?? 0),
		incidentsBySeverity,
		toolExecutionsTotal: toolTotal,
		toolFailures,
		toolFailureRate: toolTotal > 0 ? toolFailures / toolTotal : null,
		jobExecutionsTotal: jobTotal,
		jobFailures,
		jobFailureRate: jobTotal > 0 ? jobFailures / jobTotal : null,
		deadLetterCount: Number(jobs?.dead ?? 0),
		auditActionsToday: Number(audit?.actions ?? 0),
		auditDenialsToday: Number(audit?.denials ?? 0),
		adminActionsToday: Number(audit?.actions ?? 0),
	};
}

// ─── Cost ────────────────────────────────────────────────────────────────────

export type CostBreakdown = {
	ai: number;
	voice: number;
	storage: number;
	database: number;
	infrastructure: number;
	notifications: number;
	other: number;
	total: number;
	monthlyProjectionUsd: number;
	notes: string[];
};

/**
 * Estimated operational cost.
 *
 * Only AI is derived from real usage. The infrastructure rows are configuration
 * values, not measurements, so they are reported as zero-with-a-note rather than
 * invented: a cost screen that fabricates a database bill is worse than one that
 * says it does not know.
 */
export async function getCostBreakdown(days = 30): Promise<CostBreakdown> {
	const ai = await getAiMetrics(days);
	const pool = getDbPool();

	const [voice] = (
		await pool.query<{ seconds: string }>(`
		SELECT COALESCE(SUM(value), 0)::bigint AS seconds
		FROM usage_records
		WHERE metric IN ('voice_seconds', 'recording_seconds')
		  AND recorded_at > now() - ($1::int * interval '1 day')`,
			[days],
		)
	).rows;

	const voiceSeconds = Number(voice?.seconds ?? 0);
	const notes: string[] = [
		'AI cost is estimated from persisted token counts multiplied by published list prices. It is not a billed figure.',
	];

	if (voiceSeconds > 0) {
		notes.push(
			`${voiceSeconds.toLocaleString()} voice seconds were recorded in this window, but no per-minute provider rate is stored, so voice cost is not estimated here.`,
		);
	}

	notes.push(
		'Database, storage, notification and infrastructure cost are not estimated: no provider usage API is wired up, so any figure shown would be invented.',
	);

	const dailyAi = days > 0 ? ai.estimatedCostUsd / days : 0;

	return {
		ai: ai.estimatedCostUsd,
		voice: 0,
		storage: 0,
		database: 0,
		infrastructure: 0,
		notifications: 0,
		other: 0,
		total: ai.estimatedCostUsd,
		monthlyProjectionUsd: Math.round(dailyAi * 30 * 10000) / 10000,
		notes,
	};
}

export { AI_PRICING };
