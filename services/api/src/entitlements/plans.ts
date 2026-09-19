/**
 * NOVA API — the entitlement matrix. **This is the single source of truth for
 * what each plan is allowed to do.** No route holds a limit of its own; a route
 * asks `metricLimit()` / `resolveEntitlements()` and nothing else.
 *
 * Deliberate omission: **there are no prices here, and there must not be.**
 * The master product document says not to fix prices before real cost data
 * exists; prices are a commercial decision made elsewhere. This module answers
 * only "how much is allowed", never "what does it cost". The per-unit *rates*
 * used for cost logging are a separate concern and live in `utils/env.ts`
 * (`VOICE_COST_*`), supplied by the operator.
 *
 * The four tiers and their relative shape come from the brief:
 *
 *   Free       | trial/discovery     | limited voice, reminders, short memory window
 *   Pro        | individual power    | higher voice/recording, integrations, retained memories
 *   Business   | small team          | workspace, shared approved knowledge, admin controls
 *   Enterprise | larger org          | SSO, retention, audit, custom policy, support SLA
 *
 * The values are chosen to be strictly ordered Free < Pro < Business <
 * Enterprise on every numeric axis, so "which plan is bigger" is never
 * ambiguous. `null` means "no limit" (unlimited), which only Enterprise gets.
 */

/** Plan identifiers as stored in `subscriptions.plan` / `organizations.plan`. */
export const PLAN_IDS = ['free', 'pro', 'business', 'enterprise'] as const;

export type PlanId = (typeof PLAN_IDS)[number];

/** The plan every account without a subscription row resolves to. */
export const DEFAULT_PLAN: PlanId = 'free';

export interface PlanEntitlements {
	/** Spoken-audio allowance per calendar month, in minutes. */
	readonly voiceMinutesPerMonth: number;
	/** Uploaded/processed recording allowance per calendar month, in minutes. */
	readonly recordingMinutesPerMonth: number;
	/** How long a stored memory is retained, in days. */
	readonly memoryRetentionDays: number;
	/** How many memories may be stored at once. */
	readonly memoriesRetained: number;
	/** Connected third-party integrations; `null` = unlimited. */
	readonly integrationsAllowed: number | null;
	/** Shared team workspace. */
	readonly workspace: boolean;
	/** Shared, approved team knowledge base. */
	readonly sharedKnowledge: boolean;
	/** Member management / org admin surface. */
	readonly adminControls: boolean;
	/** Single sign-on. */
	readonly sso: boolean;
	/** Audit log access and export. */
	readonly audit: boolean;
	/** Custom retention / policy configuration. */
	readonly customPolicy: boolean;
	/** Contracted support SLA. */
	readonly supportSla: boolean;
}

/**
 * The matrix. Frozen so a route cannot accidentally mutate a plan at runtime
 * (an in-process mutation would silently re-price every request on that
 * replica).
 */
export const PLANS: Readonly<Record<PlanId, Readonly<PlanEntitlements>>> = Object.freeze({
	free: Object.freeze({
		voiceMinutesPerMonth: 30,
		recordingMinutesPerMonth: 30,
		memoryRetentionDays: 7,
		memoriesRetained: 100,
		integrationsAllowed: 0,
		workspace: false,
		sharedKnowledge: false,
		adminControls: false,
		sso: false,
		audit: false,
		customPolicy: false,
		supportSla: false,
	}),
	pro: Object.freeze({
		voiceMinutesPerMonth: 300,
		recordingMinutesPerMonth: 600,
		memoryRetentionDays: 90,
		memoriesRetained: 2_000,
		integrationsAllowed: 5,
		workspace: false,
		sharedKnowledge: false,
		adminControls: false,
		sso: false,
		audit: false,
		customPolicy: false,
		supportSla: false,
	}),
	business: Object.freeze({
		voiceMinutesPerMonth: 1_500,
		recordingMinutesPerMonth: 3_000,
		memoryRetentionDays: 365,
		memoriesRetained: 25_000,
		integrationsAllowed: 25,
		workspace: true,
		sharedKnowledge: true,
		adminControls: true,
		sso: false,
		audit: true,
		customPolicy: false,
		supportSla: false,
	}),
	enterprise: Object.freeze({
		voiceMinutesPerMonth: 6_000,
		recordingMinutesPerMonth: 12_000,
		memoryRetentionDays: 1_095,
		memoriesRetained: 250_000,
		integrationsAllowed: null,
		workspace: true,
		sharedKnowledge: true,
		adminControls: true,
		sso: true,
		audit: true,
		customPolicy: true,
		supportSla: true,
	}),
});

