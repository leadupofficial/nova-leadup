'use client';

/**
 * Public account-deletion request page.
 *
 * Google Play's account-deletion requirement is two-pronged: an app that lets users
 * create an account must (a) offer deletion inside the app and (b) provide a
 * **publicly reachable web resource** where deletion can be requested without
 * reinstalling the app. The URL is declared on the Data safety form, must not be
 * geofenced, must not sit behind a login, and must not be a PDF.
 *
 * This is half (b). Half (a) is Profile → Delete account in the mobile app
 * (`apps/mobile/lib/features/settings/delete_account_page.dart`).
 *
 * The page is deliberately **not** authenticated and the API endpoint it calls is
 * deliberately vague in its response: a public form that confirms whether an address
 * has an account is an account-enumeration oracle. See
 * `services/api/src/routes/account.ts`.
 *
 * It lives in the admin console because that console is what serves
 * `https://nova.leadup.in/`, and is exempted from the session gate in
 * `src/middleware.ts`.
 */

import { useState } from 'react';
import { getPublicEnv } from '../../lib/env';

const styles = {
	page: {
		maxWidth: '640px',
		margin: '0 auto',
		padding: '3rem 1.25rem 5rem',
		background: '#fff',
		color: '#111827',
		minHeight: '100vh',
	} as const,
	h1: { fontSize: '1.75rem', fontWeight: 800, margin: 0 } as const,
	label: { display: 'block', fontSize: '0.85rem', fontWeight: 600, margin: '1.25rem 0 0.35rem' } as const,
	input: {
		width: '100%',
		padding: '0.6rem 0.75rem',
		fontSize: '0.95rem',
		border: '1px solid #d1d5db',
		borderRadius: '8px',
		boxSizing: 'border-box',
	} as const,
	button: {
		marginTop: '1.25rem',
		width: '100%',
		padding: '0.7rem 1rem',
		fontSize: '0.95rem',
		fontWeight: 600,
		color: '#fff',
		background: '#1d4ed8',
		border: 'none',
		borderRadius: '8px',
		cursor: 'pointer',
	} as const,
} as const;

export default function DeleteAccountPage() {
	const [email, setEmail] = useState('');
	const [reason, setReason] = useState('');
	const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
	const [message, setMessage] = useState('');

	async function submit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (state === 'sending') return;
		setState('sending');
		try {
			const base = getPublicEnv().NEXT_PUBLIC_API_BASE.replace(/\/+$/, '');
			// `NEXT_PUBLIC_API_BASE` already carries the API prefix — `.env.example`
			// documents it as `https://nova.leadup.in/api/v1`, and `lib/api.ts`'s
			// `buildUrl()` likewise appends only the resource path. Appending
			// `/api/v1/...` here would have produced `/api/v1/api/v1/...` in
			// production while still working against a bare-host local base, which is
			// the kind of bug that only shows up after deploy.
			const response = await fetch(`${base}/account/deletion-request`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: email.trim(), reason: reason.trim() || undefined }),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(
					typeof body?.error?.message === 'string'
						? body.error.message
						: `The request could not be recorded (HTTP ${response.status}).`,
				);
			}
			const body = await response.json().catch(() => ({}));
			setMessage(
				typeof body?.data?.message === 'string'
					? body.data.message
					: 'If an account exists for that address, the deletion request has been recorded.',
			);
			setState('sent');
		} catch (error) {
			setMessage(
				error instanceof Error
					? error.message
					: 'The request could not be recorded. Please try again.',
			);
			setState('error');
		}
	}

	return (
		<main style={styles.page}>
			<h1 style={styles.h1}>Delete your NOVA account</h1>
			<p style={{ margin: '0.35rem 0 0', color: '#6b7280', fontSize: '0.85rem' }}>
				Leadup Technologies · NOVA
			</p>

			<h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: '2rem 0 0.5rem' }}>
				Fastest: delete it in the app
			</h2>
			<p style={{ fontSize: '0.9rem', lineHeight: 1.65, margin: '0 0 0.5rem' }}>
				Open NOVA, go to <strong>Profile → Delete account</strong>, type{' '}
				<code>DELETE</code> and confirm. Your account, conversations, tasks, reminders,
				memories and recordings are removed immediately, including the audio files in
				storage. You do not need to contact us.
			</p>

			<h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: '2rem 0 0.5rem' }}>
				Or request deletion here
			</h2>
			<p style={{ fontSize: '0.9rem', lineHeight: 1.65, margin: '0 0 0.5rem' }}>
				If you can no longer sign in, or you have already uninstalled the app, use this
				form. We will verify the request and complete the deletion within{' '}
				<strong>30 days</strong>. You can also email{' '}
				<a href="mailto:privacy@leadup.tech" style={{ color: '#1d4ed8' }}>
					privacy@leadup.tech
				</a>{' '}
				from the address you signed up with.
			</p>

			{state === 'sent' ? (
				<div
					style={{
						marginTop: '1.5rem',
						padding: '1rem',
						background: '#f0fdf4',
						border: '1px solid #bbf7d0',
						borderRadius: '8px',
						fontSize: '0.9rem',
						lineHeight: 1.6,
					}}
				>
					<strong>Request received.</strong> {message}
				</div>
			) : (
				<form onSubmit={submit}>
					<label style={styles.label} htmlFor="email">
						Email address on the account
					</label>
					<input
						id="email"
						type="email"
						required
						autoComplete="email"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						style={styles.input}
					/>

					<label style={styles.label} htmlFor="reason">
						Anything you want us to know? (optional)
					</label>
					<textarea
						id="reason"
						rows={3}
						maxLength={500}
						value={reason}
						onChange={(event) => setReason(event.target.value)}
						style={{ ...styles.input, resize: 'vertical' }}
					/>

					{state === 'error' && (
						<p style={{ marginTop: '1rem', color: '#b91c1c', fontSize: '0.85rem' }}>{message}</p>
					)}

					<button type="submit" style={styles.button} disabled={state === 'sending'}>
						{state === 'sending' ? 'Sending…' : 'Request account deletion'}
					</button>
				</form>
			)}

			<p style={{ marginTop: '2rem', fontSize: '0.8rem', color: '#6b7280', lineHeight: 1.6 }}>
				What is deleted: your account, profile, conversations and transcripts, tasks,
				reminders, saved memories, recordings and their audio files, and your consent
				records. Security audit entries are retained without the link to your identity,
				and database backups roll off within 7 days. See the{' '}
				<a href="/privacy" style={{ color: '#1d4ed8' }}>
					privacy policy
				</a>
				.
			</p>
		</main>
	);
}
