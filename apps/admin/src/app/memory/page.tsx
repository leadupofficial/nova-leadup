/**
 * Admin Control Center — memory.
 *
 * What NOVA has stored about users. This is personal data, so two things are deliberate:
 *
 *  - **listing memory is an audited action.** The API writes an `admin_audit_logs` row
 *    on every read through this endpoint, not only on writes, because "who looked at
 *    this person's memories" is the question a data-protection review asks.
 *  - **erasure requires typing `DELETE`.** There is no undo, and the entry is gone from
 *    the user's assistant as well as from this table.
 */

import Link from 'next/link';
import { getOperations } from '../../lib/api';
import { loadPage } from '../../lib/page-data';
import { ListView, positiveInt, shortId, singleParam, type Column } from '../../components/operations-list';
import { formatDateTime, formatNumber } from '../../components/ui';
import { deleteMemoryAction } from '../actions/operations';

export const dynamic = 'force-dynamic';

type MemoryRow = {
	id: string;
	user_id: string;
	user_email: string | null;
	content: string;
	category: string;
	importance: number | null;
	metadata: unknown;
	created_at: string;
	updated_at: string;
};

const inputStyle: React.CSSProperties = {
	padding: '0.35rem 0.5rem',
	border: '1px solid #d1d5db',
	borderRadius: '6px',
	fontSize: '0.74rem',
};

export default async function MemoryPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const page = positiveInt(resolved.page, 1);
	const type = singleParam(resolved.type);
	const userId = singleParam(resolved.userId);
	const minImportance = singleParam(resolved.minImportance);
	const okMessage = singleParam(resolved.ok);
	const errorMessage = singleParam(resolved.error);

	const query = {
		...(type ? { type } : {}),
		...(userId ? { userId } : {}),
		...(minImportance ? { minImportance } : {}),
	};
	const returnTo = `/memory?${new URLSearchParams({ ...query, page: String(page) }).toString()}`;

	const result = await loadPage<MemoryRow>(async () => {
		const envelope = await getOperations<MemoryRow>('memory', { page, pageSize: 25, ...query });
		return { rows: envelope.data, totalItems: envelope.totalItems, totalPages: envelope.totalPages };
	});

	const rows = result.ok ? result.rows : [];

	const columns: Array<Column<MemoryRow>> = [
		{
			header: 'Content',
			render: (row) => (
				<>
					<div style={{ maxWidth: '420px' }}>{row.content}</div>
					<div style={{ fontSize: '0.68rem', color: '#9ca3af', fontFamily: 'ui-monospace, Menlo, monospace' }}>
						{shortId(row.id)}
					</div>
				</>
			),
		},
		{ header: 'Category', render: (row) => <span style={{ fontSize: '0.78rem' }}>{row.category}</span> },
		{
			header: 'Importance',
			align: 'right',
			render: (row) => <span style={{ fontSize: '0.78rem' }}>{row.importance ?? '—'}</span>,
		},
		{
			header: 'User',
			render: (row) => (
				<Link href={`/users/${row.user_id}`} style={{ fontSize: '0.78rem', color: '#2563eb' }}>
					{row.user_email ?? shortId(row.user_id)}
				</Link>
			),
		},
		{ header: 'Created', render: (row) => <span style={{ fontSize: '0.78rem' }}>{formatDateTime(row.created_at)}</span> },
		{
			header: 'Erase',
			render: (row) => (
				<form action={deleteMemoryAction} style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
					<input type="hidden" name="id" value={row.id} />
					<input type="hidden" name="returnTo" value={returnTo} />
					<input name="confirm" placeholder="DELETE" style={{ ...inputStyle, width: '80px' }} aria-label={`Type DELETE to erase memory ${shortId(row.id)}`} />
					<button
						type="submit"
						style={{
							padding: '0.3rem 0.6rem',
							fontSize: '0.72rem',
							color: '#dc2626',
							background: '#fef2f2',
							border: '1px solid #fecaca',
							borderRadius: '6px',
							cursor: 'pointer',
						}}
					>
						Erase
					</button>
				</form>
			),
		},
	];

	return (
		<ListView
			title="Memory"
			path="memory"
			columns={columns}
			rows={rows}
			totalItems={result.ok ? result.totalItems : null}
			totalPages={result.ok ? result.totalPages : null}
			page={page}
			query={query}
			searchParam="type"
			searchPlaceholder="Exact category, e.g. fact"
			searchValue={type}
			filters={[
				{
					name: 'minImportance',
					label: 'Minimum importance',
					options: [
						{ value: '0.25', label: '0.25+' },
						{ value: '0.5', label: '0.5+' },
						{ value: '0.75', label: '0.75+' },
					],
				},
			]}
			rowKey={(row) => row.id}
			notes={[
				errorMessage || (okMessage ? `Erased. ${okMessage}` : null),
				...(result.ok ? [] : [result.message]),
				'Listing memory is itself audited: every read through this page writes an admin audit row with the operator’s identity and the filter they used.',
				'Erasing an entry removes it here and from what the assistant can recall; memory embeddings, if any, are removed with the row by cascade.',
				`Categories in use: ${formatNumber(new Set(rows.map((row) => row.category)).size)} distinct on this page.`,
			]}
			emptyMessage="No memory entries match this filter"
			emptyHint="Memory is written by the assistant when it detects something worth remembering; an empty table is a real zero."
		/>
	);
}
