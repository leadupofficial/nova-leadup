/**
 * Shared test double for the entitlement layer.
 *
 * `QuotaStore` exists as an interface precisely so entitlement behaviour can be
 * exercised without Postgres; this is the in-memory implementation those tests
 * inject via `setQuotaStore` / `requireEntitlement`.
 */
import type { LimitedMetric } from '../../entitlements/plans.js';
import type {
	QuotaStore,
	SubscriptionSnapshot,
	UsageRecordInput,
} from '../../entitlements/quota.js';

export class FakeQuotaStore implements QuotaStore {
	subscription: SubscriptionSnapshot | null = null;
	usage: Record<LimitedMetric, number> = { voice_seconds: 0, recording_seconds: 0 };
	recorded: UsageRecordInput[] = [];
	/** Which call should throw, to exercise the fail-open paths. */
	throwOn: 'getSubscription' | 'sumUsage' | 'usageByMetric' | 'recordUsage' | null = null;

	async getSubscription(): Promise<SubscriptionSnapshot | null> {
		if (this.throwOn === 'getSubscription') throw new Error('database unavailable');
		return this.subscription;
	}

	async sumUsage(_userId: string, metric: LimitedMetric): Promise<number> {
		if (this.throwOn === 'sumUsage') throw new Error('database unavailable');
		return this.usage[metric] ?? 0;
	}

	async usageByMetric(): Promise<Record<LimitedMetric, number>> {
		if (this.throwOn === 'usageByMetric') throw new Error('database unavailable');
		return { ...this.usage };
	}

	async recordUsage(entry: UsageRecordInput): Promise<void> {
		if (this.throwOn === 'recordUsage') throw new Error('database unavailable');
		this.recorded.push(entry);
	}
}

/** An active `pro` subscription unless overridden. */
export function subscription(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
	return {
		plan: 'pro',
		status: 'active',
		provider: 'razorpay',
		externalSubscriptionId: 'sub_123',
		currentPeriodStart: null,
		currentPeriodEnd: null,
		cancelledAt: null,
		...overrides,
	};
}
