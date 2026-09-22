/**
 * Admin Control Center — dashboard.
 *
 * The landing page. Every tile comes from `GET /admin/dashboard`, which composes the
 * same functions the detail pages use, so a number here and the same number on its
 * detail page cannot disagree.
 *
 * Three things this page refuses to do, all of which the previous console did:
 *
 *   1. It does not render a failed load as an empty dashboard. `PageError` shows the
 *      actual status and a retry.
 *   2. It does not print `0` for a metric the platform cannot compute. `Metric`
 *      renders "NOT AVAILABLE" with the reason and the instrumentation that would fix
 *      it — for example, "reminders triggered" is not persisted anywhere, so it is
 *      reported as unknown rather than as zero. AI latency and the STT/TTS counters
 *      used to be in that list and no longer are: both are instrumented now, and the
 *      tiles show real numbers with the sample coverage stated.
 *   3. It does not describe a percentage rollout it cannot see. The device count is
 *      unknown rather than zero when no client has ever registered, and the page says
 *      which endpoint populates it.
 */

import Link from 'next/link';
import { getDashboard, type DashboardPayload } from '../lib/api';
import { loadPage } from '../lib/page-data';
import { PageError } from '../components/PageError';
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
	formatDuration,
	formatNumber,
	formatRelative,
	formatUsd,
} from '../components/ui';
import { ControlBanner } from './ControlBanner';

export const dynamic = 'force-dynamic';

function providerTone(status: string): 'good' | 'warn' | 'bad' | 'default' {
	if (status === 'pass') return 'good';
	if (status === 'degraded') return 'warn';
	if (status === 'fail') return 'bad';
	return 'default';
}

