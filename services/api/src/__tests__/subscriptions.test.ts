/**
 * NOVA API — `GET /api/v1/subscriptions` over HTTP.
 *
 * The route exists but was never mounted, so this file is also the regression
 * guard against it silently becoming a 404 again: the first assertion is that an
 * authenticated caller gets a 200 from the mounted path.
 *
 * The database is the suite's in-memory Drizzle mock (`src/__tests__/setup.ts`),
 * which returns no `subscriptions` and no `usage_records` rows — exactly the
 * state of every account in production today. So the central claim under test is
 * the one the brief calls out: **an account with no subscription row resolves to
 * Free, not an error.**
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import './setup.js';

import app from '../server.js';
import { PLANS, metricLimits } from '../entitlements/plans.js';

const JWT_SECRET = process.env.JWT_SECRET!;

function token(userId = 'user-1'): string {
	return jwt.sign({ sub: userId, email: 'user-1@example.com', role: 'user' }, JWT_SECRET, {
		expiresIn: '1h',
	});
}

describe('GET /api/v1/subscriptions', () => {
	it('is mounted and requires authentication', async () => {
		// A 404 here would mean the router was not mounted; 401 is the answer only a
		// mounted, authenticated route can give.
		const res = await request(app).get('/api/v1/subscriptions');
		expect(res.status).toBe(401);
	});

	it('resolves an account with no subscription row to Free', async () => {
		const res = await request(app)
			.get('/api/v1/subscriptions')
			.set({ Authorization: `Bearer ${token()}` });

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.data.plan).toBe('free');
		expect(res.body.data.granting).toBe(false);
		expect(res.body.data.status).toBe('none');
		expect(res.body.data.storedPlan).toBeNull();
	});

	it('returns the resolved Free entitlement matrix, not a copy of it', async () => {
		const res = await request(app)
			.get('/api/v1/subscriptions')
			.set({ Authorization: `Bearer ${token()}` });

		expect(res.body.data.entitlements).toEqual(PLANS.free);
		expect(res.body.data.entitlements.integrationsAllowed).toBe(0);
		expect(res.body.data.entitlements.adminControls).toBe(false);
		expect(res.body.data.entitlements.sso).toBe(false);
	});

	it('reports the current calendar-month period with an exclusive end', async () => {
		const res = await request(app)
			.get('/api/v1/subscriptions')
			.set({ Authorization: `Bearer ${token()}` });

		const start = new Date(res.body.data.period.start);
		const end = new Date(res.body.data.period.end);
		expect(res.body.data.period.source).toBe('calendar_month');
		expect(start.getUTCDate()).toBe(1);
		expect(end.getUTCDate()).toBe(1);
		expect(end.getTime()).toBeGreaterThan(start.getTime());
		expect(res.body.data.period.start).toBe(res.body.data.currentPeriodStart);
	});

	it('reports usage against every limited metric, with the plan ceiling', async () => {
		const res = await request(app)
			.get('/api/v1/subscriptions')
			.set({ Authorization: `Bearer ${token()}` });

		const expected = metricLimits('free');
		expect(res.body.data.usage).toHaveLength(expected.length);
		expect(res.body.data.usageAvailable).toBe(true);

		for (const line of res.body.data.usage) {
			const limit = expected.find((entry) => entry.metric === line.metric);
			expect(limit, `unexpected metric ${line.metric}`).toBeDefined();
			expect(line.used).toBe(0);
			expect(line.limit).toBe(limit!.limit);
			expect(line.remaining).toBe(limit!.limit);
			expect(line.unit).toBe(limit!.unit);
			expect(line.exceeded).toBe(false);
		}
	});
});
