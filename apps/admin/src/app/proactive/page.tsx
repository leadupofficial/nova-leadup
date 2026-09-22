/**
 * Admin Control Center — proactive AI.
 *
 * There is **no `proactive_events` table**, so this page reconstructs what is actually
 * knowable — notifications that the proactive engine produced — and states plainly what
 * it cannot answer.
 *
 * The question an operator most wants answered here is *"why did NOVA decide to reach
 * out?"*. That reasoning is not persisted anywhere, so the page says so instead of
 * inventing a plausible-looking "Trigger" column. A fabricated trigger reason would be
 * worse than an admitted gap: it would look like evidence.
 */

import Link from 'next/link';
import { getOperations } from '../../lib/api';
import { loadPage } from '../../lib/page-data';
import { ListView, positiveInt, shortId, type Column } from '../../components/operations-list';
import { Card, StatusBadge, formatDateTime, formatNumber } from '../../components/ui';

export const dynamic = 'force-dynamic';

type ProactiveEvent = {
	id: string;
	user_id: string;
	user_email: string | null;
	type: string;
	title: string;
	body: string | null;
	read: boolean;
	read_at: string | null;
	occurred_at: string;
};

type ByType = { type: string; count: number; read: number };

export default async function ProactivePage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const page = positiveInt(resolved.page, 1);

	const result = await loadPage<{ events: ProactiveEvent[]; byType: ByType[]; limitations: string[] }>(async () => {
		const envelope = (await getOperations<never>('proactive', { page, pageSize: 25 })) as unknown as {
			data?: ProactiveEvent[];
			events?: ProactiveEvent[];
			totalItems: number;
			totalPages: number;
			byType: ByType[];
			limitations: string[];
		};
		return {
			rows: [
				{
					events: envelope.events ?? envelope.data ?? [],
					byType: envelope.byType ?? [],
					limitations: envelope.limitations ?? [],
				},
			],
			totalItems: envelope.totalItems,
			totalPages: envelope.totalPages,
		};
	});

	const payload = result.ok ? result.rows[0] : null;
	const events = payload?.events ?? [];

	const columns: Array<Column<ProactiveEvent>> = [
		{
			header: 'Event',
			render: (row) => (
				<>
					<div style={{ fontWeight: 500, maxWidth: '340px' }}>{row.title}</div>
					{row.body ? <div style={{ fontSize: '0.74rem', color: '#6b7280', maxWidth: '380px' }}>{row.body}</div> : null}
					<div style={{ fontSize: '0.68rem', color: '#9ca3af', fontFamily: 'ui-monospace, Menlo, monospace' }}>
						{shortId(row.id)}
					</div>
				</>
			),
		},
		{ header: 'Channel type', render: (row) => <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.78rem' }}>{row.type}</span> },
		{
			header: 'User',
			render: (row) => (
				<Link href={`/users/${row.user_id}`} style={{ fontSize: '0.78rem', color: '#2563eb' }}>
					{row.user_email ?? shortId(row.user_id)}
				</Link>
			),
		},
		{
			header: 'User interaction',
			render: (row) => (
				<>
					<StatusBadge status={row.read ? 'pass' : 'pending'} label={row.read ? 'opened' : 'not opened'} />
					{row.read_at ? <div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>{formatDateTime(row.read_at)}</div> : null}
				</>
			),
		},
		{ header: 'Occurred', render: (row) => <span style={{ fontSize: '0.78rem' }}>{formatDateTime(row.occurred_at)}</span> },
	];

	return (
		<>
			<ListView
				title="Proactive AI"
				path="proactive"
				columns={columns}
				rows={events}
				totalItems={result.ok ? result.totalItems : null}
				totalPages={result.ok ? result.totalPages : null}
				page={page}
				query={{}}
				rowKey={(row) => row.id}
				notes={[
					...(result.ok ? [] : [result.message]),
					...((payload?.limitations as string[] | undefined) ?? []),
				]}
				emptyMessage="No proactive interactions recorded"
				emptyHint="A proactive turn is only visible here if it produced a notification. One that failed before delivery leaves no trace."
			/>

			{payload && payload.byType.length > 0 ? (
				<Card title="By channel type" subtitle="How NOVA reached out, and how often the user opened it">
					<table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
						<thead>
							<tr style={{ borderBottom: '1px solid #e5e7eb', textAlign: 'left' }}>
								<th style={th}>Type</th>
								<th style={th}>Sent</th>
								<th style={th}>Opened</th>
								<th style={th}>Not opened</th>
							</tr>
						</thead>
						<tbody>
							{payload.byType.map((entry) => (
								<tr key={entry.type} style={{ borderBottom: '1px solid #f3f4f6' }}>
									<td style={{ padding: '0.5rem', fontFamily: 'ui-monospace, Menlo, monospace' }}>{entry.type}</td>
									<td style={{ padding: '0.5rem' }}>{formatNumber(entry.count)}</td>
									<td style={{ padding: '0.5rem' }}>{formatNumber(entry.read)}</td>
									<td style={{ padding: '0.5rem', color: entry.count - entry.read > 0 ? '#d97706' : undefined }}>
										{formatNumber(entry.count - entry.read)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</Card>
			) : null}

			<Card title="What this page cannot tell you" subtitle="Stated so the numbers above are not over-read">
				<ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.82rem', lineHeight: 1.7, color: '#374151' }}>
					<li>
						<strong>Why NOVA acted.</strong> The trigger and the context it evaluated are not persisted. There is
						no honest way to fill a &ldquo;reason&rdquo; column from stored data.
					</li>
					<li>
						<strong>Whether the user actually heard it.</strong> There is no push delivery record and the app has
						no FCM integration, so &ldquo;opened&rdquo; means the user opened the app and the row was marked read.
					</li>
					<li>
						<strong>Follow-up chaining.</strong> Nothing links one proactive event to the next, so a follow-up
						sequence cannot be reconstructed.
					</li>
					<li>
						<strong>Suppressions.</strong> Quiet hours, the daily cap and the minimum interval are enforced by the
						follow-up engine in memory; a suppression leaves no row, so &ldquo;NOVA stayed quiet&rdquo; is invisible
						here.
					</li>
				</ul>
			</Card>
		</>
	);
}

const th: React.CSSProperties = {
	padding: '0.5rem',
	fontWeight: 600,
	color: '#6b7280',
	fontSize: '0.72rem',
	textTransform: 'uppercase',
	letterSpacing: '0.03em',
};
