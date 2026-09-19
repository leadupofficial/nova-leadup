/**
 * NOVA API — quota evaluation and enforcement.
 *
 * The brief is explicit: "Hard limits must be enforced server-side by
 * entitlements, never by prompting the model to 'behave' within a limit." So the
 * check lives here, on the request/turn path, and the refusal is a
 * machine-readable code — the model is never told about the limit and never
 * asked to police it.
 *
 * The arithmetic is a pure function (`evaluateQuota`) over three numbers. Reads
 * and writes go through a two-method `QuotaStore` interface, so the whole
 * decision can be tested without Postgres, and the Drizzle implementation
 * (`store.ts`) is the only thing that knows SQL.
 *
 * **Failure policy.** If the store throws (database down, pool exhausted), the
 * check logs and *allows* the operation. This is deliberate and documented
 * rather than accidental: the entitlement layer is a cost-control layer, and
 * failing it closed would turn a database hiccup into "every user is locked out
 * of voice". The failure is logged at `warn` with a stable code
 * (`ENTITLEMENT_CHECK_UNAVAILABLE`) so it is greppable and alertable; cost
 * anomalies during a database outage are visible rather than silent.
 */
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import {
	DEFAULT_PLAN,
	type LimitedMetric,
	type PlanId,
	type UsagePeriod,
	type UsageUnit,
	calendarMonthPeriod,
	metricLimit,
	normalizePlan,
	unitForMetric,
} from './plans.js';

/** One `subscriptions` row, flattened to what entitlement resolution needs. */
export interface SubscriptionSnapshot {
	readonly plan: string;
	readonly status: string;
	readonly provider: string | null;
	readonly externalSubscriptionId: string | null;
	readonly currentPeriodStart: Date | null;
	readonly currentPeriodEnd: Date | null;
	readonly cancelledAt: Date | null;
}

export interface UsageRecordInput {
	readonly userId: string;
	readonly tenantId?: string | null;
	readonly metric: LimitedMetric;
	readonly value: number;
	readonly unit: UsageUnit;
	readonly recordedAt?: Date;
}

/**
 * The seam. Every entitlement read/write the API performs goes through this, so
 * unit tests supply an in-memory implementation and never touch Postgres.
 */
export interface QuotaStore {
	/** Most recent subscription for the caller's organization, if any. */
	getSubscription(userId: string): Promise<SubscriptionSnapshot | null>;
	/** Sum of `usage_records.value` for one metric in `[period.start, period.end)`. */
	sumUsage(userId: string, metric: LimitedMetric, period: UsagePeriod): Promise<number>;
	/** Append one `usage_records` row. */
	recordUsage(entry: UsageRecordInput): Promise<void>;
	/** Sums for every limited metric, for the subscription summary. */
	usageByMetric(userId: string, period: UsagePeriod): Promise<Record<LimitedMetric, number>>;
}

/** Subscription statuses that grant the plan they name. Everything else = Free. */
export const GRANTING_STATUSES: readonly string[] = Object.freeze(['active', 'trialing']);

/** True when a subscription row should grant its plan right now. */
export function subscriptionGrantsPlan(subscription: SubscriptionSnapshot | null): boolean {
	if (!subscription) return false;
	return GRANTING_STATUSES.includes(subscription.status.trim().toLowerCase());
}

/**
 * The plan a caller is actually entitled to, plus why.
 *
 * No subscription row is not an error: every account in production is in that
 * state today and must behave as Free. A row whose status has lapsed
 * (`cancelled`, `past_due`, …) also resolves to Free while still being reported
 * to the caller, so a client can show "your Pro plan ended" rather than
 * pretending the row is absent.
 */
export interface ResolvedPlan {
	readonly plan: PlanId;
	/** The plan named by the row, even when it is not granting (else `null`). */
	readonly storedPlan: string | null;
	readonly subscription: SubscriptionSnapshot | null;
	readonly granting: boolean;
	/** `subscription` when the row named the period, `calendar_month` otherwise. */
	readonly periodSource: 'subscription' | 'calendar_month';
	/** The window usage is counted in. */
	readonly period: UsagePeriod;
}

export interface QuotaDecision {
	readonly allowed: boolean;
	/** `OK`, or the machine-readable refusal the caller must surface. */
	readonly code: 'OK' | 'QUOTA_EXCEEDED';
	readonly plan: PlanId;
	readonly metric: LimitedMetric;
	readonly unit: UsageUnit;
	/** Ceiling in the metric's unit. */
	readonly limit: number;
	readonly used: number;
	readonly requested: number;
	/** Never negative. */
	readonly remaining: number;
	readonly period: UsagePeriod;
}

/** Stable error code. Clients branch on this, not on prose. */
export const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED';
export const ENTITLEMENT_CHECK_UNAVAILABLE_CODE = 'ENTITLEMENT_CHECK_UNAVAILABLE';

/**
 * The whole decision, as pure arithmetic.
 *
 * `used` is what has already been consumed this period; `requested` is what this
 * operation wants to consume. `allowed` is `used + requested <= limit`, so at
 * exactly the ceiling with `requested: 0` there is nothing left but nothing is
 * over either. The realtime voice gate passes `requested: 1` — "is there still
 * allowance for another turn?" — because a turn's length is not known until it
 * ends.
 */
