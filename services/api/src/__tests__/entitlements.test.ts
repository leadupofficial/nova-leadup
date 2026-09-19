/**
 * NOVA API — the entitlement matrix and the quota arithmetic.
 *
 * Policy, not plumbing: these assertions are about *what each plan allows* and
 * about the pure `evaluateQuota` decision. Nothing here touches a store — the
 * behaviour of `checkQuota` / `requireEntitlement` against an injected
 * `QuotaStore` lives in `quota-enforcement.test.ts`, so a failure here points at
 * a matrix edit and a failure there points at the decision path.
 *
 * The refusal code (`QUOTA_EXCEEDED`) is asserted by name because clients branch
 * on it: the brief requires a machine-readable code, never prose the model could
 * talk around.
 */
import { describe, it, expect } from 'vitest';
import './setup.js';

import {
	PLANS,
	PLAN_IDS,
	LIMITED_METRICS,
	normalizePlan,
	isKnownPlan,
	hasFeature,
	metricLimit,
	metricLimits,
	resolveEntitlements,
	calendarMonthPeriod,
	unitForMetric,
	type PlanEntitlements,
} from '../entitlements/plans.js';
import { evaluateQuota, QUOTA_EXCEEDED_CODE } from '../entitlements/quota.js';

// ─── The matrix ─────────────────────────────────────────────────────────────

describe('entitlement matrix', () => {
	it('defines exactly the four plans', () => {
		expect(PLAN_IDS).toEqual(['free', 'pro', 'business', 'enterprise']);
		expect(Object.keys(PLANS).sort()).toEqual([...PLAN_IDS].sort());
	});

	it('orders every numeric allowance Free < Pro < Business < Enterprise', () => {
		const axes: Array<keyof PlanEntitlements> = [
			'voiceMinutesPerMonth',
			'recordingMinutesPerMonth',
			'memoryRetentionDays',
			'memoriesRetained',
		];
		for (const axis of axes) {
			const values = PLAN_IDS.map((plan) => PLANS[plan][axis] as number);
			for (let i = 1; i < values.length; i += 1) {
				expect(values[i], `${axis}: ${PLAN_IDS[i]} vs ${PLAN_IDS[i - 1]}`).toBeGreaterThan(
					values[i - 1],
				);
			}
		}
	});

	it('gates integrations: none on Free, a count on Pro/Business, unlimited on Enterprise', () => {
		expect(PLANS.free.integrationsAllowed).toBe(0);
		expect(PLANS.pro.integrationsAllowed).toBeGreaterThan(0);
		expect(PLANS.business.integrationsAllowed).toBeGreaterThan(
			PLANS.pro.integrationsAllowed as number,
		);
		expect(PLANS.enterprise.integrationsAllowed).toBeNull();
	});

	it('gives admin controls to Business and SSO/audit/policy/SLA only to Enterprise', () => {
		expect(hasFeature('free', 'adminControls')).toBe(false);
		expect(hasFeature('pro', 'adminControls')).toBe(false);
		expect(hasFeature('business', 'adminControls')).toBe(true);
		expect(hasFeature('business', 'sso')).toBe(false);
		expect(hasFeature('business', 'audit')).toBe(true);
		expect(hasFeature('business', 'supportSla')).toBe(false);

		for (const feature of [
			'sso',
			'audit',
			'customPolicy',
			'supportSla',
			'workspace',
			'sharedKnowledge',
		] as const) {
			expect(hasFeature('enterprise', feature), feature).toBe(true);
		}
	});

	it('carries limits only — never a price or a currency amount', () => {
		for (const plan of PLAN_IDS) {
			for (const key of Object.keys(PLANS[plan])) {
				expect(key, `${plan}.${key}`).not.toMatch(/price|amount|cost|usd|inr|currency|rate/i);
			}
		}
		expect(JSON.stringify(PLANS)).not.toMatch(/\$|₹|usd|inr/i);
	});

	it('is frozen so a request cannot mutate a plan at runtime', () => {
		expect(Object.isFrozen(PLANS)).toBe(true);
		expect(Object.isFrozen(PLANS.free)).toBe(true);
	});
});

