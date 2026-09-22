/**
 * One conversation, in full — the operator view of what was actually said.
 *
 * This is the read the console could describe but never open: `/conversations` listed sessions with
 * counts and no page could show their content, even though the API has exposed an audited,
 * separately-permissioned route for it all along.
 *
 * Three things are deliberate:
 *
 *  1. **The permission is real, not decorative.** `conversations.content_read` is separate from
 *     `conversations.read`, so most operators reach this page and are refused by the API. That
 *     refusal is rendered as an explanation with the permission named, not as an empty page — a
 *     blank screen reads as "this conversation is empty", which is a different and misleading fact.
 *  2. **The read is announced.** The API writes an audit row naming the operator, this user and this
 *     conversation on every call, so the page says so before rendering, not in a footnote.
 *  3. **Nothing is truncated.** Message text is shown as stored; a viewer that silently clipped the
 *     content would misrepresent what the user said.
 */
import Link from 'next/link';
import { describeLoadError } from '../../../lib/page-data';
import { getConversationContent } from '../../../lib/api';
import { Card, EmptyState, formatDateTime } from '../../../components/ui';

export const dynamic = 'force-dynamic';

type Message = {
	id: string;
	role: string;
	content: string;
	model: string | null;
	tokenUsage: unknown;
	toolCalls: unknown;
	createdAt: string;
};

/** Role names come from the provider, so they are normalised rather than assumed. */
function roleLabel(role: string): string {
	if (role === 'user') return 'User';
	if (role === 'assistant') return 'NOVA';
	return role.charAt(0).toUpperCase() + role.slice(1);
}

function totalTokens(usage: unknown): number | null {
	if (!usage || typeof usage !== 'object') return null;
	const u = usage as Record<string, unknown>;
	const total = typeof u.totalTokens === 'number' ? u.totalTokens : typeof u.total_tokens === 'number' ? (u.total_tokens as number) : null;
	return total;
}

export default async function ConversationContentPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { id } = await params;
	const resolved = await searchParams;
	const userId = typeof resolved.userId === 'string' ? resolved.userId : Array.isArray(resolved.userId) ? resolved.userId[0] : undefined;

	if (!userId) {
		return (
			<div style={{ padding: '2rem' }}>
				<EmptyState
					message="This URL is missing the account it belongs to"
					hint="Conversation ids are not globally unique: message content is fetched per account, so the link needs ?userId=… as well as the conversation id."
				/>
			</div>
		);
	}

	let messages: Message[] = [];
	let conversation: Record<string, unknown> = {};
	let error: { message: string; status: number | null } | null = null;

	try {
		const data = await getConversationContent(userId, id);
		messages = data.messages ?? [];
		conversation = data.conversation ?? {};
	} catch (err) {
		error = describeLoadError(err);
	}

	const refused = error?.status === 403;

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
			<div>
				<h1 style={{ fontSize: '1.35rem', fontWeight: 600, margin: 0 }}>
					{typeof conversation.title === 'string' && conversation.title ? conversation.title : 'Conversation'}
				</h1>
				<p style={{ fontSize: '0.8rem', color: '#6b7280', margin: '0.35rem 0 0' }}>
					<Link href={`/users/${userId}`} style={{ color: '#2563eb' }}>
						{userId}
					</Link>{' '}
					· {messages.length} message{messages.length === 1 ? '' : 's'}
					{typeof conversation.mode === 'string' ? ` · ${conversation.mode}` : ''}
				</p>
			</div>

			{refused ? (
				<Card
					title="Your role cannot read conversation content"
					subtitle="Reading what a user said is a separate permission from listing their conversations, and this account does not hold it."
				>
					<p style={{ fontSize: '0.82rem', color: '#374151', margin: 0, lineHeight: 1.6 }}>
						The page exists and the API route works; the request was refused with{' '}
						<code style={{ fontSize: '0.78rem' }}>conversations.content_read</code>. Ask a super
						administrator to grant a role that holds it if you need this for a specific case — the
						grant is itself audited. Until then, the conversation list still shows the session
						shape: mode, model, message counts, tokens and timing.
					</p>
				</Card>
			) : error ? (
				<Card title="Could not load this conversation" subtitle={error.message}>
					<p style={{ fontSize: '0.8rem', color: '#6b7280', margin: 0 }}>{error.message}</p>
				</Card>
			) : messages.length === 0 ? (
				<EmptyState
					message="This conversation has no messages"
					hint="The session exists but no message was ever persisted against it."
				/>
			) : (
				<>
					<p style={{ fontSize: '0.72rem', color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
						Reading this page wrote an audit row naming you, this account and this conversation. The
						messages are shown exactly as stored, in order, with no truncation.
					</p>
					{messages.map((message) => {
						const tokens = totalTokens(message.tokenUsage);
						const isUser = message.role === 'user';
						return (
							<div
								key={message.id}
								style={{
									background: isUser ? '#f8fafc' : '#fff',
									border: '1px solid #e5e7eb',
									borderRadius: '10px',
									padding: '0.85rem 1rem',
								}}
							>
								<div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', marginBottom: '0.4rem' }}>
									<span style={{ fontSize: '0.76rem', fontWeight: 600, color: isUser ? '#334155' : '#4338ca' }}>
										{roleLabel(message.role)}
									</span>
									<span style={{ fontSize: '0.7rem', color: '#9ca3af' }}>
										{formatDateTime(message.createdAt)}
										{message.model ? ` · ${message.model}` : ''}
										{tokens !== null ? ` · ${tokens} tokens` : ''}
									</span>
								</div>
								<div style={{ fontSize: '0.85rem', color: '#111827', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
									{message.content}
								</div>
								{message.toolCalls ? (
									<details style={{ marginTop: '0.5rem' }}>
										<summary style={{ fontSize: '0.72rem', color: '#6b7280', cursor: 'pointer' }}>
											Tool calls
										</summary>
										<pre style={{ fontSize: '0.7rem', background: '#f9fafb', padding: '0.6rem', borderRadius: '6px', overflowX: 'auto' }}>
											{JSON.stringify(message.toolCalls, null, 2)}
										</pre>
									</details>
								) : null}
							</div>
						);
					})}
				</>
			)}
		</div>
	);
}
