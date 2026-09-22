/**
 * Admin Control Center — cost control.
 *
 * Only AI cost is derived from real usage, and even that is an **estimate**: persisted
 * token counts multiplied by published list prices. It is not a billed figure — no
 * provider invoice is read by this system.
 *
 * The other cost lines are reported as not estimated with the reason. A cost screen that
 * invents a database bill is worse than one that admits it does not know, because an
 * operator would budget against the invented number.
 */

import Link from 'next/link';
import { getAiMetrics, getCostBreakdown, getOperations } from '../../lib/api';
import { loadPage } from '../../lib/page-data';
import { PageError } from '../../components/PageError';
import {
	Card,
	Cell,
	EmptyState,
	Metric,
	MetricGrid,
	Notes,
	PageHeader,
	Row,
	StatusBadge,
	Table,
	formatNumber,
	formatUsd,
} from '../../components/ui';

export const dynamic = 'force-dynamic';

export default async function CostPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const rawDays = Array.isArray(resolved.days) ? resolved.days[0] : resolved.days;
	const parsedDays = Number.parseInt(rawDays ?? '30', 10);
	const days = [7, 30, 90, 365].includes(parsedDays) ? parsedDays : 30;

	const result = await loadPage(async () => {
		const [cost, ai, usageByUser] = await Promise.all([
			getCostBreakdown(days),
			getAiMetrics(days),
			// Per-user AI usage is answered by the legacy usage route, which takes a tenant
			// id; without one, the platform-wide model breakdown is the useful view.
			getOperations<Record<string, unknown>>('conversations', { pageSize: 1 }).catch(() => null),
		]);
		return { rows: [{ cost, ai, usageByUser }] };
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="AI Cost" />
				<PageError
					title="Could not load cost data"
					message={result.message}
					status={result.status}
					retryHref="/cost"
				/>
			</div>
		);
	}

	const { cost, ai } = result.rows[0];

	return (
		<div>
			<PageHeader
				title="AI Cost"
				subtitle={
					<>
						Estimated from persisted token counts over the last {days} days.{' '}
						{[7, 30, 90, 365].map((option) => (
							<Link
								key={option}
								href={`/cost?days=${option}`}
								style={{
									marginLeft: '0.5rem',
									color: option === days ? '#111827' : '#2563eb',
									fontWeight: option === days ? 700 : 400,
								}}
							>
								{option}d
							</Link>
						))}
					</>
				}
				actions={
					<Link href="/analytics" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
						Analytics →
					</Link>
				}
			/>

			<MetricGrid minWidth={180}>
				<Metric label={`AI cost (${days}d)`} value={formatUsd(cost.ai)} hint="List-price estimate" />
				<Metric label="Monthly projection" value={formatUsd(cost.monthlyProjectionUsd, 2)} hint="Extrapolated from the daily average" />
				<Metric label="Total tokens" value={ai.totalTokens} />
				<Metric label="Requests" value={ai.requestsThisMonth} />
			</MetricGrid>

			<Card title="Cost lines" subtitle="What is measured, and what is not">
				<Table columns={['Line', 'Estimated', 'Basis']}>
					<Row>
						<Cell>AI (LLM)</Cell>
						<Cell>{formatUsd(cost.ai)}</Cell>
						<Cell muted>Real persisted token counts × published list prices. The only measured line.</Cell>
					</Row>
					{[
						['Speech-to-text', cost.voice, 'No per-request STT row is written, and no per-minute provider rate is stored.'],
						['Text-to-speech', cost.voice, 'TTS calls are not counted; the realtime pipeline does not write a usage row.'],
						['Storage', cost.storage, 'No object-storage usage API is integrated, so bytes stored and egress are unknown.'],
						['Database', cost.database, 'No provider billing API is read. Instance cost is a deployment fact, not a runtime one.'],
						['Infrastructure', cost.infrastructure, 'Compute cost depends on the deployment platform, which this API cannot query.'],
						['Notifications', cost.notifications, 'No push is delivered today, so there is nothing to bill.'],
						['Other APIs', cost.other, 'No other paid API is integrated.'],
					].map(([label, value, basis]) => (
						<Row key={String(label)}>
							<Cell>{String(label)}</Cell>
							<Cell>
								{Number(value) > 0 ? formatUsd(Number(value)) : <StatusBadge status="unknown" label="not estimated" />}
							</Cell>
							<Cell muted>{String(basis)}</Cell>
						</Row>
					))}
				</Table>
				<Notes notes={cost.notes} tone="warn" />
			</Card>

			<Card
				title="Cost by model"
				subtitle="The per-model split is precise; the day series below uses a blended rate"
				action={
					<Link href="/ai" style={{ fontSize: '0.78rem', color: '#2563eb' }}>
						Model usage →
					</Link>
				}
			>
				{ai.byModel.length === 0 ? (
					<EmptyState message="No AI usage in this window" />
				) : (
					<Table columns={['Model', 'Requests', 'Input tokens', 'Output tokens', 'Estimated cost', 'Rate on file']}>
						{ai.byModel.map((model) => (
							<Row key={model.model}>
								<Cell mono>{model.model}</Cell>
								<Cell align="right">{formatNumber(model.requests)}</Cell>
								<Cell align="right">{formatNumber(model.inputTokens)}</Cell>
								<Cell align="right">{formatNumber(model.outputTokens)}</Cell>
								<Cell align="right">{model.pricingKnown ? formatUsd(model.estimatedCostUsd) : 'excluded'}</Cell>
								<Cell>
									{model.pricingKnown ? (
										<StatusBadge status="pass" label="priced" />
									) : (
										<StatusBadge status="unknown" label="no price on file" />
									)}
								</Cell>
							</Row>
						))}
					</Table>
				)}
				{ai.byModel.some((model) => !model.pricingKnown) ? (
					<Notes
						tone="warn"
						notes={[
							'A model in use has no rate on file, so its cost is excluded from the total rather than guessed. That makes the total a floor, not a ceiling — add the rate in services/api/src/admin/pricing.ts to close the gap.',
						]}
					/>
				) : null}
			</Card>

			{ai.byDay.length > 0 ? (
				<Card title={`Daily estimated cost (${days} days)`} subtitle="Blended rate applied to the day's total tokens">
					<Table columns={['Day', 'Requests', 'Tokens', 'Estimated cost']}>
						{ai.byDay
							.slice()
							.reverse()
							.slice(0, 30)
							.map((day) => (
								<Row key={day.day}>
									<Cell mono>{day.day}</Cell>
									<Cell align="right">{formatNumber(day.requests)}</Cell>
									<Cell align="right">{formatNumber(day.tokens)}</Cell>
									<Cell align="right">{formatUsd(day.estimatedCostUsd)}</Cell>
								</Row>
							))}
					</Table>
				</Card>
			) : null}

			<Card title="Alerts" subtitle="Abnormal-usage alerting is not implemented">
				<p style={{ margin: 0, fontSize: '0.85rem', color: '#374151', lineHeight: 1.6 }}>
					There is no threshold or anomaly alerting on spend. Implementing it needs a periodic evaluator and a
					delivery channel, and the platform has neither: the in-process engines do not write execution rows and
					there is no push channel to notify anyone through. Adding a switch here that did nothing would suggest
					cover that does not exist.
				</p>
				<p style={{ margin: '0.6rem 0 0', fontSize: '0.8rem', color: '#6b7280' }}>
					What does exist today: the estimated total above, and the audit trail of who changed what.
				</p>
			</Card>
		</div>
	);
}
