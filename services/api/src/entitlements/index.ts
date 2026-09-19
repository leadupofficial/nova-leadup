/**
 * NOVA API — the entitlement layer's public surface.
 *
 * Routes and the realtime voice session import from here and never reach into
 * `plans.ts` / `store.ts` directly, so swapping the store (tests) or extending
 * the matrix (pricing changes) does not ripple outward.
 *
 * Everything is backed by one lazily-created `DrizzleQuotaStore`. `getDb()` is
 * itself a singleton, and this layer holds no state of its own, so there is
 * nothing to invalidate between requests.
 */
import { logger } from '../utils/logger.js';
import {
	LIMITED_METRICS,
	type LimitedMetric,
	type MetricLimit,
	type PlanEntitlements,
	type PlanId,
	type UsageUnit,
	metricLimit,
	metricLimits,
	resolveEntitlements,
	unitForMetric,
} from './plans.js';
import { checkQuota, resolvePlan, type QuotaDecision, type QuotaStore } from './quota.js';
import { DrizzleQuotaStore } from './store.js';

export * from './plans.js';
export {
	checkQuota,
	assertQuota,
	evaluateQuota,
	requireEntitlement,
	resolvePlan,
	QuotaExceededError,
	QUOTA_EXCEEDED_CODE,
	ENTITLEMENT_CHECK_UNAVAILABLE_CODE,
	subscriptionGrantsPlan,
} from './quota.js';
export type {
	QuotaDecision,
	QuotaStore,
	ResolvedPlan,
	SubscriptionSnapshot,
	UsageRecordInput,
} from './quota.js';

let store: QuotaStore | null = null;

/** The process-wide store. */
export function getQuotaStore(): QuotaStore {
	if (!store) store = new DrizzleQuotaStore();
	return store;
}

/**
 * Replace the store. Exists so a test (or a future billing worker) can inject an
 * implementation without a database; production never calls it.
 */
export function setQuotaStore(next: QuotaStore | null): void {
	store = next;
}

// ─── Metering ───────────────────────────────────────────────────────────────

/** Metric names as constants, so a writer cannot typo a string into a silo. */
export const USAGE_METRICS = Object.freeze({
	voiceSeconds: 'voice_seconds',
	recordingSeconds: 'recording_seconds',
} as const satisfies Record<string, LimitedMetric>);

/**
 * Appends a meter reading.
 *
 * **Never throws.** A metering write must not be able to fail the operation it
 * measures — a dropped reminder because the usage table was slow is a worse
 * outcome than an undercounted minute. Failures are logged with the metric and
 * value so they can be replayed.
 *
 * Callers on a latency-sensitive path should not await this; use `void
 * recordUsage(...)` and let it settle in the background.
 */
export async function recordUsage(
	userId: string,
	metric: LimitedMetric,
	value: number,
	options: { tenantId?: string | null; unit?: UsageUnit; recordedAt?: Date } = {},
): Promise<void> {
	if (!Number.isFinite(value) || value <= 0) return;
	const rounded = Math.round(value);
	if (rounded <= 0) return;

	try {
		await getQuotaStore().recordUsage({
			userId,
			tenantId: options.tenantId ?? null,
			metric,
			value: rounded,
			unit: options.unit ?? unitForMetric(metric),
			recordedAt: options.recordedAt,
		});
	} catch (err) {
		logger.warn(
			{ err, userId, metric, value: rounded },
			'Usage record write failed; the operation it measured was not affected',
		);
	}
}

// ─── Enforcement ────────────────────────────────────────────────────────────

/** The decision for one operation, without throwing. Used by the voice gate. */
export async function authorizeUsage(
	userId: string,
	metric: LimitedMetric,
	amount = 1,
): Promise<QuotaDecision> {
	return checkQuota(getQuotaStore(), userId, metric, amount);
}

// ─── Read model for GET /subscriptions ──────────────────────────────────────

