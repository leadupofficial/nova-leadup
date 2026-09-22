/**
 * Admin Control Center — conversations.
 *
 * **Metadata only.** Message text lives behind a separate permission
 * (`conversations.content_read`) and a separate, individually audited call, so an
 * operator with `conversations.read` can find the session they need without seeing what
 * was said. That separation is the whole point of the permission split.
 *
 * Search and filtering are server-side; the page never loads a conversation's messages
 * into the browser, only its shape (mode, model, token counts, message counts).
 */

import Link from 'next/link';
import { getOperations } from '../../lib/api';
import { loadPage } from '../../lib/page-data';
import { ListView, positiveInt, shortId, singleParam, type Column } from '../../components/operations-list';
import { StatusBadge, formatDateTime, formatNumber, formatRelative } from '../../components/ui';

export const dynamic = 'force-dynamic';

type ConversationRow = {
	id: string;
	user_id: string;
	user_email: string | null;
	user_name: string | null;
	title: string | null;
	mode: string;
	messages: number;
	user_messages: number;
	assistant_messages: number;
	models: string[] | null;
	tokens: number;
	created_at: string;
	updated_at: string;
	ended_at: string | null;
	last_message_at: string | null;
};

export default async function ConversationsPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const page = positiveInt(resolved.page, 1);
	const mode = singleParam(resolved.mode);
	const search = singleParam(resolved.search);
	const userId = singleParam(resolved.userId);

	const query = { ...(mode ? { mode } : {}), ...(search ? { search } : {}), ...(userId ? { userId } : {}) };

	const result = await loadPage<ConversationRow>(async () => {
		const envelope = await getOperations<ConversationRow>('conversations', { page, pageSize: 25, ...query });
		return {
			rows: envelope.data,
			totalItems: envelope.totalItems,
			totalPages: envelope.totalPages,
			// Passed through rather than assigned to a captured variable: the React compiler
			// rejects reassignment inside the loader, and it was the wrong shape anyway.
			contentRedacted: Boolean(envelope.contentRedacted),
			contentPermission: envelope.contentPermission,
		};
	});

	// True when the API withheld the user's own words because this operator's role does not
	// hold the matching content permission.
	const contentRedacted = result.ok && result.contentRedacted === true;

	const rows = result.ok ? result.rows : [];

	const columns: Array<Column<ConversationRow>> = [
		{
			header: 'Conversation',
			render: (row) => (
				<>
					<div style={{ fontWeight: 500, maxWidth: '280px' }}>{row.title ?? '(untitled)'}</div>
					<div style={{ fontSize: '0.68rem', color: '#9ca3af', fontFamily: 'ui-monospace, Menlo, monospace' }}>
						{shortId(row.id)}
					</div>
				</>
			),
		},
		{
			header: 'User',
			render: (row) => (
				<Link href={`/users/${row.user_id}`} style={{ fontSize: '0.78rem', color: '#2563eb' }}>
					{row.user_email ?? row.user_name ?? shortId(row.user_id)}
				</Link>
			),
		},
		{ header: 'Mode', render: (row) => <StatusBadge status={row.mode === 'voice' ? 'running' : 'unknown'} label={row.mode} /> },
		{
			header: 'Messages',
			align: 'right',
			render: (row) => (
				<span style={{ fontSize: '0.8rem' }}>
					{formatNumber(row.messages)}
					<div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>
						{formatNumber(row.user_messages)} user / {formatNumber(row.assistant_messages)} NOVA
					</div>
				</span>
			),
		},
		{
			header: 'Model(s)',
			render: (row) => (
				<span style={{ fontSize: '0.74rem', fontFamily: 'ui-monospace, Menlo, monospace' }}>
					{row.models && row.models.length > 0 ? row.models.join(', ') : '—'}
				</span>
			),
		},
		{
			header: 'Tokens',
			align: 'right',
			render: (row) => <span style={{ fontSize: '0.8rem' }}>{formatNumber(row.tokens)}</span>,
		},
		{
			header: 'Last activity',
			render: (row) => (
				<span style={{ fontSize: '0.78rem' }}>
					{row.last_message_at ? formatRelative(row.last_message_at) : formatRelative(row.created_at)}
					<div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>started {formatDateTime(row.created_at)}</div>
				</span>
			),
		},
	];

	return (
		<ListView
			title="Conversations"
			path="conversations"
			columns={columns}
			rows={rows}
			totalItems={result.ok ? result.totalItems : null}
			totalPages={result.ok ? result.totalPages : null}
			page={page}
			query={query}
			filters={[
				{
					name: 'mode',
					label: 'Mode',
					options: [
						{ value: 'voice', label: 'Voice' },
						{ value: 'text', label: 'Text' },
					],
				},
			]}
			searchParam="search"
			searchPlaceholder="Conversation title"
			searchValue={search}
			rowKey={(row) => row.id}
			notes={[
								...(contentRedacted
					? [
							`Titles are withheld: reading them requires the \`conversations.content_read\` permission, which your role does not hold. The rows, counts and timing below are complete — only the user's own words are removed.`,
						]
					: []),
...(result.ok ? [] : [result.message]),
				'Message text is NOT shown here. Reading it requires the separate `conversations.content_read` permission, is a distinct API call, and is audited individually — so this page can be used for triage without exposing what anyone said.',
				'Token counts are summed from the persisted per-message usage, so they are real totals rather than estimates. Latency is not shown because nothing records it.',
			]}
			emptyMessage="No conversations match this filter"
			emptyHint="Conversations are created by the mobile client when a session starts."
		/>
	);
}
