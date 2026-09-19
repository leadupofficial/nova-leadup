/**
 * NOVA API — the Postgres-backed `QuotaStore`.
 *
 * This is the only module in the entitlement layer that knows SQL, which is
 * what lets every decision above it be unit-tested without a database. It reads
 * three existing tables and writes one; it creates nothing:
 *
 *   users.organization_id        → which organization's subscription applies
 *   subscriptions                → plan + status + billing period
 *   usage_records                → the meter (metric, value, unit, recorded_at)
 *
 * `usage_records` already carried an index on `(user_id, metric)`, so the
 * per-user, per-metric sum this layer performs is the query that index was
 * built for.
 */
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { subscriptions, usageRecords, users } from '@nova/database';
import { getDb } from '../db/connection.js';
import type { LimitedMetric, UsagePeriod } from './plans.js';
import { LIMITED_METRICS } from './plans.js';
import type { QuotaStore, SubscriptionSnapshot, UsageRecordInput } from './quota.js';

/** Columns this store selects; kept explicit so a schema drift is a type error. */
const SUBSCRIPTION_COLUMNS = {
	plan: subscriptions.plan,
	status: subscriptions.status,
	provider: subscriptions.provider,
	externalSubscriptionId: subscriptions.externalSubscriptionId,
	currentPeriodStart: subscriptions.currentPeriodStart,
	currentPeriodEnd: subscriptions.currentPeriodEnd,
	cancelledAt: subscriptions.cancelledAt,
} as const;

export class DrizzleQuotaStore implements QuotaStore {
	/**
	 * Most recent subscription row for the caller's organization.
	 *
	 * `subscriptions` is keyed by organization, not user, so a user with no
	 * organization (or an organization with no row) has no subscription — which
	 * resolves to Free rather than failing.
	 */
	async getSubscription(userId: string): Promise<SubscriptionSnapshot | null> {
		const db = getDb();

		const [user] = await db
			.select({ organizationId: users.organizationId })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);

		const organizationId = user?.organizationId;
		if (!organizationId) return null;

		const [row] = await db
			.select(SUBSCRIPTION_COLUMNS)
			.from(subscriptions)
			.where(eq(subscriptions.organizationId, organizationId))
			.orderBy(desc(subscriptions.createdAt))
			.limit(1);

		if (!row) return null;

		return {
			plan: row.plan,
			status: row.status,
			provider: row.provider ?? null,
			externalSubscriptionId: row.externalSubscriptionId ?? null,
			currentPeriodStart: row.currentPeriodStart ?? null,
			currentPeriodEnd: row.currentPeriodEnd ?? null,
			cancelledAt: row.cancelledAt ?? null,
		};
	}

	/** One metric's total for the period. `coalesce` so an empty meter is 0. */
	async sumUsage(userId: string, metric: LimitedMetric, period: UsagePeriod): Promise<number> {
		const db = getDb();
		const [row] = await db
			.select({ total: sql<number>`coalesce(sum(${usageRecords.value}), 0)` })
			.from(usageRecords)
			.where(
				and(
					eq(usageRecords.userId, userId),
					eq(usageRecords.metric, metric),
					gte(usageRecords.recordedAt, period.start),
					lt(usageRecords.recordedAt, period.end),
				),
			);
		return toCount(row?.total);
	}

	/**
	 * Every metric's total for the period in one grouped query, for the
	 * subscription summary. Metrics with no rows are reported as 0 rather than
	 * omitted, so the API response always has the same shape.
	 */
	async usageByMetric(userId: string, period: UsagePeriod): Promise<Record<LimitedMetric, number>> {
		const db = getDb();
		const rows = await db
			.select({
				metric: usageRecords.metric,
				total: sql<number>`coalesce(sum(${usageRecords.value}), 0)`,
			})
			.from(usageRecords)
			.where(
				and(
					eq(usageRecords.userId, userId),
					gte(usageRecords.recordedAt, period.start),
					lt(usageRecords.recordedAt, period.end),
				),
			)
			.groupBy(usageRecords.metric);

		const totals = emptyTotals();
		for (const row of rows) {
			if ((LIMITED_METRICS as readonly string[]).includes(row.metric)) {
				totals[row.metric as LimitedMetric] = toCount(row.total);
			}
		}
		return totals;
	}

	/** Append one meter reading. Append-only: `usage_records` is an event log. */
	async recordUsage(entry: UsageRecordInput): Promise<void> {
		const db = getDb();
		await db.insert(usageRecords).values({
			userId: entry.userId,
			tenantId: entry.tenantId ?? null,
			metric: entry.metric,
			value: entry.value,
			unit: entry.unit,
			recordedAt: entry.recordedAt ?? new Date(),
		});
	}
}

/**
 * Postgres returns `sum(integer)` as `bigint`, which node-postgres hands back as
 * a **string**. `Number()` on that is correct; adding it is not. Anything
 * non-finite degrades to 0 (an unreadable meter must not lock a user out).
 */
function toCount(raw: unknown): number {
	const value = typeof raw === 'number' ? raw : Number(raw ?? 0);
	return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function emptyTotals(): Record<LimitedMetric, number> {
	return {
		voice_seconds: 0,
		recording_seconds: 0,
	};
}
