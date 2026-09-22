import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The failure state every data page was missing.
 *
 * A page component is a server component with no client-side retry affordance, so the
 * retry is a plain link: reloading the route re-runs the server fetch. It is a real
 * link rather than a button because it works without JavaScript, which is exactly the
 * situation an operator is in when the console is misbehaving.
 */
export function PageError({
	title = 'Could not load this page',
	message,
	status,
	retryHref,
	children,
}: {
	title?: string;
	message: string;
	status?: number | null;
	retryHref?: string;
	children?: ReactNode;
}) {
	return (
		<div
			role="alert"
			aria-live="assertive"
			style={{
				margin: '2rem 0',
				padding: '1.5rem',
				background: '#fef2f2',
				border: '1px solid #fecaca',
				borderRadius: '10px',
				color: '#7f1d1d',
			}}
		>
			<div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
				<span aria-hidden style={{ fontSize: '1.1rem' }}>⚠</span>
				<h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700 }}>
					{title}
					{typeof status === 'number' ? ` (HTTP ${status})` : ''}
				</h2>
			</div>
			<p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', lineHeight: 1.5 }}>{message}</p>
			{children}
			<div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
				<Link
					href={retryHref ?? ''}
					style={{
						padding: '0.5rem 1.1rem',
						background: '#1a1a2e',
						color: '#fff',
						borderRadius: '6px',
						fontSize: '0.85rem',
						textDecoration: 'none',
					}}
				>
					Try again
				</Link>
				{status === 401 || status === 403 ? (
					<Link
						href="/login"
						style={{
							padding: '0.5rem 1.1rem',
							border: '1px solid #7f1d1d',
							borderRadius: '6px',
							fontSize: '0.85rem',
							color: '#7f1d1d',
							textDecoration: 'none',
						}}
					>
						Sign in again
					</Link>
				) : null}
			</div>
		</div>
	);
}
