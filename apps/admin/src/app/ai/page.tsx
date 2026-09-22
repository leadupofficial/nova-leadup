/**
 * Admin Control Center — AI providers and routing.
 *
 * Shows, per provider: whether a credential is configured, what the runtime selects by
 * default, the models in use, and the last recorded connectivity result. Credentials are
 * shown only as a masked hint — the API never returns a value, so there is nothing to
 * reveal even if this page tried.
 *
 * The page states which configuration keys actually change behaviour. Several AI keys in
 * the catalog are declared but not read by the running code, and reporting them as live
 * controls would be the single most misleading thing this screen could do.
 */

import Link from 'next/link';
import { getAiModelsApi, getAiMetrics, getAiProviders, getAiRouting } from '../../lib/api';
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
	formatDateTime,
	formatNumber,
	formatRelative,
	formatUsd,
} from '../../components/ui';

export const dynamic = 'force-dynamic';

export default async function AiPage() {
	const result = await loadPage(async () => {
		const [providers, routing, metrics, models] = await Promise.all([
			getAiProviders().catch(() => null),
			getAiRouting().catch(() => null),
			getAiMetrics(30).catch(() => null),
			getAiModelsApi().catch(() => null),
		]);
		return { rows: [{ providers, routing, metrics, models }] };
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="AI Providers" />
				<PageError
					title="Could not load AI configuration"
					message={result.message}
					status={result.status}
					retryHref="/ai"
				/>
			</div>
		);
	}

	const payload = result.rows[0];
	const providers = payload?.providers?.providers ?? [];
	const routing = payload?.routing ?? null;
	const metrics = payload?.metrics ?? null;

	const routingEntries = routing
		? Object.entries(routing).filter(([key]) => !['notes', 'limitations', 'usedBy'].includes(key))
		: [];

	return (
		<div>
			<PageHeader
				title="AI Providers"
				subtitle={
					<>
						{providers.length} provider(s) known · default model {payload?.providers?.defaultModel ?? 'unset'}.{' '}
						<Link href="/ai/secrets" style={{ color: '#2563eb' }}>
							Manage API keys →
						</Link>
					</>
				}
				actions={
					<Link href="/voice" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
						Voice control center →
					</Link>
				}
			/>

			{metrics ? (
				<MetricGrid minWidth={170}>
					<Metric label="Requests (30d)" value={metrics.requestsThisMonth} />
					<Metric label="Requests today" value={metrics.requestsToday} />
					<Metric label="Total tokens" value={metrics.totalTokens} />
					<Metric label="Estimated cost (30d)" value={formatUsd(metrics.estimatedCostUsd)} hint="List-price estimate, not billed" />
					<Metric label="Latency (mean)" metric={metrics.latency} />
					<Metric
						label="Latency (p95)"
						value={metrics.latencyP95Ms === null ? null : `${formatNumber(metrics.latencyP95Ms)} ms`}
						hint="Tail latency, which is what a user notices"
					/>
					<Metric
						label="Unattributed replies"
						value={metrics.unattributedRequests}
						tone={metrics.unattributedRequests > 0 ? 'warn' : 'default'}
						hint="Replies with token usage but no model recorded"
					/>
				</MetricGrid>
			) : null}

			<Notes
				notes={[
					...(payload?.providers?.notes ?? []),
					'Credentials are never returned by the API in any form. The hint below is the last four characters, which exists so an operator can confirm a rotation happened — not so the value can be recovered.',
				]}
			/>

			<Card title="Providers" subtitle="Credential state, runtime selection and last recorded health">
				{providers.length === 0 ? (
					<EmptyState message="No providers reported by the API" />
				) : (
					<Table columns={['Provider', 'Kind', 'Credential', 'Default', 'Models in use', 'Last health', 'Test']}>
						{providers.map((provider) => (
							<Row key={provider.provider}>
								<Cell>
									<div style={{ fontWeight: 500 }}>{provider.label}</div>
									<div style={{ fontSize: '0.68rem', color: '#9ca3af', fontFamily: 'ui-monospace, Menlo, monospace' }}>
										{provider.provider}
									</div>
								</Cell>
								<Cell muted>{provider.kind}</Cell>
								<Cell>
									{provider.credentialConfigured ? (
										<>
											<StatusBadge status="pass" label="configured" />
											<div style={{ fontSize: '0.7rem', color: '#6b7280', fontFamily: 'ui-monospace, Menlo, monospace' }}>
												{provider.maskedHint ?? '••••••••'}
											</div>
										</>
									) : (
										<StatusBadge status="not_configured" />
									)}
									{provider.credentialKey ? (
										<div style={{ fontSize: '0.66rem', color: '#9ca3af' }}>{provider.credentialKey}</div>
									) : null}
									{provider.credentialConfigured && provider.credentialSource ? (
										<div style={{ fontSize: '0.66rem', color: '#6b7280' }}>
											from {provider.credentialSource}
										</div>
									) : null}
								</Cell>
								<Cell>
									{provider.isDefault ? <StatusBadge status="active" label="runtime default" /> : <span style={{ color: '#9ca3af' }}>—</span>}
									{provider.selectionReason ? (
										<div style={{ fontSize: '0.66rem', color: '#9ca3af', maxWidth: '220px', marginTop: '0.2rem' }}>
											{provider.selectionReason}
										</div>
									) : null}
								</Cell>
								<Cell muted>
									{/* `models` is the id list the API returns as `{id, use}` pairs. Rendering it
									    with `join()` produced `[object Object]` until this reader was fixed; the
									    API's own explanation of each model is shown beside the id instead of
									    being discarded. */}
									{provider.modelDetails.length > 0 ? (
										<div style={{ fontSize: '0.72rem', maxWidth: '260px' }}>
											{provider.modelDetails.map((model) => (
												<div key={model.id}>
													<span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{model.id}</span>
													{model.use ? (
														<div style={{ fontSize: '0.66rem', color: '#9ca3af' }}>{model.use}</div>
													) : null}
												</div>
											))}
										</div>
									) : (
										'—'
									)}
								</Cell>
								<Cell>
									{provider.lastHealth ? (
										<>
											<StatusBadge status={provider.lastHealth.status} />
											<div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>
												{provider.lastHealth.latencyMs === null ? '' : `${provider.lastHealth.latencyMs} ms · `}
												{provider.lastHealth.checkedAt ? formatRelative(provider.lastHealth.checkedAt) : 'time not recorded'}
											</div>
											{provider.lastHealth.message ? (
												<div style={{ fontSize: '0.68rem', color: '#6b7280', maxWidth: '260px' }}>
													{provider.lastHealth.message}
												</div>
											) : null}
										</>
									) : (
										<span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>never tested</span>
									)}
								</Cell>
								<Cell>
									{provider.testable === false ? (
										<span style={{ fontSize: '0.7rem', color: '#9ca3af' }}>no test available</span>
									) : (
										<Link
											href={`/configuration/validate`}
											style={{ fontSize: '0.74rem', color: '#2563eb' }}
										>
											Test on validator →
										</Link>
									)}
								</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			<Card
				title="Effective routing"
				subtitle="What the running code will actually do with the current configuration"
			>
				{routingEntries.length === 0 ? (
					<EmptyState message="Routing details were not returned by the API" />
				) : (
					<Table columns={['Setting', 'Value']}>
						{routingEntries.map(([key, value]) => (
							<Row key={key}>
								<Cell mono>{key}</Cell>
								<Cell>
									{value === null || value === undefined ? (
										<span style={{ color: '#9ca3af' }}>unset</span>
									) : Array.isArray(value) ? (
										value.join(', ')
									) : typeof value === 'object' ? (
										<pre style={{ margin: 0, fontSize: '0.72rem' }}>{JSON.stringify(value)}</pre>
									) : (
										String(value)
									)}
								</Cell>
							</Row>
						))}
					</Table>
				)}
				{typeof routing?.runtimeWiring === 'object' && routing.runtimeWiring !== null ? (
					<pre style={{ marginTop: '0.75rem', fontSize: '0.72rem', background: '#f9fafb', padding: '0.6rem', borderRadius: '6px' }}>
						{JSON.stringify(routing.runtimeWiring, null, 2)}
					</pre>
				) : null}
				<Notes
					notes={[
						'Latency is the wall-clock duration of the full assistant tool loop, recorded on each assistant message. It is not a single HTTP round trip — several model calls can occur, and the total is what the user waits for.',
						'Model and token ceiling are read live by the AI service through the runtime config overlay, so changing them in Configuration takes effect on the next call in this process.',
						'Fallback model, timeout and retry count are declared in the catalog but are NOT read by the running code today. Editing them stores a value that does nothing; the Configuration page marks them “not wired”.',
					]}
					tone="warn"
				/>
			</Card>

			{metrics && metrics.byModel.length > 0 ? (
				<Card title="Model usage and cost" subtitle="From persisted per-message token counts, priced against a published rate table">
					<Table columns={['Model', 'Requests', 'Input tokens', 'Output tokens', 'Mean latency', 'Estimated cost', 'Pricing']}>
						{metrics.byModel.map((model) => (
							<Row key={model.model}>
								<Cell mono>{model.model}</Cell>
								<Cell align="right">{formatNumber(model.requests)}</Cell>
								<Cell align="right">{formatNumber(model.inputTokens)}</Cell>
								<Cell align="right">{formatNumber(model.outputTokens)}</Cell>
								<Cell align="right">
									{model.avgLatencyMs === null
										? `not timed (${formatNumber(model.latencySamples)})`
										: `${formatNumber(model.avgLatencyMs)} ms`}
								</Cell>
								<Cell align="right">{model.pricingKnown ? formatUsd(model.estimatedCostUsd) : '—'}</Cell>
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
					{metrics.byModel.some((model) => !model.pricingKnown) ? (
						<Notes
							tone="warn"
							notes={[
								'A model in use has no published price in the rate table, so its cost is excluded from the total rather than guessed. Add the rate in services/api/src/admin/pricing.ts to include it.',
							]}
						/>
					) : null}
				</Card>
			) : null}

			{metrics && metrics.byDay.length > 0 ? (
				<Card title="Requests per day (30 days)" subtitle="Days with no activity appear as zero rather than being absent">
					<div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '90px' }}>
						{metrics.byDay.map((day) => {
							const max = Math.max(...metrics.byDay.map((entry) => entry.requests), 1);
							const height = Math.max(2, Math.round((day.requests / max) * 84));
							return (
								<div
									key={day.day}
									title={`${day.day}: ${day.requests} request(s), ${day.tokens} token(s)`}
									style={{
										flex: 1,
										height: `${height}px`,
										background: day.requests > 0 ? '#6366f1' : '#e5e7eb',
										borderRadius: '2px 2px 0 0',
									}}
								/>
							);
						})}
					</div>
					<p style={{ fontSize: '0.72rem', color: '#9ca3af', margin: '0.5rem 0 0' }}>
						{metrics.byDay[0]?.day} → {metrics.byDay[metrics.byDay.length - 1]?.day}. Hover a bar for the exact
						count. Rendered as inline divs rather than a charting library so the page stays a server component.
					</p>
				</Card>
			) : null}

			{payload?.models ? (
				<Card title="Model catalog" subtitle="Reported by the API, including runtime wiring status">
					<pre style={{ margin: 0, fontSize: '0.7rem', background: '#f9fafb', padding: '0.6rem', borderRadius: '6px', maxHeight: '320px', overflow: 'auto' }}>
						{JSON.stringify(payload.models, null, 2)}
					</pre>
					<p style={{ fontSize: '0.72rem', color: '#9ca3af', margin: '0.5rem 0 0' }}>
						Last read {formatDateTime(new Date().toISOString())}. Presented as the API returns it so nothing is
						paraphrased.
					</p>
				</Card>
			) : null}
		</div>
	);
}
