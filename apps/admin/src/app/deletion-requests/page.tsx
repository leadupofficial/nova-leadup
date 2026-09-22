/**
 * Account-deletion requests filed from the public web form.
 *
 * The other half of the promise made on `https://nova.leadup.in/delete-account`.
 * Play's account-deletion requirement needs a web resource where a user who can no
 * longer sign in can ask for deletion; this is where that ask is actioned, and it is
 * why the request is not handled by a scheduled job — the endpoint that files it is
 * public and unauthenticated, so nothing may act on it without a person confirming
 * that the requester owns the account.
 */

import { listAccountDeletionRequests, type AccountDeletionRequest } from '../../lib/api';
import { describeLoadError } from '../../lib/page-data';
import { PageError } from '../../components/PageError';
import { completeDeletionRequestAction } from './actions';

const tdStyle = { padding: '0.75rem 1rem', fontSize: '0.9rem' } as const;

export default async function DeletionRequestsPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const errorMessage = typeof resolved.error === 'string' ? resolved.error : '';
	const okMessage = typeof resolved.ok === 'string' ? resolved.ok : '';

	let result:
		| { ok: true; requests: AccountDeletionRequest[] }
		| { ok: false; message: string; status: number | null };
	try {
		result = { ok: true, requests: await listAccountDeletionRequests() };
	} catch (error) {
		const described = describeLoadError(error);
		result = { ok: false, message: described.message, status: described.status };
	}

	if (!result.ok) {
		return (
			<div>
				<div style={{ marginBottom: '1.5rem' }}>
					<h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>Deletion requests</h1>
				</div>
				<PageError
					title="Could not load deletion requests"
					message={result.message}
					status={result.status}
					retryHref="/deletion-requests"
				/>
			</div>
		);
	}

	const requests = result.requests;

	return (
		<div>
			<div style={{ marginBottom: '1.5rem' }}>
				<h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>Deletion requests</h1>
				<p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#6b7280' }}>
					{requests.length} pending · filed from the public deletion page
				</p>
			</div>

			{errorMessage && (
				<div
					style={{
						marginBottom: '1rem',
						padding: '0.75rem 1rem',
						background: '#fef2f2',
						border: '1px solid #fecaca',
						borderRadius: '8px',
						color: '#b91c1c',
						fontSize: '0.875rem',
					}}
				>
					{errorMessage}
				</div>
			)}
			{okMessage === 'deleted' && (
				<div
					style={{
						marginBottom: '1rem',
						padding: '0.75rem 1rem',
						background: '#f0fdf4',
						border: '1px solid #bbf7d0',
						borderRadius: '8px',
						color: '#166534',
						fontSize: '0.875rem',
					}}
				>
					The account and its data were deleted.
				</div>
			)}

			<div
				style={{
					marginBottom: '1.5rem',
					padding: '0.9rem 1rem',
					background: '#fffbeb',
					border: '1px solid #fde68a',
					borderRadius: '8px',
					fontSize: '0.85rem',
					color: '#92400e',
					lineHeight: 1.55,
				}}
			>
				<strong>Verify before you delete.</strong> This form is public and asks for
				nothing but an email address, so a request is a claim, not proof — anyone can
				file one for anyone. Confirm the requester owns the account (reply to the
				address, or match it against a support conversation) before completing it. The
				published policy promises completion within 30 days.
			</div>

			<div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
				<table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
					<thead>
						<tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
							<th style={{ textAlign: 'left', ...tdStyle, fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Email</th>
							<th style={{ textAlign: 'left', ...tdStyle, fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Reason</th>
							<th style={{ textAlign: 'left', ...tdStyle, fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Filed</th>
							<th style={{ textAlign: 'left', ...tdStyle, fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Due by</th>
							<th style={{ textAlign: 'right', ...tdStyle, fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Complete</th>
						</tr>
					</thead>
					<tbody>
						{requests.map((request) => (
							<tr key={request.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
								<td style={{ ...tdStyle, fontWeight: 500 }}>{request.email ?? request.userId}</td>
								<td style={{ ...tdStyle, color: '#6b7280', maxWidth: '260px' }}>{request.reason ?? '—'}</td>
								<td style={{ ...tdStyle, color: '#6b7280', whiteSpace: 'nowrap' }}>
									{new Date(request.createdAt).toLocaleDateString()}
								</td>
								<td style={{ ...tdStyle, color: '#6b7280', whiteSpace: 'nowrap' }}>
									{request.scheduledFor ? new Date(request.scheduledFor).toLocaleDateString() : '—'}
								</td>
								<td style={{ ...tdStyle, textAlign: 'right' }}>
									<form
										action={completeDeletionRequestAction}
										style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}
									>
										<input type="hidden" name="id" value={request.id} />
										<input
											name="confirm"
											placeholder="DELETE"
											aria-label={`Type DELETE to confirm deleting ${request.email ?? request.userId}`}
											style={{
												width: '84px',
												padding: '0.3rem 0.45rem',
												fontSize: '0.8rem',
												border: '1px solid #d1d5db',
												borderRadius: '6px',
											}}
										/>
										<button
											type="submit"
											aria-label={`Delete the account for ${request.email ?? request.userId}`}
											style={{
												padding: '0.3rem 0.7rem',
												fontSize: '0.8rem',
												fontWeight: 500,
												color: '#dc2626',
												background: '#fef2f2',
												border: '1px solid #fecaca',
												borderRadius: '6px',
												cursor: 'pointer',
											}}
										>
											Delete account
										</button>
									</form>
								</td>
							</tr>
						))}
						{requests.length === 0 && (
							<tr>
								<td colSpan={5} style={{ padding: '3rem', textAlign: 'center', color: '#9ca3af' }}>
									No pending deletion requests
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
		</div>
	);
}