describe('plan normalisation', () => {
	it('accepts the four known plans, case- and whitespace-insensitively', () => {
		expect(normalizePlan('pro')).toBe('pro');
		expect(normalizePlan('  PRO ')).toBe('pro');
		expect(normalizePlan('Business')).toBe('business');
		expect(isKnownPlan('enterprise')).toBe(true);
	});

	it('resolves anything unknown or absent to Free, the safe direction', () => {
		expect(normalizePlan(null)).toBe('free');
		expect(normalizePlan(undefined)).toBe('free');
		expect(normalizePlan('')).toBe('free');
		expect(normalizePlan('premium')).toBe('free');
		expect(isKnownPlan('premium')).toBe(false);
		// Free is the floor: an unknown plan can only reduce what is allowed.
		expect(resolveEntitlements('premium')).toEqual(PLANS.free);
	});
});

describe('metric limits', () => {
	it('converts the minute entitlements into the seconds the meter stores', () => {
		expect(metricLimit('free', 'voice_seconds')).toBe(PLANS.free.voiceMinutesPerMonth * 60);
		expect(metricLimit('pro', 'recording_seconds')).toBe(
			PLANS.pro.recordingMinutesPerMonth * 60,
		);
		expect(unitForMetric('voice_seconds')).toBe('seconds');
	});

	it('reports an unknown plan at the Free ceiling', () => {
		expect(metricLimit('nonsense', 'voice_seconds')).toBe(metricLimit('free', 'voice_seconds'));
	});

	it('lists a limit for every limited metric', () => {
		const limits = metricLimits('business');
		expect(limits.map((entry) => entry.metric)).toEqual([...LIMITED_METRICS]);
		for (const entry of limits) {
			expect(entry.limit).toBeGreaterThan(0);
			expect(entry.unit).toBe(unitForMetric(entry.metric));
		}
	});
});

describe('billing periods', () => {
	it('uses UTC calendar-month boundaries, exclusive at the end', () => {
		const period = calendarMonthPeriod(new Date('2026-03-17T23:30:00Z'));
		expect(period.start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
		expect(period.end.toISOString()).toBe('2026-04-01T00:00:00.000Z');
	});

	it('rolls the year over in December', () => {
		const period = calendarMonthPeriod(new Date('2026-12-31T23:59:59Z'));
		expect(period.start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
		expect(period.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
	});
});

// ─── Pure quota arithmetic ──────────────────────────────────────────────────

describe('evaluateQuota', () => {
	it('allows a request that fits under the ceiling', () => {
		const verdict = evaluateQuota({ plan: 'free', metric: 'voice_seconds', used: 100, requested: 50 });
		expect(verdict.allowed).toBe(true);
		expect(verdict.code).toBe('OK');
		expect(verdict.limit).toBe(1800);
		expect(verdict.remaining).toBe(1700);
	});

	it('allows a request that exactly reaches the ceiling', () => {
		const verdict = evaluateQuota({ plan: 'free', metric: 'voice_seconds', used: 1799, requested: 1 });
		expect(verdict.allowed).toBe(true);
		expect(verdict.remaining).toBe(1);
	});

	it('refuses past the ceiling with the machine-readable code', () => {
		const verdict = evaluateQuota({ plan: 'free', metric: 'voice_seconds', used: 1800, requested: 1 });
		expect(verdict.allowed).toBe(false);
		expect(verdict.code).toBe(QUOTA_EXCEEDED_CODE);
		expect(verdict.remaining).toBe(0);
	});

	it('treats a zero request as a "is the meter already past the ceiling?" probe', () => {
		expect(evaluateQuota({ plan: 'free', metric: 'voice_seconds', used: 1800, requested: 0 }).allowed).toBe(true);
		expect(evaluateQuota({ plan: 'free', metric: 'voice_seconds', used: 1801, requested: 0 }).allowed).toBe(false);
		expect(evaluateQuota({ plan: 'free', metric: 'voice_seconds', used: 1801, requested: 0 }).remaining).toBe(0);
	});

	it('never lets a negative or non-finite meter buy allowance', () => {
		expect(evaluateQuota({ plan: 'free', metric: 'voice_seconds', used: -500, requested: 1 }).allowed).toBe(true);
		// NaN is coerced to 0 rather than propagating into every comparison.
		expect(evaluateQuota({ plan: 'free', metric: 'voice_seconds', used: Number.NaN, requested: 1 }).allowed).toBe(
			true,
		);
	});

	it('applies the larger Enterprise ceiling', () => {
		const verdict = evaluateQuota({
			plan: 'enterprise',
			metric: 'voice_seconds',
			used: 10_000,
			requested: 5,
		});
		expect(verdict.limit).toBe(PLANS.enterprise.voiceMinutesPerMonth * 60);
		expect(verdict.allowed).toBe(true);
	});
});
