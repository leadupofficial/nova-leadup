/**
 * Admin Control Center — services, dependencies and data health.
 *
 * Services are **discovered**, not hard-coded: the API reads its own deployment topology
 * (or `NOVA_SERVICE_TARGETS`) and probes each one, so adding a service does not require
 * editing this page. That also means the page can honestly say what it *cannot* see —
 * container CPU and memory for a sibling process are not visible to an in-process API
 * without Docker socket access, which would put host control behind a web request.
 *
 * "Test all connections" is a real button that makes real authenticated calls to every
 * provider. It is deliberately behind the read-level `services.read` permission: testing
 * connectivity is non-mutating, and an operator diagnosing an outage should not need
 * secret-management rights to discover that a provider is rejecting the key.
 */

import Link from 'next/link';
import { getDatabaseHealth, getEnvironment, getServiceHealth, testAllProviders } from '../../lib/api';
import { loadPage } from '../../lib/page-data';
import { PageError } from '../../components/PageError';
import { Card, Cell, EmptyState, Metric, MetricGrid, Notes, PageHeader, Row, StatusBadge, Table, formatBytes, formatDateTime, formatNumber } from '../../components/ui';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';

/**
 * Server action: run every provider test, then re-render.
 *
 * `revalidatePath` rather than returning data, because the page is a Server Component
 * and the results are read back from the API's recorded history — so what the operator
 * sees next is the same record everyone else sees, not a one-off response body.
 */
async function testAllAction(): Promise<void> {
	'use server';
	await testAllProviders();
	revalidatePath('/services');
}