export function evaluateQuota(input: {
	plan: string | null | undefined;
	metric: LimitedMetric;
	used: number;
	requested: number;
}): { allowed: boolean; code: 'OK' | 'QUOTA_EXCEEDED'; plan: PlanId; limit: number; remaining: number } {
	const plan = normalizePlan(input.plan);
	const limit = metricLimit(plan, input.metric);
	const used = Number.isFinite(input.used) ? Math.max(0, input.used) : 0;
	const requested = Number.isFinite(input.requested) ? Math.max(0, input.requested) : 0;

	const allowed = used + requested <= limit;
	return {
		allowed,
		code: allowed ? 'OK' : QUOTA_EXCEEDED_CODE,
		plan,
		limit,
		remaining: Math.max(0, limit - used),
	};
}

/** Thrown (or handed to `next`) when a plan's ceiling has been reached. */
export class QuotaExceededError extends HttpError {
	readonly decision: QuotaDecision;

	constructor(decision: QuotaDecision) {
		super(
			402,
			`Plan limit reached for ${decision.metric}: ${decision.used} of ${decision.limit} ${decision.unit} used this period.`,
			QUOTA_EXCEEDED_CODE,
		);
		this.decision = decision;
	}
}

/**
 * Reads the plan and the period, sums current-period usage and applies
 * `evaluateQuota`.
 *
 * A store failure is allowed through (with a warning) — see the module header.
 */
export async function checkQuota(
	store: QuotaStore,
	userId: string,
	metric: LimitedMetric,
	requested = 1,
	now: Date = new Date(),
): Promise<QuotaDecision> {
	const fallbackPeriod = calendarMonthPeriod(now);

	let plan: PlanId = DEFAULT_PLAN;
	let period = fallbackPeriod;
	let used = 0;

	try {
		const resolved = await resolvePlan(store, userId, now);
		plan = resolved.plan;
		period = resolved.period;
		used = await store.sumUsage(userId, metric, period);
	} catch (err) {
		logger.warn(
			{ err, userId, metric, code: ENTITLEMENT_CHECK_UNAVAILABLE_CODE },
			'Entitlement check unavailable; allowing request',
		);
		const limit = metricLimit(plan, metric);
		return {
			allowed: true,
			code: 'OK',
			plan,
			metric,
			unit: unitForMetric(metric),
			limit,
			used,
			requested,
			remaining: Math.max(0, limit - used),
			period,
		};
	}

	const verdict = evaluateQuota({ plan, metric, used, requested });
	return {
		allowed: verdict.allowed,
		code: verdict.code,
		plan: verdict.plan,
		metric,
		unit: unitForMetric(metric),
		limit: verdict.limit,
		used,
		requested,
		remaining: verdict.remaining,
		period,
	};
}

/** `checkQuota` that throws the machine-readable `QUOTA_EXCEEDED` error. */
export async function assertQuota(
	store: QuotaStore,
	userId: string,
	metric: LimitedMetric,
	requested = 1,
): Promise<QuotaDecision> {
	const decision = await checkQuota(store, userId, metric, requested);
	if (!decision.allowed) throw new QuotaExceededError(decision);
	return decision;
}

/**
 * Express middleware form, so a REST path enforces a limit by listing it:
 *
 *   router.post('/recordings', authenticate, requireEntitlement(store, 'recording_seconds'), handler)
 *
 * `amount` is what the request will consume. A route that knows the size can
 * pass a function of the request; one that does not passes a small default and
 * the recorder records the true figure afterwards.
 *
 * Synchronous-shaped on purpose: failures go through `next(err)` and the
 * `await` is inside a `try`, because a rejected promise from an `async`
 * middleware is an unhandled rejection in Express 4 (see `middleware/auth.ts`
 * for the crash that caused).
 */
export function requireEntitlement(
	store: QuotaStore | (() => QuotaStore),
	metric: LimitedMetric,
	amount: number | ((req: Request) => number) = 1,
) {
	return (req: Request, res: Response, next: NextFunction): void => {
		void (async () => {
			try {
				const userId = (req as Request & { user?: { id: string } }).user?.id;
				if (!userId) {
					// `authenticate` runs first on every route that uses this gate; if it
					// did not, refusing is correct — an unknown caller has no entitlement.
					throw new HttpError(401, 'Authentication required', 'UNAUTHORIZED');
				}
				// Resolved here, not captured at mount time, so a store injected after
				// the router was built (tests) is still the one that is consulted.
				const quotaStore = typeof store === 'function' ? store() : store;
				const requested = typeof amount === 'function' ? amount(req) : amount;
				const decision = await checkQuota(quotaStore, userId, metric, requested);
				if (!decision.allowed) throw new QuotaExceededError(decision);
				next();
			} catch (err) {
				next(err);
			}
		})();
	};
}

/**
 * The period usage is counted in, and the plan that is actually granting.
 *
 * A subscription row wins over the calendar month *only* when it carries both
 * period bounds: `subscriptions.current_period_start` / `_end` are nullable, and
 * a half-populated row must not create an unbounded query window.
 */
export async function resolvePlan(
	store: QuotaStore,
	userId: string,
	now: Date = new Date(),
): Promise<ResolvedPlan> {
	const subscription = await store.getSubscription(userId);
	const granting = subscriptionGrantsPlan(subscription);
	const storedPlan = subscription?.plan ?? null;

	const plan: PlanId = granting ? normalizePlan(storedPlan) : DEFAULT_PLAN;

	const hasBounds = !!(subscription?.currentPeriodStart && subscription?.currentPeriodEnd);
	const period: UsagePeriod = hasBounds
		? { start: subscription!.currentPeriodStart as Date, end: subscription!.currentPeriodEnd as Date }
		: calendarMonthPeriod(now);

	return {
		plan,
		storedPlan,
		subscription,
		granting,
		periodSource: hasBounds ? 'subscription' : 'calendar_month',
		period,
	};
}