/** Boolean entitlements, for feature gates that are not counters. */
export const FEATURE_KEYS = [
	'workspace',
	'sharedKnowledge',
	'adminControls',
	'sso',
	'audit',
	'customPolicy',
	'supportSla',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/**
 * Coerce anything the database might hold into a known plan.
 *
 * `subscriptions.plan` is a free-form `varchar(50)`, and `organizations.plan`
 * defaults to `'free'`. A row written by a future/older version, or by a human
 * in psql (`'Pro'`, `' pro '`, `'premium'`), must not throw on a request path:
 * an unknown plan is treated as `free`, which is the safe direction (it can
 * only ever *reduce* what is allowed, never grant more).
 */
export function normalizePlan(raw: string | null | undefined): PlanId {
	if (!raw) return DEFAULT_PLAN;
	const key = raw.trim().toLowerCase();
	return (PLAN_IDS as readonly string[]).includes(key) ? (key as PlanId) : DEFAULT_PLAN;
}

/** True when `raw` names a plan this build understands. */
export function isKnownPlan(raw: string | null | undefined): boolean {
	return !!raw && (PLAN_IDS as readonly string[]).includes(raw.trim().toLowerCase());
}

/** The full entitlement set for a plan. Unknown plans resolve to Free. */
export function resolveEntitlements(plan: string | null | undefined): Readonly<PlanEntitlements> {
	return PLANS[normalizePlan(plan)];
}

/** One boolean entitlement. Unknown plans resolve to Free (all `false` there). */
export function hasFeature(plan: string | null | undefined, feature: FeatureKey): boolean {
	return resolveEntitlements(plan)[feature];
}

// ─── Metered metrics ────────────────────────────────────────────────────────

/**
 * Metrics that are counted against a limit, i.e. the ones `usage_records`
 * accumulates and the quota check sums.
 *
 * **Only monthly *flows* belong here.** `usage_records` is an append-only event
 * log (`metric`, `value`, `recorded_at`), and the quota check sums a date range,
 * so it measures "how much was consumed this period". The matrix also contains
 * *stock* ceilings — `memoriesRetained` (how many memories exist at once) and
 * `integrationsAllowed` (how many integrations are connected at once) — which a
 * date-ranged sum cannot express: reconnecting an integration would count twice,
 * and deleting memories would never give the allowance back. Those are reported
 * as entitlements by `GET /subscriptions` and, when their write paths exist,
 * belong to a live-row count rather than to this meter. Declaring them here
 * would create a limit that silently never fires, which is worse than not
 * claiming it.
 *
 * Naming rule: the metric name states the unit that is stored, and that unit is
 * always an integer (`usage_records.value` is `integer`).
 *
 *  - `voice_seconds`     — seconds of caller audio sent to speech-to-text on the
 *                          realtime socket. Seconds, not minutes: a turn is
 *                          typically 5–30 s and an integer minute counter would
 *                          round almost every turn to 0 and silently allow
 *                          unlimited use.
 *  - `recording_seconds` — seconds of uploaded recording audio.
 */
export const LIMITED_METRICS = ['voice_seconds', 'recording_seconds'] as const;

export type LimitedMetric = (typeof LIMITED_METRICS)[number];

export type UsageUnit = 'seconds' | 'count';

const METRIC_UNITS: Readonly<Record<LimitedMetric, UsageUnit>> = Object.freeze({
	voice_seconds: 'seconds',
	recording_seconds: 'seconds',
});

/** The stored unit for a metric, so a writer never has to guess. */
export function unitForMetric(metric: LimitedMetric): UsageUnit {
	return METRIC_UNITS[metric];
}

/**
 * Where each metric's ceiling comes from. This is the *only* place a metric is
 * bound to a plan field — changing what counts as the voice allowance is a
 * one-line edit here plus the matrix above.
 *
 * A minute-based entitlement is converted to the metric's stored seconds here,
 * so the conversion lives next to the limit rather than in the routes.
 */
const METRIC_LIMIT_SOURCE: Readonly<
	Record<LimitedMetric, { readonly from: keyof PlanEntitlements; readonly factor: number }>
> = Object.freeze({
	voice_seconds: { from: 'voiceMinutesPerMonth', factor: 60 },
	recording_seconds: { from: 'recordingMinutesPerMonth', factor: 60 },
});

export interface MetricLimit {
	readonly metric: LimitedMetric;
	readonly unit: UsageUnit;
	/** Ceiling in the metric's own unit. A metered ceiling is always finite. */
	readonly limit: number;
}

/**
 * The ceiling for one metric under one plan, expressed in the metric's stored
 * unit.
 *
 * Metered ceilings are always finite. `integrationsAllowed` is a *stock* ceiling
 * that may be `null` ("unlimited") in the matrix, but it is not a metered metric,
 * so it never reaches here. If a future edit binds a meter to a field that is not
 * a plain number, this throws: silently treating a boolean as a limit, or a
 * non-number as "no limit", would hand out unlimited usage — the exact failure
 * this layer exists to prevent.
 */
export function metricLimit(plan: string | null | undefined, metric: LimitedMetric): number {
	const entitlements = resolveEntitlements(plan);
	const source = METRIC_LIMIT_SOURCE[metric];
	const raw = entitlements[source.from];
	if (typeof raw !== 'number' || !Number.isFinite(raw)) {
		throw new Error(
			`Entitlement matrix misconfigured: metric "${metric}" is bound to "${source.from}", which is not a finite number`,
		);
	}
	return raw * source.factor;
}

/** Every metric's ceiling for a plan, as an API-friendly list. */
export function metricLimits(plan: string | null | undefined): MetricLimit[] {
	return LIMITED_METRICS.map((metric) => ({
		metric,
		unit: unitForMetric(metric),
		limit: metricLimit(plan, metric),
	}));
}

// ─── Periods ────────────────────────────────────────────────────────────────

export interface UsagePeriod {
	/** Inclusive start. */
	readonly start: Date;
	/** Exclusive end. */
	readonly end: Date;
}

/**
 * The calendar month containing `now`, in UTC.
 *
 * Derived from the clock rather than from a server-local month so two replicas
 * in different timezones agree on where a period begins. Used when the account
 * has no subscription row (and therefore no provider-billed period), which is
 * every account today.
 */
export function calendarMonthPeriod(now: Date = new Date()): UsagePeriod {
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
	const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
	return { start, end };
}

/** Two periods cover the same instants. */
export function samePeriod(a: UsagePeriod, b: UsagePeriod): boolean {
	return a.start.getTime() === b.start.getTime() && a.end.getTime() === b.end.getTime();
}