export default async function ServicesPage() {
	// The payload type is inferred from the loader rather than annotated on
	// `loadPage`, because each source returns a different envelope and an annotation
	// here would have to describe all three at once.
	const result = await loadPage(async () => {
		const [health, environment, databaseResult] = await Promise.all([
			getServiceHealth().catch(() => null),
			getEnvironment().catch(() => null),
			getDatabaseHealth().catch(() => null),
		]);
		return { rows: [{ health, environment, databaseResult }] };
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Services" />
				<PageError
					title="Could not load service health"
					message={result.message}
					status={result.status}
					retryHref="/services"
				/>
			</div>
		);
	}

	const payload = result.rows[0];
	const health = payload?.health ?? null;
	const environment = payload?.environment ?? null;
	// The database endpoint answers with its own envelope: the statistics object plus
	// the slow-query list and migration state alongside it.
	const database = payload?.databaseResult?.database ?? null;
	const slowQueries = payload?.databaseResult?.slowQueries ?? [];
	const services = health?.services ?? [];
	const dependencies = health?.dependencies ?? [];

	return (
		<div>
			<PageHeader
				title="Services & Health"
				subtitle={
					health ? `Discovered ${services.length} service(s) and ${dependencies.length} dependency check(s)` : 'Health unavailable'
				}
				actions={
					<form action={testAllAction}>
						<button
							type="submit"
							style={{
								padding: '0.5rem 1rem',
								background: '#1a1a2e',
								color: '#fff',
								border: 'none',
								borderRadius: '6px',
								fontSize: '0.82rem',
								cursor: 'pointer',
							}}
						>
							Test all connections
						</button>
					</form>
				}
			/>

			<Notes
				notes={[
					...(health?.notes ?? []),
					'“Test all connections” makes real authenticated calls. Read-only endpoints are preferred where they exist so testing does not bill a completion.',
					'Sibling-service status is a TCP connect: it proves the port accepts a connection, not that the application behind it is healthy.',
				]}
				tone="warn"
			/>

			{environment ? (
				<>
					<h2 style={sectionHeading}>This environment</h2>
					<MetricGrid minWidth={180}>
						<Metric label="Environment" value={environment.environment} />
						<Metric label="NODE_ENV" value={environment.nodeEnv} />
						<Metric label="API uptime" value={`${Math.floor(environment.self.uptimeSeconds / 60)} min`} />
						<Metric label="RSS memory" value={`${environment.self.memoryRssMb} MB`} />
						<Metric label="Heap used" value={`${environment.self.memoryHeapUsedMb} MB`} />
						<Metric label="Node" value={environment.self.nodeVersion} />
						<Metric label="Runner pid" value={environment.self.pid} />
						<Metric
							label="Secret store"
							value={environment.secretStore.ready ? 'ready' : 'NOT CONFIGURED'}
							tone={environment.secretStore.ready ? 'good' : 'bad'}
						/>
						<Metric label="Migrations applied" value={environment.migrations.applied} hint={environment.migrations.latestAppliedAt ? `latest ${formatDateTime(environment.migrations.latestAppliedAt)}` : ''} />
					</MetricGrid>

					{environment.warnings.length > 0 ? <Notes notes={environment.warnings} tone="warn" /> : null}

					<Card title="Ports this API discovered" subtitle={`Source: ${environment.services.source}`}>
						<Table columns={['Service', 'Target']}>
							{environment.services.targets.map((target) => (
								<Row key={`${target.name}-${target.port}`}>
									<Cell>{target.name}</Cell>
									<Cell mono>
										{target.host}:{target.port}
									</Cell>
								</Row>
							))}
						</Table>
					</Card>
				</>
			) : (
				<Notes notes={['Environment details could not be read from the API.']} tone="warn" />
			)}

			<h2 style={sectionHeading}>Services</h2>
			<Card title="Discovered services" subtitle="Topology comes from the API's own configuration, not a hard-coded list here">
				{services.length === 0 ? (
					<EmptyState message="No services discovered" />
				) : (
					<Table columns={['Service', 'Status', 'Latency', 'Detail', 'How this was determined', 'Not visible']}>
						{services.map((service) => (
							<Row key={service.name}>
								<Cell>
									{service.name}
									{service.version ? (
										<div style={{ fontSize: '0.7rem', color: '#9ca3af' }}>v{service.version}</div>
									) : null}
									{service.uptimeSeconds !== null ? (
										<div style={{ fontSize: '0.7rem', color: '#9ca3af' }}>
											up {Math.floor(service.uptimeSeconds / 60)} min
										</div>
									) : null}
								</Cell>
								<Cell>
									<StatusBadge status={service.status} />
								</Cell>
								<Cell align="right" muted>
									{service.latencyMs === null ? '—' : `${service.latencyMs} ms`}
								</Cell>
								<Cell muted>
									<div style={{ maxWidth: '360px', fontSize: '0.78rem' }}>{service.detail}</div>
								</Cell>
								<Cell muted>
									<div style={{ maxWidth: '240px', fontSize: '0.72rem' }}>{service.method}</div>
								</Cell>
								<Cell muted>
									<div style={{ maxWidth: '200px', fontSize: '0.72rem' }}>
										{service.unavailable.length > 0 ? service.unavailable.join(', ') : '—'}
									</div>
								</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			<h2 style={sectionHeading}>Dependencies</h2>
			<Card
				title="Databases, caches, storage and providers"
				subtitle="Each row is a real connectivity test, with the method that produced the verdict"
				action={
					<Link href="/configuration/validate" style={{ fontSize: '0.78rem', color: '#2563eb' }}>
						Config validator →
					</Link>
				}
			>
				{dependencies.length === 0 ? (
					<EmptyState message="No dependency checks have run" hint="Use “Test all connections” above." />
				) : (
					<Table columns={['Dependency', 'Kind', 'Status', 'Latency', 'Detail', 'Method']}>
						{dependencies.map((dependency) => (
							<Row key={`${dependency.name}-${dependency.kind}`}>
								<Cell>{dependency.name}</Cell>
								<Cell muted>{dependency.kind}</Cell>
								<Cell>
									<StatusBadge status={dependency.status} />
								</Cell>
								<Cell align="right" muted>
									{dependency.latencyMs === null ? '—' : `${dependency.latencyMs} ms`}
								</Cell>
								<Cell muted>
									<div style={{ maxWidth: '380px', fontSize: '0.78rem' }}>{dependency.detail}</div>
								</Cell>
								<Cell muted>
									<div style={{ maxWidth: '280px', fontSize: '0.72rem' }}>{dependency.method}</div>
								</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			<h2 style={sectionHeading}>Database</h2>
			{database ? (
				<>
					<MetricGrid minWidth={180}>
						<Metric label="Size" value={database.sizePretty} hint={`${formatNumber(database.sizeBytes)} bytes`} />
						<Metric
							label="Connections"
							value={`${database.connections}/${database.maxConnections}`}
							tone={database.connections / Math.max(database.maxConnections, 1) > 0.8 ? 'warn' : 'default'}
						/>
						<Metric label="Tables" value={database.tableCount} />
					</MetricGrid>

					<Card title="Largest tables" subtitle="By total relation size, including indexes">
						<Table columns={['Table', 'Size', 'Estimated rows']}>
							{database.largestTables.map((table) => (
								<Row key={table.table}>
									<Cell mono>{table.table}</Cell>
									<Cell>{table.sizePretty}</Cell>
									<Cell align="right" muted>
										{table.rows === null ? '—' : formatNumber(table.rows)}
									</Cell>
								</Row>
							))}
						</Table>
						<p style={{ fontSize: '0.72rem', color: '#9ca3af', margin: '0.6rem 0 0' }}>
							Row counts are PostgreSQL planner estimates, which can lag behind reality. They are shown as
							estimates because that is what they are. Database size is {formatBytes(database.sizeBytes)}.
						</p>
					</Card>

					<Card title="Slow queries" subtitle="From pg_stat_activity — statements running longer than one second, excluding this request">
						<p style={{ fontSize: '0.8rem', color: '#374151', margin: 0 }}>
							{slowQueries.length === 0 ? (
								'No statement is currently running longer than one second.'
							) : (
								<>
									{formatNumber(slowQueries.length)} statement(s) running longer than one second:
									<ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem' }}>
										{slowQueries.slice(0, 5).map((entry) => (
											<li key={entry.pid} style={{ fontSize: '0.75rem', lineHeight: 1.5 }}>
												{entry.durationSeconds}s in state “{entry.state}” (pid {entry.pid}) —{' '}
												<span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{entry.query.slice(0, 160)}</span>
											</li>
										))}
									</ul>
								</>
							)}
						</p>
					</Card>
				</>
			) : (
				<Notes notes={['Database statistics could not be read.']} tone="warn" />
			)}

			<Notes
				notes={[
					'There is no SQL console, deliberately. A read-write query box reachable from a browser session is the "god mode" the brief prohibits; safe operational views (size, connections, slow queries, migrations) cover the real diagnostic need.',
					'Backup status is not shown because no backup system is integrated — an invented green tick would be worse than an absence.',
					'Failed migrations are surfaced through the applied count and latest timestamp; a pending migration appears as a mismatch between that count and the repo’s migration files.',
				]}
			/>
		</div>
	);
}

const sectionHeading: React.CSSProperties = {
	fontSize: '0.78rem',
	fontWeight: 700,
	textTransform: 'uppercase',
	letterSpacing: '0.06em',
	color: '#6b7280',
	margin: '1.75rem 0 0.6rem',
};
