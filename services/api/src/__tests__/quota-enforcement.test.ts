/**
 * NOVA API — the entitlement decision path, against an injected `QuotaStore`.
 *
 * This is the half of the entitlement suite that would otherwise need Postgres:
 * `QuotaStore` is an interface, `FakeQuotaStore` implements it in memory, and
 * `setQuotaStore` swaps it in. That seam is why `checkQuota`, the
 * `requireEntitlement` middleware and the `GET /subscriptions` read model can be
 * tested for the things that actually matter — ceiling arithmetic, the
 * machine-readable refusal, the fail-open policy, and the no-subscription-row
 * fallback to Free.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import './setup.js';

import { PLANS, metricLimit, type LimitedMetric } from '../entitlements/plans.js';
import {
	checkQuota,
	assertQuota,
	requireEntitlement,
	resolvePlan,
	subscriptionGrantsPlan,
	QuotaExceededError,
	QUOTA_EXCEEDED_CODE,
	type QuotaStore,
} from '../entitlements/quota.js';
import {
	USAGE_METRICS,
	describeEntitlements,
	getQuotaStore,
	recordUsage,
	setQuotaStore,
} from '../entitlements/index.js';
import { errorHandler } from '../middleware/error-handler.js';
import { FakeQuotaStore, subscription } from './helpers/quota-fixtures.js';

let store: FakeQuotaStore;

beforeEach(() => {
	store = new FakeQuotaStore();
	setQuotaStore(store);
});

afterEach(() => {
	setQuotaStore(null);
});

// ─── Plan resolution against the store ──────────────────────────────────────

describe('resolvePlan', () => {
	it('resolves an account with no subscription row to Free, not an error', async () => {
		store.subscription = null;
		const resolved = await resolvePlan(store, 'user-1', new Date('2026-03-17T00:00:00Z'));
		expect(resolved.plan).toBe('free');
		expect(resolved.granting).toBe(false);
		expect(resolved.storedPlan).toBeNull();
		expect(resolved.periodSource).toBe('calendar_month');
		expect(resolved.period.start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
	});

	it('grants an active subscription and uses its billing period', async () => {
		store.subscription = subscription({
			plan: 'business',
			currentPeriodStart: new Date('2026-03-05T00:00:00Z'),
			currentPeriodEnd: new Date('2026-04-05T00:00:00Z'),
		});
		const resolved = await resolvePlan(store, 'user-1');
		expect(resolved.plan).toBe('business');
		expect(resolved.granting).toBe(true);
		expect(resolved.periodSource).toBe('subscription');
		expect(resolved.period.start.toISOString()).toBe('2026-03-05T00:00:00.000Z');
		expect(resolved.period.end.toISOString()).toBe('2026-04-05T00:00:00.000Z');
	});

	it('drops a lapsed subscription to Free while still reporting the row', async () => {
		store.subscription = subscription({ plan: 'pro', status: 'cancelled' });
		const resolved = await resolvePlan(store, 'user-1');
		expect(resolved.plan).toBe('free');
		expect(resolved.storedPlan).toBe('pro');
		expect(resolved.granting).toBe(false);
		expect(resolved.periodSource).toBe('calendar_month');
	});

	it('ignores half-populated period bounds rather than creating an unbounded window', async () => {
		store.subscription = subscription({ currentPeriodStart: new Date('2026-03-05T00:00:00Z') });
		const resolved = await resolvePlan(store, 'user-1', new Date('2026-03-17T00:00:00Z'));
		expect(resolved.periodSource).toBe('calendar_month');
		expect(resolved.period.start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
	});

	it('treats only active and trialing statuses as granting', () => {
		expect(subscriptionGrantsPlan(subscription({ status: 'active' }))).toBe(true);
		expect(subscriptionGrantsPlan(subscription({ status: 'TRIALING' }))).toBe(true);
		expect(subscriptionGrantsPlan(subscription({ status: 'past_due' }))).toBe(false);
		expect(subscriptionGrantsPlan(subscription({ status: 'cancelled' }))).toBe(false);
		expect(subscriptionGrantsPlan(null)).toBe(false);
	});
});

// ─── The decision path ──────────────────────────────────────────────────────

describe('checkQuota', () => {
	it('sums current-period usage and allows a request that fits', async () => {
		store.usage.voice_seconds = 60;
		const decision = await checkQuota(store, 'user-1', 'voice_seconds', 30);
		expect(decision.allowed).toBe(true);
		expect(decision.used).toBe(60);
		expect(decision.limit).toBe(1800);
		expect(decision.unit).toBe('seconds');
	});

	it('refuses once the meter reaches the Free ceiling', async () => {
		store.usage.voice_seconds = 1800;
		const decision = await checkQuota(store, 'user-1', 'voice_seconds', 1);
		expect(decision.allowed).toBe(false);
		expect(decision.code).toBe(QUOTA_EXCEEDED_CODE);
		expect(decision.plan).toBe('free');
		expect(decision.remaining).toBe(0);
	});

	it('uses the paid ceiling when the subscription is active', async () => {
		store.subscription = subscription({ plan: 'pro' });
		store.usage.voice_seconds = 1800;
		const decision = await checkQuota(store, 'user-1', 'voice_seconds', 1);
		expect(decision.allowed).toBe(true);
		expect(decision.limit).toBe(PLANS.pro.voiceMinutesPerMonth * 60);
	});

	it('fails open — with a warning — when the meter cannot be read', async () => {
		store.throwOn = 'sumUsage';
		const decision = await checkQuota(store, 'user-1', 'voice_seconds', 1);
		expect(decision.allowed).toBe(true);
		expect(decision.code).toBe('OK');
	});

	it('throws a 402 QUOTA_EXCEEDED HttpError from assertQuota', async () => {
		store.usage.voice_seconds = 1800;
		await expect(assertQuota(store, 'user-1', 'voice_seconds', 1)).rejects.toBeInstanceOf(
			QuotaExceededError,
		);

		try {
			await assertQuota(store, 'user-1', 'voice_seconds', 1);
			throw new Error('expected assertQuota to throw');
		} catch (err) {
			const quotaError = err as QuotaExceededError;
			expect(quotaError.statusCode).toBe(402);
			expect(quotaError.code).toBe(QUOTA_EXCEEDED_CODE);
			expect(quotaError.decision.metric).toBe('voice_seconds');
		}
	});
});

describe('requireEntitlement middleware', () => {
	function appWith(metric: LimitedMetric, storeRef: () => QuotaStore) {
		const app = express();
		app.use(express.json());
		// Stands in for `authenticate`.
		app.use((req, _res, next) => {
			(req as unknown as { user?: { id: string } }).user = { id: 'user-1' };
			next();
		});
		app.post('/guarded', requireEntitlement(storeRef, metric), (_req, res) => {
			res.status(201).json({ ok: true });
		});
		app.use(errorHandler);
		return app;
	}

	it('passes the request through when allowance remains', async () => {
		store.usage.recording_seconds = 10;
		const res = await request(appWith('recording_seconds', () => store)).post('/guarded').send({});
		expect(res.status).toBe(201);
		expect(res.body.ok).toBe(true);
	});

	it('refuses with 402 and a machine-readable code when the allowance is spent', async () => {
		store.usage.recording_seconds = PLANS.free.recordingMinutesPerMonth * 60;
		const res = await request(appWith('recording_seconds', () => store)).post('/guarded').send({});
		expect(res.status).toBe(402);
		expect(res.body.code).toBe(QUOTA_EXCEEDED_CODE);
		expect(res.body.error).toBe(QUOTA_EXCEEDED_CODE);
	});

	it('resolves the store per request, so a late injection is honoured', async () => {
		// A function reference, not an instance: the store is looked up when the
		// request arrives, which is what makes `setQuotaStore` a usable seam.
		const app = appWith('voice_seconds', getQuotaStore);
		const replacement = new FakeQuotaStore();
		replacement.usage.voice_seconds = PLANS.free.voiceMinutesPerMonth * 60;
		setQuotaStore(replacement);
		const res = await request(app).post('/guarded').send({});
		expect(res.status).toBe(402);
	});

	it('refuses an unauthenticated request rather than assuming an entitlement', async () => {
		const app = express();
		app.post('/guarded', requireEntitlement(() => store, 'voice_seconds'), (_req, res) => {
			res.status(201).json({ ok: true });
		});
		app.use(errorHandler);
		const res = await request(app).post('/guarded').send({});
		expect(res.status).toBe(401);
	});
});

// ─── Recording usage ────────────────────────────────────────────────────────

describe('recordUsage', () => {
	it('appends a rounded, unit-tagged meter row', async () => {
		await recordUsage('user-1', USAGE_METRICS.voiceSeconds, 12.6);
		expect(store.recorded).toHaveLength(1);
		expect(store.recorded[0]).toMatchObject({
			userId: 'user-1',
			metric: 'voice_seconds',
			value: 13,
			unit: 'seconds',
		});
	});

	it('ignores zero, negative and non-finite amounts (no empty rows)', async () => {
		await recordUsage('user-1', USAGE_METRICS.voiceSeconds, 0);
		await recordUsage('user-1', USAGE_METRICS.voiceSeconds, -4);
		await recordUsage('user-1', USAGE_METRICS.voiceSeconds, Number.NaN);
		await recordUsage('user-1', USAGE_METRICS.voiceSeconds, 0.4);
		expect(store.recorded).toHaveLength(0);
	});

	it('never throws when the meter write fails', async () => {
		store.throwOn = 'recordUsage';
		await expect(recordUsage('user-1', USAGE_METRICS.voiceSeconds, 30)).resolves.toBeUndefined();
	});
});

// ─── The read model behind GET /subscriptions ───────────────────────────────

describe('describeEntitlements', () => {
	it('reports Free, the calendar month and zeroed usage for an account with no row', async () => {
		const summary = await describeEntitlements('user-1', new Date('2026-03-17T00:00:00Z'));
		expect(summary.plan).toBe('free');
		expect(summary.status).toBe('none');
		expect(summary.storedPlan).toBeNull();
		expect(summary.granting).toBe(false);
		expect(summary.periodSource).toBe('calendar_month');
		expect(summary.currentPeriodStart.toISOString()).toBe('2026-03-01T00:00:00.000Z');
		expect(summary.entitlements).toEqual(PLANS.free);
		expect(summary.usageAvailable).toBe(true);
		for (const line of summary.usage) {
			expect(line.used).toBe(0);
			expect(line.limit).toBe(metricLimit('free', line.metric));
			expect(line.exceeded).toBe(false);
		}
	});

	it('marks a spent metric as exceeded and clamps remaining at zero', async () => {
		store.usage.voice_seconds = 5000;
		const summary = await describeEntitlements('user-1');
		const voice = summary.usage.find((line) => line.metric === 'voice_seconds');
		expect(voice?.used).toBe(5000);
		expect(voice?.remaining).toBe(0);
		expect(voice?.exceeded).toBe(true);
	});

	it('reports the paid plan, its period and its entitlements when granting', async () => {
		store.subscription = subscription({
			plan: 'business',
			currentPeriodStart: new Date('2026-03-05T00:00:00Z'),
			currentPeriodEnd: new Date('2026-04-05T00:00:00Z'),
		});
		const summary = await describeEntitlements('user-1');
		expect(summary.plan).toBe('business');
		expect(summary.status).toBe('active');
		expect(summary.granting).toBe(true);
		expect(summary.periodSource).toBe('subscription');
		expect(summary.entitlements).toEqual(PLANS.business);
	});

	it('reports a lapsed plan honestly: Free entitlements, stored plan still named', async () => {
		store.subscription = subscription({ plan: 'pro', status: 'cancelled' });
		const summary = await describeEntitlements('user-1');
		expect(summary.plan).toBe('free');
		expect(summary.storedPlan).toBe('pro');
		expect(summary.status).toBe('cancelled');
		expect(summary.entitlements).toEqual(PLANS.free);
	});

	it('still reports the plan when the meter cannot be read, flagged unavailable', async () => {
		store.subscription = subscription({ plan: 'pro' });
		store.throwOn = 'usageByMetric';
		const summary = await describeEntitlements('user-1');
		expect(summary.plan).toBe('pro');
		expect(summary.usageAvailable).toBe(false);
		expect(summary.usage.every((line) => line.used === 0)).toBe(true);
	});
});
