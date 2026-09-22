'use client';

import Link from 'next/link';

/**
 * Route-level error boundary.
 *
 * The console had none, so any render throw (an unmapped enum value, a malformed API
 * payload) landed on Next.js's default error page — which in production is a bare
 * "Application error: a client-side exception has occurred" with no way back. This
 * keeps the operator inside the console and offers a retry.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
	return (
		<div
			role="alert"
			style={{
				margin: '3rem auto',
				maxWidth: '640px',
				padding: '2rem',
				background: '#fef2f2',
				border: '1px solid #fecaca',
				borderRadius: '10px',
				color: '#7f1d1d',
			}}
		>
			<h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700 }}>This page failed to render</h1>
			<p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', lineHeight: 1.5 }}>
				{error.message || 'An unexpected error occurred.'}
			</p>
			{error.digest ? (
				<p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#991b1b' }}>
					Reference: {error.digest}
				</p>
			) : null}
			<div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem' }}>
				<button
					type="button"
					onClick={reset}
					style={{
						padding: '0.5rem 1.1rem',
						background: '#1a1a2e',
						color: '#fff',
						border: 'none',
						borderRadius: '6px',
						fontSize: '0.85rem',
						cursor: 'pointer',
					}}
				>
					Try again
				</button>
				<Link
					href="/"
					style={{
						padding: '0.5rem 1.1rem',
						border: '1px solid #7f1d1d',
						borderRadius: '6px',
						fontSize: '0.85rem',
						color: '#7f1d1d',
						textDecoration: 'none',
					}}
				>
					Back to dashboard
				</Link>
			</div>
		</div>
	);
}
