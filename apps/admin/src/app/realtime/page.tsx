/**
 * Admin Control Center — realtime / WebSocket monitor.
 *
 * Says plainly what it can and cannot see. Active connections live in the memory of the
 * gateway replica that accepted them, so a count from this API covers this process only.
 * Connection rate, disconnect rate and message rate are not measured at all — nothing
 * increments a counter per connection event.
 *
 * Rather than inventing a dashboard of zeros, the page reports the real state (is the
 * transport enabled, how many sessions this process holds) and lists the missing signals
 * with what each would need.
 */

import Link from 'next/link';
import { getControls, getRealtime } from '../../lib/api';
import { loadPage } from '../../lib/page-data';
import { PageError } from '../../components/PageError';
import { Card, Cell, Metric, MetricGrid, Notes, PageHeader, Row, StatusBadge, Table } from '../../components/ui';

export const dynamic = 'force-dynamic';

export default async function RealtimePage() {
	const result = await loadPage(async () => {
		const [realtime, controls] = await Promise.all([
			getRealtime().catch(() => null),
			getControls().catch(() => null),
		]);
		return { rows: [{ realtime, controls }] };
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Realtime" />
				<PageError
					title="Could not load realtime state"
					message={result.message}
					status={result.status}
					retryHref="/realtime"
				/>
			</div>
		);
	}

	const payload = result.rows[0];
	const realtime = payload?.realtime ?? {};
	const controls = payload?.controls?.controls ?? null;

	const localSessions = typeof realtime.localSessions === 'number' ? realtime.localSessions : null;
	const limitations = Array.isArray(realtime.limitations) ? (realtime.limitations as string[]) : [];

	return (
		<div>
			<PageHeader
				title="Realtime & WebSocket"
				subtitle="Live voice transport state for the API process serving this console"
				actions={
					<Link href="/maintenance" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
						Kill switches →
					</Link>
				}
			/>

			<MetricGrid minWidth={200}>
				<Metric
					label="Realtime transport"
					value={controls ? (controls.realtimeEnabled ? 'enabled' : 'DISABLED') : 'unknown'}
					tone={controls ? (controls.realtimeEnabled ? 'good' : 'bad') : 'default'}
					hint="CONTROL_REALTIME_ENABLED — off refuses every new socket"
				/>
				<Metric
					label="Voice pipeline"
					value={controls ? (controls.voiceEnabled ? 'enabled' : 'DISABLED') : 'unknown'}
					tone={controls ? (controls.voiceEnabled ? 'good' : 'bad') : 'default'}
					hint="CONTROL_VOICE_ENABLED — off refuses the upgrade before the token is checked"
				/>
				<Metric
					label="Local sessions"
					value={localSessions}
					hint="Held by this process only, not the platform"
				/>
			</MetricGrid>

			<Notes
				notes={[
					...limitations,
					'Connection state is in-process memory. A count from this replica says nothing about sockets held by a sibling replica, and there is no shared registry — unifying it needs Redis pub/sub, which is not wired up.',
					'There is no connection-rate, disconnect-rate, message-rate or latency metric. Nothing increments a counter per connection event, so those figures cannot be produced from existing data.',
				]}
				tone="warn"
			/>

			<Card title="What is observable today" subtitle="And the exact mechanism behind each line">
				<Table columns={['Signal', 'Available', 'How it is obtained']}>
					<Row>
						<Cell>Transport enabled / disabled</Cell>
						<Cell>
							<StatusBadge status="pass" label="yes" />
						</Cell>
						<Cell muted>Control read on every upgrade attempt before anything else.</Cell>
					</Row>
					<Row>
						<Cell>Sessions held by this process</Cell>
						<Cell>
							<StatusBadge status="pass" label="yes" />
						</Cell>
						<Cell muted>
							In-memory registry in services/api/src/realtime/registry.ts, incremented on a successful upgrade
							and decremented on socket close.
						</Cell>
					</Row>
					<Row>
						<Cell>Rejected upgrade reason</Cell>
						<Cell>
							<StatusBadge status="pass" label="in logs" />
						</Cell>
						<Cell muted>
							Every rejection is logged with its reason (no token, invalid token, transport disabled, voice
							disabled) but is not aggregated into a counter or a table.
						</Cell>
					</Row>
					<Row>
						<Cell>Connection / disconnect rate</Cell>
						<Cell>
							<StatusBadge status="unknown" label="NOT AVAILABLE" />
						</Cell>
						<Cell muted>
							Needs a counter incremented per connect and per close, exported to a metrics sink.
						</Cell>
					</Row>
					<Row>
						<Cell>Message rate and frame latency</Cell>
						<Cell>
							<StatusBadge status="unknown" label="NOT AVAILABLE" />
						</Cell>
						<Cell muted>
							Needs per-frame instrumentation in the realtime session and an aggregation store.
						</Cell>
					</Row>
					<Row>
						<Cell>A specific user&apos;s connection state</Cell>
						<Cell>
							<StatusBadge status="unknown" label="partial" />
						</Cell>
						<Cell muted>
							The registry can answer for sessions on this replica. A cross-replica answer needs a shared
							presence record.
						</Cell>
					</Row>
				</Table>
			</Card>

			<Card title="Why this page still exists" subtitle="A monitor that admits its blind spots is more useful than one that fills them in">
				<p style={{ margin: 0, fontSize: '0.85rem', color: '#374151', lineHeight: 1.6 }}>
					The operational question during a voice incident is usually &ldquo;are sockets reaching us at all?&rdquo;.
					The transport and voice kill switches answer the first half instantly, and the local session count answers
					the second for this process. When those two are not enough, the log stream is the next stop — every
					rejection is logged with its reason.
				</p>
			</Card>
		</div>
	);
}
