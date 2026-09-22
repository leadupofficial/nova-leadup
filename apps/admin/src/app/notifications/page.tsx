/**
 * Admin Control Center — notifications.
 *
 * Volume and read-state by type. Two limits are stated on the page rather than implied:
 *
 *  - there is **no delivery record**. A `notifications` row is written when a
 *    notification is created, not when it reaches a device, so "delivered" and "failed"
 *    are not knowable from this data;
 *  - the mobile app has **no FCM integration**, so a server-initiated push cannot be
 *    delivered at all today — these rows are read by the app when it next opens.
 */

import { getOperations } from '../../lib/api';
import { loadPage } from '../../lib/page-data';
import { ListView, positiveInt, shortId, singleParam, type Column } from '../../components/operations-list';
import { Card, StatusBadge, formatDateTime, formatNumber } from '../../components/ui';

export const dynamic = 'force-dynamic';

type NotificationRow = {
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

type ByType = { type: string; total: number; read_count: number };

export default async function NotificationsPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const page = positiveInt(resolved.page, 1);
	const type = singleParam(resolved.type);
	const read = singleParam(resolved.read);
	const userId = singleParam(resolved.userId);

	const result = await loadPage<{ rows: NotificationRow[]; byType: ByType[]; limitations: string[] }>(
		async () => {
			const envelope = (await getOperations<never>('notifications', {
				page,
				pageSize: 25,
				...(type ? { type } : {}),
				...(read ? { read } : {}),
				...(userId ? { userId } : {}),
			})) as unknown as {
				data: NotificationRow[];
				totalItems: number;
				totalPages: number;
				byType: ByType[];
				limitations: string[];
			};
			return {
				rows: [{ rows: envelope.data, byType: envelope.byType ?? [], limitations: envelope.limitations ?? [] }],
				totalItems: envelope.totalItems,
				totalPages: envelope.totalPages,
			};
		},
	);

	const payload = result.ok ? result.rows[0] : null;
	const rows = payload?.rows ?? [];

	const columns: Array<Column<NotificationRow>> = [
		{
			header: 'Notification',
			render: (row) => (
				<>
					<div style={{ fontWeight: 500, maxWidth: '320px' }}>{row.title}</div>
					{row.body ? (
						<div style={{ fontSize: '0.74rem', color: '#6b7280', maxWidth: '360px' }}>{row.body}</div>
					) : null}
					<div style={{ fontSize: '0.68rem', color: '#9ca3af', fontFamily: 'ui-monospace, Menlo, monospace' }}>
						{shortId(row.id)}
					</div>
				</>
			),
		},
		{ header: 'Type', render: (row) => <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.78rem' }}>{row.type}</span> },
		{
			header: 'User',
			render: (row) => <span style={{ fontSize: '0.78rem' }}>{row.user_email ?? shortId(row.user_id)}</span>,
		},
		{
			header: 'Read',
			render: (row) => (
				<>
					<StatusBadge status={row.read ? 'pass' : 'pending'} label={row.read ? 'read' : 'unread'} />
					{row.read_at ? (
						<div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>{formatDateTime(row.read_at)}</div>
					) : null}
				</>
			),
		},
		{ header: 'Created', render: (row) => <span style={{ fontSize: '0.78rem' }}>{formatDateTime(row.occurred_at)}</span> },
	];

	return (
		<>
			<ListView
				title="Notifications"
				path="notifications"
				columns={columns}
				rows={rows}
				totalItems={result.ok ? result.totalItems : null}
				totalPages={result.ok ? result.totalPages : null}
				page={page}
				query={{ ...(type ? { type } : {}), ...(read ? { read } : {}), ...(userId ? { userId } : {}) }}
				filters={[
					{ name: 'read', label: 'Read state', options: [ { value: 'false', label: 'Unread' }, { value: 'true', label: 'Read' } ] },
				]}
				searchParam="type"
				searchPlaceholder="Exact type, e.g. follow_up"
				searchValue={type}
				rowKey={(row) => row.id}
				notes={[
					...(!result.ok ? [result.message] : []),
					...((payload?.limitations as string[] | undefined) ?? []),
					'No test-send is offered from this page. `notifications.send` exists as a permission, but a send that nothing can deliver would be a lie — add FCM first.',
				]}
				emptyMessage="No notifications match this filter"
				emptyHint="An empty table here is a real zero: notifications are written whenever the notification service creates one."
			/>

			{payload && payload.byType.length > 0 ? (
				<Card title="Volume by type" subtitle="Totals across all time, most frequent first">
					<table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
						<thead>
							<tr style={{ borderBottom: '1px solid #e5e7eb', textAlign: 'left' }}>
								<th style={th}>Type</th>
								<th style={th}>Total</th>
								<th style={th}>Read</th>
								<th style={th}>Unread</th>
							</tr>
						</thead>
						<tbody>
							{payload.byType.map((entry) => (
								<tr key={entry.type} style={{ borderBottom: '1px solid #f3f4f6' }}>
									<td style={{ padding: '0.5rem', fontFamily: 'ui-monospace, Menlo, monospace' }}>{entry.type}</td>
									<td style={{ padding: '0.5rem' }}>{formatNumber(entry.total)}</td>
									<td style={{ padding: '0.5rem' }}>{formatNumber(entry.read_count)}</td>
									<td style={{ padding: '0.5rem', color: entry.total - entry.read_count > 0 ? '#d97706' : undefined }}>
										{formatNumber(entry.total - entry.read_count)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</Card>
			) : null}
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
