/**
 * Admin Control Center — analytics.
 *
 * Every figure comes from the same metric functions the dashboard uses, so a number here
 * and the same number on the dashboard cannot disagree. The three-state contract is
 * visible throughout: a value, a value with a caveat, or NOT AVAILABLE with the
 * instrumentation it would need.
 */

import Link from 'next/link';
import { getActivityMetrics, getAiMetrics, getPlatformMetrics, getReliabilityMetrics } from '../../lib/api';
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

export default async function AnalyticsPage() {
	const result = await loadPage(async () => {
		const [platform, activity, ai, reliability] = await Promise.all([
			getPlatformMetrics(),
			getActivityMetrics(),
			getAiMetrics(30),
			getReliabilityMetrics(),
		]);
		return { rows: [{ platform, activity, ai, reliability }] };
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Analytics" />
				<PageError
					title="Could not load analytics"
					message={result.message}
					status={result.status}
					retryHref="/analytics"
				/>
			</div>
		);
	}

	const { platform, activity, ai, reliability } = result.rows[0];

	return (
		<div>
			<PageHeader
				title="Analytics"
				subtitle="Real production metrics. Anything the platform cannot compute is labelled rather than shown as zero."
				actions={
					<Link href="/cost" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
						Cost control →
					</Link>
				}
			/>

			<h2 style={sectionHeading}>Users</h2>
			<MetricGrid minWidth={170}>
				<Metric label="Total users" value={platform.totalUsers} />
				<Metric label="Verified" value={platform.verifiedUsers} />
				<Metric label="Suspended" value={platform.disabledUsers} />
				<Metric label="New today" value={platform.newUsersToday} />
				<Metric label="New this week" value={platform.newUsersThisWeek} />
				<Metric label="New this month" value={platform.newUsersThisMonth} />
				<Metric label="DAU" metric={platform.dau} />
				<Metric label="WAU" metric={platform.wau} />
				<Metric label="MAU" metric={platform.mau} />
				<Metric label="Active sessions" value={platform.activeSessions} />
				<Metric label="Registered devices" metric={platform.devices} />
			</MetricGrid>

			<Card title="Distribution" subtitle="From stored user attributes — geographic distribution is not available because the API receives no location signal">
				<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1rem' }}>
					<div>
						<h3 style={subHeading}>Languages</h3>
						{platform.locales.length === 0 ? (
							<EmptyState message="No locale data" />
						) : (
							<Table columns={['Locale', 'Users']}>
								{platform.locales.map((row) => (
									<Row key={row.locale}>
										<Cell mono>{row.locale}</Cell>
										<Cell align="right">{formatNumber(row.count)}</Cell>
									</Row>
								))}
							</Table>
						)}
					</div>
					<div>
						<h3 style={subHeading}>Timezones</h3>
						{platform.timezones.length === 0 ? (
							<EmptyState message="No timezone data" />
						) : (
							<Table columns={['Timezone', 'Users']}>
								{platform.timezones.slice(0, 10).map((row) => (
									<Row key={row.timezone}>
										<Cell mono>{row.timezone}</Cell>
										<Cell align="right">{formatNumber(row.count)}</Cell>
									</Row>
								))}
							</Table>
						)}
					</div>
				</div>
			</Card>

			<h2 style={sectionHeading}>Assistant activity</h2>
			<MetricGrid minWidth={170}>
				<Metric label="Conversations today" value={activity.conversationsToday} />
				<Metric label="Voice conversations" value={activity.voiceConversations} />
				<Metric label="Text conversations" value={activity.textConversations} />
				<Metric label="Messages" value={activity.messagesTotal} />
				<Metric label="Tasks created today" value={activity.tasksCreatedToday} />
				<Metric label="Tasks completed" value={activity.tasksCompleted} />
				<Metric label="Tasks overdue" value={activity.tasksOverdue} tone={activity.tasksOverdue > 0 ? 'warn' : 'default'} />
				<Metric label="Reminders upcoming" value={activity.remindersUpcoming} />
				<Metric label="Reminders overdue" value={activity.remindersOverdue} tone={activity.remindersOverdue > 0 ? 'warn' : 'default'} />
				<Metric label="Reminders acknowledged" metric={activity.remindersTriggered} />
				<Metric label="Follow-ups / notifications" value={activity.notificationsTotal} />
				<Metric label="Memory entries" value={activity.memoriesTotal} />
				<Metric label="Tool executions" value={activity.toolExecutionsTotal} />
				<Metric label="Voice seconds" value={activity.voiceSeconds} />
			</MetricGrid>

			<Card
				title="Completion and follow-through"
				subtitle="Derived from task status, which is the only completion signal the platform stores"
			>
				<Table columns={['Measure', 'Value', 'Note']}>
					<Row>
						<Cell>Task completion rate</Cell>
						<Cell>
							{activity.tasksTotal > 0
								? `${((activity.tasksCompleted / activity.tasksTotal) * 100).toFixed(1)}%`
								: '—'}
						</Cell>
						<Cell muted>
							{formatNumber(activity.tasksCompleted)} of {formatNumber(activity.tasksTotal)} tasks
						</Cell>
					</Row>
					<Row>
						<Cell>Overdue share of open tasks</Cell>
						<Cell>
							{activity.tasksPending > 0
								? `${((activity.tasksOverdue / activity.tasksPending) * 100).toFixed(1)}%`
								: '—'}
						</Cell>
						<Cell muted>Overdue among tasks not yet completed</Cell>
					</Row>
					<Row>
						<Cell>Reminder acknowledgement count</Cell>
						<Cell>
							{activity.remindersTriggered.value === null ? (
								<StatusBadge status="unknown" label="NOT AVAILABLE" />
							) : (
								formatNumber(activity.remindersTriggered.value)
							)}
						</Cell>
						<Cell muted>
							{/* Not a delivery rate, and not called one. The OS fires the alarm with the
							    app closed, so the server only ever learns that the user opened the
							    notification; a delivery *rate* would need a denominator nobody records. */}
							{activity.remindersTriggered.caveat ??
								'Counts reminders a user opened the notification for. A rate would need a delivery count, which the platform does not have.'}
						</Cell>
					</Row>
					<Row>
						<Cell>Proactive follow-through</Cell>
						<Cell>
							<StatusBadge status="unknown" label="NOT AVAILABLE" />
						</Cell>
						<Cell muted>
							There is no proactive-event table, and the notification row does not record whether the user
							acted on it.
						</Cell>
					</Row>
				</Table>
			</Card>

			<h2 style={sectionHeading}>AI</h2>
			<MetricGrid minWidth={170}>
				<Metric label="Requests (30d)" value={ai.requestsThisMonth} />
				<Metric label="Requests today" value={ai.requestsToday} />
				<Metric label="Total tokens" value={ai.totalTokens} />
				<Metric label="Estimated cost" value={formatUsd(ai.estimatedCostUsd)} />
				<Metric label="AI latency (mean)" metric={activity.aiLatency} />
				<Metric
					label="AI latency (p95)"
					value={ai.latencyP95Ms === null ? null : `${formatNumber(ai.latencyP95Ms)} ms`}
				/>
				<Metric label="STT requests" metric={activity.sttRequests} hint={`${formatNumber(activity.sttSeconds)} s transcribed`} />
				<Metric label="TTS requests" metric={activity.ttsRequests} hint={`${formatNumber(activity.ttsCharacters)} characters spoken`} />
				<Metric label="Voice minutes (REST)" value={Math.round(activity.sttSeconds / 60)} hint="From metered transcriptions" />
			</MetricGrid>

			<h2 style={sectionHeading}>Reliability</h2>
			<MetricGrid minWidth={170}>
				<Metric label="Open incidents" value={reliability.incidentsOpen} tone={reliability.incidentsOpen > 0 ? 'bad' : 'good'} />
				<Metric
					label="Tool failure rate"
					value={reliability.toolFailureRate === null ? null : `${(reliability.toolFailureRate * 100).toFixed(1)}%`}
					hint={`${formatNumber(reliability.toolFailures)} of ${formatNumber(reliability.toolExecutionsTotal)}`}
				/>
				<Metric
					label="Job failure rate"
					value={reliability.jobFailureRate === null ? null : `${(reliability.jobFailureRate * 100).toFixed(1)}%`}
					hint={`${formatNumber(reliability.jobFailures)} of ${formatNumber(reliability.jobExecutionsTotal)}`}
				/>
				<Metric label="Dead-letter jobs" value={reliability.deadLetterCount} tone={reliability.deadLetterCount > 0 ? 'bad' : 'default'} />
				<Metric label="Admin actions (24h)" value={reliability.adminActionsToday} />
				<Metric label="Refused admin actions (24h)" value={reliability.auditDenialsToday} tone={reliability.auditDenialsToday > 0 ? 'warn' : 'default'} />
			</MetricGrid>

			<Card title="Reliability caveats" subtitle="What is not measured, and why">
				<Table columns={['Signal', 'State', 'Reason']}>
					<Row>
						<Cell>Crash rate / ANRs</Cell>
						<Cell>
							<StatusBadge status="unknown" label="NOT AVAILABLE" />
						</Cell>
						<Cell muted>
							The mobile client reports crashes to Firebase Crashlytics, not to this API. Nothing bridges the
							two, so an operator would have to open the Firebase console.
						</Cell>
					</Row>
					<Row>
						<Cell>Notification delivery failures</Cell>
						<Cell>
							<StatusBadge status="unknown" label="NOT AVAILABLE" />
						</Cell>
						<Cell muted>No delivery record exists; see the Notifications page.</Cell>
					</Row>
					<Row>
						<Cell>API error rate and latency</Cell>
						<Cell>
							<StatusBadge status="unknown" label="NOT AVAILABLE" />
						</Cell>
						<Cell muted>
							No per-request metric is stored. The API logs a line per error but nothing aggregates it, and
							there is no metrics sink (Prometheus or similar) wired up.
						</Cell>
					</Row>
				</Table>
			</Card>

			<Notes
				notes={[
					'Retention and activation cohorts are not shown: computing them needs session history bucketed by signup week, and `sessions` currently records sign-ins rather than activity.',
					'Every NOT AVAILABLE row above names what would make it available. None of them is zero.',
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

const subHeading: React.CSSProperties = {
	fontSize: '0.8rem',
	fontWeight: 600,
	color: '#374151',
	margin: '0 0 0.5rem',
};