export default async function DashboardPage() {
	const result = await loadPage<DashboardPayload>(() =>
		getDashboard().then((data) => ({ rows: [data] })),
	);

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Dashboard" />
				<PageError
					title="Could not load the dashboard"
					message={result.message}
					status={result.status}
					retryHref="/"
				/>
			</div>
		);
	}

	const dashboard = result.rows[0];
	if (!dashboard) {
		return (
			<div>
				<PageHeader title="Dashboard" />
				<PageError
					title="Empty dashboard response"
					message="The admin API answered successfully but returned no payload."
					status={null}
					retryHref="/"
				/>
			</div>
		);
	}

	const { platform, activity, ai, reliability, providers, controls } = dashboard;

	return (
		<div>
			<PageHeader
				title="Control Center"
				subtitle={
					<>
						Live platform state as of {new Date(dashboard.generatedAt).toLocaleTimeString('en-IN')}.{' '}
						<Link href="/" style={{ color: '#2563eb' }}>
							Refresh
						</Link>
					</>
				}
			/>

			{/* Emergency state is the first thing on the page: an operator arriving
			    during an incident should not have to hunt for why things are off. */}
			<ControlBanner controls={controls} />

			<h2 style={sectionHeading}>Platform</h2>
			<MetricGrid>
				<Metric label="Total users" value={platform.totalUsers} />
				<Metric label="Active (verified)" value={platform.verifiedUsers} />
				<Metric label="Suspended" value={platform.disabledUsers} tone={platform.disabledUsers > 0 ? 'warn' : 'default'} />
				<Metric label="New today" value={platform.newUsersToday} />
				<Metric label="New this week" value={platform.newUsersThisWeek} />
				<Metric label="New this month" value={platform.newUsersThisMonth} />
				<Metric label="Organizations" value={platform.totalOrganizations} />
				<Metric
					label="Active sessions"
					value={platform.activeSessions}
					hint={`${formatNumber(platform.distinctSessionUsers)} distinct users`}
				/>
				<Metric label="DAU" metric={platform.dau} />
				<Metric label="WAU" metric={platform.wau} />
				<Metric label="MAU" metric={platform.mau} />
				<Metric label="Registered devices" metric={platform.devices} />
			</MetricGrid>

			<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1rem' }}>
				<Card title="Languages" subtitle="Users by locale">
					{platform.locales.length === 0 ? (
						<EmptyState message="No locale data." />
					) : (
						<Table columns={['Locale', 'Users']}>
							{platform.locales.slice(0, 8).map((row) => (
								<Row key={row.locale}>
									<Cell mono>{row.locale}</Cell>
									<Cell align="right">{formatNumber(row.count)}</Cell>
								</Row>
							))}
						</Table>
					)}
				</Card>

				<Card
					title="Devices by platform"
					subtitle="Reported by the client to POST /api/v1/device/register"
				>
					{platform.platforms.length === 0 ? (
						<EmptyState
							message="No device has registered yet"
							hint="The registration endpoint exists and the app calls it after sign-in; an empty table means no client has launched since that was added."
						/>
					) : (
						<Table columns={['Platform', 'Devices']}>
							{platform.platforms.map((row) => (
								<Row key={row.platform}>
									<Cell>{row.platform}</Cell>
									<Cell align="right">{formatNumber(row.count)}</Cell>
								</Row>
							))}
						</Table>
					)}
				</Card>

				<Card title="App version adoption" subtitle="Which builds are actually in the field — what a force-update decision needs">
					{platform.appVersions.length === 0 ? (
						<EmptyState message="No app version reported yet" />
					) : (
						<Table columns={['App version', 'Devices']}>
							{platform.appVersions.map((row) => (
								<Row key={row.version}>
									<Cell mono>{row.version}</Cell>
									<Cell align="right">{formatNumber(row.count)}</Cell>
								</Row>
							))}
						</Table>
					)}
				</Card>

				<Card title="OS version adoption" subtitle="What the Android-version question on the dashboard actually needed">
					{platform.platformVersions.length === 0 ? (
						<EmptyState message="No OS version reported yet" />
					) : (
						<Table columns={['OS version', 'Devices']}>
							{platform.platformVersions.map((row) => (
								<Row key={row.version}>
									<Cell mono>{row.version}</Cell>
									<Cell align="right">{formatNumber(row.count)}</Cell>
								</Row>
							))}
						</Table>
					)}
				</Card>
			</div>

			<h2 style={sectionHeading}>NOVA activity</h2>
			<MetricGrid>
				<Metric label="Conversations today" value={activity.conversationsToday} />
				<Metric label="Conversations (all time)" value={activity.conversationsTotal} />
				<Metric label="Voice conversations" value={activity.voiceConversations} />
				<Metric label="Text conversations" value={activity.textConversations} />
				<Metric label="AI replies" value={activity.aiRequests} />
				<Metric label="Tokens used" value={activity.aiTotalTokens} />
				<Metric label="AI latency (30d mean)" metric={activity.aiLatency} />
				<Metric label="STT requests" metric={activity.sttRequests} hint={`${formatNumber(activity.sttSeconds)} s transcribed`} />
				<Metric label="TTS requests" metric={activity.ttsRequests} hint={`${formatNumber(activity.ttsCharacters)} characters spoken`} />
				<Metric label="Tasks created today" value={activity.tasksCreatedToday} />
				<Metric label="Tasks pending" value={activity.tasksPending} tone={activity.tasksOverdue > 0 ? 'warn' : 'default'} hint={`${formatNumber(activity.tasksOverdue)} overdue`} />
				<Metric label="Tasks completed" value={activity.tasksCompleted} />
				<Metric label="Reminders upcoming" value={activity.remindersUpcoming} />
				<Metric label="Reminders overdue" value={activity.remindersOverdue} tone={activity.remindersOverdue > 0 ? 'warn' : 'default'} />
				{/* Labelled "acknowledged", not "executed": the writer records the user opening the
				    notification, and the OS alarm that actually fires is on the device. The metric's
				    own caveat carries the rest. */}
				<Metric label="Reminders acknowledged" metric={activity.remindersTriggered} />
				<Metric label="Memory entries" value={activity.memoriesTotal} />
				<Metric label="Notifications" value={activity.notificationsTotal} />
				<Metric label="Voice seconds (30d)" value={activity.voiceSeconds} />
			</MetricGrid>

			<h2 style={sectionHeading}>AI</h2>
			<MetricGrid>
				<Metric label="Requests today" value={ai.requestsToday} />
				<Metric label="Requests this week" value={ai.requestsThisWeek} />
				<Metric label="Requests this month" value={ai.requestsThisMonth} />
				<Metric label="Total tokens" value={ai.totalTokens} />
				<Metric label="Estimated cost" value={formatUsd(ai.estimatedCostUsd)} hint="List-price estimate, not billed" />
				<Metric label="AI latency (mean)" metric={ai.latency} />
				<Metric
					label="AI latency (p95)"
					value={ai.latencyP95Ms === null ? null : `${formatNumber(ai.latencyP95Ms)} ms`}
					hint="The tail a user actually notices"
				/>
			</MetricGrid>

			<Card
				title="Model usage"
				subtitle="Token counts come from persisted per-message usage; cost is an estimate"
				action={
					<Link href="/ai" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
						AI control center →
					</Link>
				}
			>
				{ai.byModel.length === 0 ? (
					<EmptyState message="No AI requests recorded yet." />
				) : (
					<Table columns={['Model', 'Requests', 'Input tokens', 'Output tokens', 'Mean latency', 'Est. cost']}>
						{ai.byModel.map((model) => (
							<Row key={model.model}>
								<Cell mono>{model.model}</Cell>
								<Cell align="right">{formatNumber(model.requests)}</Cell>
								<Cell align="right">{formatNumber(model.inputTokens)}</Cell>
								<Cell align="right">{formatNumber(model.outputTokens)}</Cell>
								<Cell align="right">
									{model.avgLatencyMs === null ? (
										<span style={{ color: '#9ca3af', fontSize: '0.78rem' }}>
											not timed ({formatNumber(model.latencySamples)} samples)
										</span>
									) : (
										`${formatNumber(model.avgLatencyMs)} ms`
									)}
								</Cell>
								<Cell align="right">
									{model.pricingKnown ? (
										formatUsd(model.estimatedCostUsd)
									) : (
										<span style={{ color: '#9ca3af', fontSize: '0.78rem' }}>no price on file</span>
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
							'One or more models in use have no published price in the rate table, so their cost is excluded from the estimate rather than guessed. Add the rate in services/api/src/admin/pricing.ts to include it.',
						]}
					/>
				) : null}
			</Card>

			<h2 style={sectionHeading}>System health</h2>
			<Card
				title="Dependencies and providers"
				subtitle="Recorded connectivity results. Use Services → Test all connections to re-verify."
				action={
					<Link href="/services" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
						Service health →
					</Link>
				}
			>
				{providers.length === 0 ? (
					<EmptyState
						message="No provider health has been recorded"
						hint="Open Services and run “Test all connections” to populate this."
					/>
				) : (
					<Table columns={['Provider', 'Kind', 'Status', 'Latency', 'Detail', 'Checked']}>
						{providers.map((provider) => (
							<Row key={provider.provider}>
								<Cell>{provider.provider}</Cell>
								<Cell muted>{provider.kind}</Cell>
								<Cell>
									<StatusBadge status={provider.status} />
								</Cell>
								<Cell align="right" muted>
									{provider.latencyMs === null ? '—' : `${provider.latencyMs} ms`}
								</Cell>
								<Cell muted>{provider.message}</Cell>
								<Cell muted>{formatRelative(provider.checkedAt)}</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			<h2 style={sectionHeading}>Reliability</h2>
			<MetricGrid>
				<Metric label="Open incidents" value={reliability.incidentsOpen} tone={reliability.incidentsOpen > 0 ? 'bad' : 'good'} />
				<Metric label="Total incidents" value={reliability.incidentsTotal} />
				<Metric label="Tool executions" value={reliability.toolExecutionsTotal} />
				<Metric
					label="Tool failure rate"
					value={reliability.toolFailureRate === null ? null : `${(reliability.toolFailureRate * 100).toFixed(1)}%`}
				/>
				<Metric label="Job executions" value={reliability.jobExecutionsTotal} />
				<Metric label="Dead-letter jobs" value={reliability.deadLetterCount} tone={reliability.deadLetterCount > 0 ? 'bad' : 'default'} />
				<Metric label="Admin actions (24h)" value={reliability.adminActionsToday} />
				<Metric label="Refused admin actions (24h)" value={reliability.auditDenialsToday} tone={reliability.auditDenialsToday > 0 ? 'warn' : 'default'} />
			</MetricGrid>

			<Notes
				notes={[
					'Uptime, CPU, memory and disk for sibling services are not shown: this API cannot read another container\'s resource usage without Docker socket access, which would put host control behind a web request.',
					'AI latency and the STT/TTS counters are measured, not estimated: latency comes from `conversation_messages.duration_ms` (with the untimed share stated) and the counters from `voice-usage.ts`, which meters both the REST speech routes and the realtime voice session. A tile that cannot be computed still says NOT AVAILABLE and names the instrumentation instead of showing 0.',
					'Device, app-version and OS-version figures come from device registration (`POST /api/v1/device/register`), which the app calls after sign-in. Until a client reports, those tables are empty rather than the feature missing.',
					`Dashboard composed from ${formatNumber(Object.keys(platform).length)} platform, ${formatNumber(Object.keys(activity).length)} activity and ${formatNumber(ai.byModel.length)} model signals. Individual query latency is not measured.`,
				]}
			/>
		</div>
	);
}

const sectionHeading = {
	fontSize: '0.78rem',
	fontWeight: 700,
	textTransform: 'uppercase' as const,
	letterSpacing: '0.06em',
	color: '#6b7280',
	margin: '1.5rem 0 0.6rem',
};