export interface UsageLine {
	readonly metric: LimitedMetric;
	readonly unit: UsageUnit;
	readonly used: number;
	readonly limit: number;
	readonly remaining: number;
	readonly exceeded: boolean;
}

export interface EntitlementSummary {
	readonly plan: PlanId;
	/** The plan named by the subscription row, even when it is not granting it. */
	readonly storedPlan: string | null;
	readonly status: string;
	readonly granting: boolean;
	readonly provider: string | null;
	readonly externalSubscriptionId: string | null;
	readonly currentPeriodStart: Date;
	readonly currentPeriodEnd: Date;
	readonly periodSource: 'subscription' | 'calendar_month';
	readonly cancelledAt: Date | null;
	/** The full matrix row for the effective plan. */
	readonly entitlements: Readonly<PlanEntitlements>;
	/** Every metered metric's ceiling, in its stored unit. */
	readonly limits: readonly MetricLimit[];
	/** Current-period usage against each of those metrics. */
	readonly usage: readonly UsageLine[];
	/**
	 * False when the meter could not be read, in which case `usage` is zeroed
	 * rather than absent. The plan and entitlements are still authoritative.
	 */
	readonly usageAvailable: boolean;
}

/**
 * Everything `GET /api/v1/subscriptions` reports, in one call.
 *
 * No subscription row is the common case (every account today): the caller gets
 * `plan: 'free'`, `status: 'none'`, the current UTC month as the period, and
 * zeroed usage — not an error.
 */
export async function describeEntitlements(
	userId: string,
	now: Date = new Date(),
): Promise<EntitlementSummary> {
	const quotaStore = getQuotaStore();
	const resolved = await resolvePlan(quotaStore, userId, now);
	const entitlements = resolveEntitlements(resolved.plan);

	let usage: Record<LimitedMetric, number>;
	let usageAvailable = true;
	try {
		usage = await quotaStore.usageByMetric(userId, resolved.period);
	} catch (err) {
		// The plan is still worth reporting even if the meter cannot be read; the
		// zeroed usage is labelled by `usageAvailable: false` rather than silently
		// presented as truth.
		logger.warn({ err, userId }, 'Usage totals unavailable for subscription summary');
		usage = emptyUsage();
		usageAvailable = false;
	}

	return buildSummary(resolved, entitlements, usage, usageAvailable);
}

export function buildSummary(
	resolved: Awaited<ReturnType<typeof resolvePlan>>,
	entitlements: Readonly<PlanEntitlements>,
	usage: Record<LimitedMetric, number>,
	usageAvailable = true,
): EntitlementSummary {
	const limits = metricLimits(resolved.plan);
	const limitByMetric = new Map(limits.map((entry) => [entry.metric, entry.limit]));

	const usageLines: UsageLine[] = LIMITED_METRICS.map((metric) => {
		const limit = limitByMetric.get(metric) ?? metricLimit(resolved.plan, metric);
		const used = usage[metric] ?? 0;
		return {
			metric,
			unit: unitForMetric(metric),
			used,
			limit,
			remaining: Math.max(0, limit - used),
			exceeded: used >= limit,
		};
	});

	return {
		plan: resolved.plan,
		storedPlan: resolved.storedPlan,
		status: resolved.subscription?.status ?? 'none',
		granting: resolved.granting,
		provider: resolved.subscription?.provider ?? null,
		externalSubscriptionId: resolved.subscription?.externalSubscriptionId ?? null,
		currentPeriodStart: resolved.period.start,
		currentPeriodEnd: resolved.period.end,
		periodSource: resolved.periodSource,
		cancelledAt: resolved.subscription?.cancelledAt ?? null,
		entitlements,
		limits,
		usage: usageLines,
		usageAvailable,
	};
}

function emptyUsage(): Record<LimitedMetric, number> {
	return {
		voice_seconds: 0,
		recording_seconds: 0,
	};
}
