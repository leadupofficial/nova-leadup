/**
 * Admin Control Center — deployment identity and safety envelope.
 *
 * This is the page that answers one question before an operator touches anything else:
 * **which deployment am I about to act on, and what is already switched off here?**
 *
 * It is deliberately not a second `/services`. That page is the diagnostic view —
 * per-service probes, dependency tests, slow queries. This one is the pre-flight check,
 * and its most important element is the banner: a production deployment must be
 * impossible to mistake for a staging one. The API computes that verdict
 * (`warnings[]` from `NODE_ENV`) and this page does not soften it.
 *
 * ## The reconciliation that is *not* here
 *
 * `/services` notes that a pending migration shows up as a mismatch between the applied
 * count and the repository's migration files. The API cannot read the repository's
 * migration directory from a deployed container — the SQL files are not shipped in the
 * runtime image — so this page shows what the database says and states plainly that the
 * expected count is not knowable from inside the process. Inventing it would be a
 * fabricated green tick on the one number that matters during a bad deploy.
 */

import Link from 'next/link';
import { getControls, getDatabaseHealth, getEnvironment, getServiceHealth } from '../../lib/api';
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
} from '../../components/ui';

export const dynamic = 'force-dynamic';

/** The environment verdict, rendered so it cannot be skimmed past. */
function VerdictBanner({
	environment,
	nodeEnv,
	isProduction,
	warnings,
}: {
	environment: string;
	nodeEnv: string | null;
	isProduction: boolean;
	warnings: string[];
}) {
	const palette = isProduction
		? { background: '#7f1d1d', border: '#991b1b', color: '#fff', accent: '#fecaca' }
		: { background: '#fffbeb', border: '#fcd34d', color: '#78350f', accent: '#92400e' };

	return (
		<div
			role="alert"
			style={{
				background: palette.background,
				border: `2px solid ${palette.border}`,
				color: palette.color,
				borderRadius: '12px',
				padding: '1.1rem 1.3rem',
				marginBottom: '1.25rem',
			}}
		>
			<div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap' }}>
				<span style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '0.04em' }}>
					{isProduction ? 'PRODUCTION' : environment.toUpperCase()}
				</span>
				<span style={{ fontSize: '0.85rem', color: palette.accent }}>
					acting environment “{environment}” · NODE_ENV “{nodeEnv ?? 'unset'}”
				</span>
			</div>
			<p style={{ margin: '0.5rem 0 0', fontSize: '0.88rem', lineHeight: 1.6 }}>
				{isProduction
					? 'Every change made from this console takes effect on real users immediately. There is no staging step between this page and production traffic.'
					: 'This is not the production deployment. Changes made here do not affect production data or production users.'}
			</p>
			{warnings.length > 0 ? (
				<ul style={{ margin: '0.6rem 0 0', paddingLeft: '1.1rem', fontSize: '0.82rem', lineHeight: 1.6 }}>
					{warnings.map((warning) => (
						<li key={warning}>{warning}</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

export default async function EnvironmentPage() {
	const result = await loadPage(async () => {
		const [environment, databaseResult, controlsResult, health] = await Promise.all([
			getEnvironment().catch(() => null),
			getDatabaseHealth().catch(() => null),
			getControls().catch(() => null),
			getServiceHealth().catch(() => null),
		]);
		return { rows: [{ environment, databaseResult, controlsResult, health }] };
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Environment" />
				<PageError
					title="Could not read the deployment identity"
					message={result.message}
					status={result.status}
					retryHref="/environment"
				/>
			</div>
		);
	}

	const payload = result.rows[0];
	if (!payload?.environment) {
		return (
			<div>
				<PageHeader title="Environment" />
				<Notes notes={['The API did not return deployment details. Nothing on this page can be shown without them.']} tone="warn" />
			</div>
		);
	}

	const environment = payload.environment;
	const database = payload.databaseResult?.database ?? null;
	const migrations = payload.databaseResult?.migrations ?? environment.migrations;
	const controls = payload.controlsResult?.controls ?? null;
	const definitions = payload.controlsResult?.definitions ?? [];
	const services = payload.health?.services ?? [];

	// `NODE_ENV` is the deployment's own statement about itself; the acting environment is
	// the header the operator sent. They can disagree — a production API reached from a
	// console labelled "staging" — and the louder of the two must win.
	const isProduction = environment.nodeEnv === 'production';
	const downgraded = controls
		? definitions
				.filter((definition) => definition.type === 'boolean' && definition.scope === 'capability')
				.filter((definition) => controls[definition.key as keyof typeof controls] === false)
		: [];

	return (
		<div>
			<PageHeader
				title="Environment"
				subtitle="Which deployment this console is talking to, and what is already switched off here"
				actions={
					<Link href="/services" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
						Service probes →
					</Link>
				}
			/>

			<VerdictBanner
				environment={environment.environment}
				nodeEnv={environment.nodeEnv}
				isProduction={isProduction}
				warnings={environment.warnings}
			/>

			<Card title="Deployment identity" subtitle="Reported by the running API process itself, not configured here">
				<MetricGrid minWidth={170}>
					<Metric label="Acting environment" value={environment.environment} />
					<Metric
						label="NODE_ENV"
						value={environment.nodeEnv ?? 'unset'}
						tone={isProduction ? 'warn' : 'default'}
					/>
					<Metric label="Node" value={environment.self.nodeVersion} />
					<Metric label="Runner pid" value={environment.self.pid} />
					<Metric
						label="Uptime"
						value={
							environment.self.uptimeSeconds < 120
								? `${environment.self.uptimeSeconds}s`
								: `${Math.floor(environment.self.uptimeSeconds / 60)} min`
						}
						hint={environment.self.uptimeSeconds < 120 ? 'recently restarted or recently deployed' : ''}
					/>
					<Metric label="RSS memory" value={`${environment.self.memoryRssMb} MB`} />
					<Metric label="Heap used" value={`${environment.self.memoryHeapUsedMb} MB`} />
					<Metric
						label="Secret store"
						value={environment.secretStore.ready ? 'ready' : 'NOT CONFIGURED'}
						tone={environment.secretStore.ready ? 'good' : 'bad'}
						hint={environment.secretStore.ready ? '' : 'secrets cannot be written or read'}
					/>
				</MetricGrid>
			</Card>

			<h2 style={sectionHeading}>What is switched off here</h2>
			<Card
				title="Live capability switches on this deployment"
				subtitle="Read from the same control store the request path consults, so this is the state that is actually in force"
				action={
					<Link href="/maintenance" style={{ fontSize: '0.78rem', color: '#2563eb' }}>
						Change a switch →
					</Link>
				}
			>
				{controls ? (
					<>
						<MetricGrid minWidth={200}>
							<Metric
								label="Maintenance mode"
								value={controls.maintenanceMode ? 'ON — requests refused' : 'off'}
								tone={controls.maintenanceMode ? 'bad' : 'good'}
								hint={controls.maintenanceMode ? controls.maintenanceMessage : ''}
							/>
							<Metric
								label="Capabilities disabled"
								value={downgraded.length}
								tone={downgraded.length > 0 ? 'warn' : 'good'}
							/>
							<Metric label="Operator note" value={controls.operatorNote || '—'} />
						</MetricGrid>

						{downgraded.length === 0 ? (
							<p style={{ fontSize: '0.82rem', color: '#374151', margin: '1rem 0 0' }}>
								Every capability switch is on. Nothing is being withheld from users by the control plane
								on this deployment.
							</p>
						) : (
							<Table columns={['Capability', 'State', 'What it withholds']}>
								{downgraded.map((definition) => (
									<Row key={definition.key}>
										<Cell mono>{definition.key}</Cell>
										<Cell>
											<StatusBadge status="disabled" label="off" />
										</Cell>
										<Cell muted>{definition.description}</Cell>
									</Row>
								))}
							</Table>
						)}
					</>
				) : (
					<Notes
						notes={[
							'The control store could not be read. That is not the same as "nothing is disabled" — the state is unknown, and a page that showed all-green here would be guessing.',
						]}
						tone="warn"
					/>
				)}
			</Card>

			<h2 style={sectionHeading}>Data plane</h2>
			<Card title="Database" subtitle="Statistics for the database this API is connected to">
				{database ? (
					<MetricGrid minWidth={180}>
						<Metric label="Size" value={database.sizePretty} hint={`${formatNumber(database.sizeBytes)} bytes`} />
						<Metric
							label="Connections"
							value={`${database.connections}/${database.maxConnections}`}
							tone={database.connections / Math.max(database.maxConnections, 1) > 0.8 ? 'warn' : 'default'}
						/>
						<Metric label="Tables" value={database.tableCount} />
					</MetricGrid>
				) : (
					<Notes
						notes={[
							'Database statistics could not be read. This is not a liveness probe — the API can still be serving traffic while this panel is empty.',
						]}
						tone="warn"
					/>
				)}
			</Card>

			<Card
				title="Schema migrations"
				subtitle={`Read from drizzle.__drizzle_migrations — state: ${migrations.state}`}
				action={
					<Link href="/services" style={{ fontSize: '0.78rem', color: '#2563eb' }}>
						Database health →
					</Link>
				}
			>
				<MetricGrid minWidth={200}>
					<Metric
						label="Applied migrations"
						value={migrations.state === 'unknown' ? null : migrations.applied}
						tone={migrations.state === 'unknown' ? 'warn' : 'default'}
					/>
					<Metric
						label="Latest applied"
						value={migrations.latestAppliedAt ? formatDateTime(migrations.latestAppliedAt) : 'none recorded'}
					/>
				</MetricGrid>
				<Notes
					notes={[
						migrations.state === 'unknown'
							? 'Migration state could not be read from drizzle.__drizzle_migrations, so the applied count is unknown rather than zero.'
							: 'How many migrations *should* be applied is not shown: the SQL files live in the repository and are not shipped into the runtime container, so the API cannot count them. Compare this number with `packages/database/drizzle/*.sql` from the deployment instead of trusting a number this process invented.',
					]}
					tone={migrations.state === 'unknown' ? 'warn' : 'info'}
				/>
			</Card>

			<h2 style={sectionHeading}>Topology</h2>
			<Card
				title="Service targets this API knows about"
				subtitle={`Source: ${environment.services.source}`}
				action={
					<Link href="/services" style={{ fontSize: '0.78rem', color: '#2563eb' }}>
						Probe them →
					</Link>
				}
			>
				{environment.services.targets.length === 0 ? (
					<EmptyState
						message="No service targets discovered"
						hint="Set NOVA_SERVICE_TARGETS as name=host:port,name=host:port to declare them."
					/>
				) : (
					<Table columns={['Service', 'Host', 'Port', 'Last probe']}>
						{environment.services.targets.map((target) => {
							const probe = services.find((service) => service.name === target.name);
							return (
								<Row key={`${target.name}-${target.port}`}>
									<Cell>{target.name}</Cell>
									<Cell mono>{target.host}</Cell>
									<Cell align="right" muted>
										{target.port}
									</Cell>
									<Cell>
										{probe ? (
											<>
												<StatusBadge status={probe.status} />
												{probe.latencyMs !== null ? (
													<span style={{ fontSize: '0.72rem', color: '#6b7280', marginLeft: '0.4rem' }}>
														{probe.latencyMs} ms
													</span>
												) : null}
											</>
										) : (
											<span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>
												no probe result — the health check did not cover this target
											</span>
										)}
									</Cell>
								</Row>
							);
						})}
					</Table>
				)}
			</Card>

			<Notes
				notes={[
					'Container CPU, memory and disk for sibling services are not shown: an in-process API cannot read another container\'s resource usage without Docker socket access, which would put host control behind a web request.',
					'This page is read-only by design. The controls themselves live on Maintenance & Safeguards, where every change requires a reason and writes an audit row; duplicating the buttons here would give two paths to the same mutation with different affordances.',
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
