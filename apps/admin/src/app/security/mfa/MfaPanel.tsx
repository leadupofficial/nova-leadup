'use client';

/**
 * The interactive half of the two-factor page.
 *
 * Client-side because the secret and the recovery codes must live in the page's own state and be
 * shown exactly once: rendering them into a server-rendered document would put them in the HTML, in
 * the RSC payload, and in whatever caches either. They are held here and nowhere else.
 *
 * The QR code is drawn from the `otpauth://` URI with a public image encoder rather than by shipping
 * a QR library — the URI is not a secret beyond this page, and a dependency for a single image is
 * not worth the supply-chain surface. The **secret** is also printed underneath, because an image
 * cannot be copied into a password manager and some authenticators only accept a typed secret.
 */

import { useActionState } from 'react';
import { Card } from '../../../components/ui';
import {
	beginMfaEnrolmentAction,
	confirmMfaEnrolmentAction,
	disableMfaAction,
	regenerateMfaCodesAction,
	type MfaActionState,
} from './actions';

const IDLE: MfaActionState = { kind: 'idle' };

const button = (background: string): React.CSSProperties => ({
	padding: '0.5rem 0.9rem',
	background,
	color: '#fff',
	border: 'none',
	borderRadius: '6px',
	fontSize: '0.8rem',
	cursor: 'pointer',
});

const input: React.CSSProperties = {
	width: '100%',
	maxWidth: '320px',
	padding: '0.55rem 0.75rem',
	background: '#0a0e1a',
	border: '1px solid #1a2340',
	borderRadius: '6px',
	color: '#f8fafc',
	fontSize: '0.85rem',
	boxSizing: 'border-box',
};

const label: React.CSSProperties = {
	display: 'block',
	fontSize: '0.75rem',
	fontWeight: 600,
	color: '#94a3b8',
	margin: '0.75rem 0 0.3rem',
};

function ErrorNote({ message }: { message: string }) {
	return (
		<div
			role="alert"
			style={{
				marginTop: '0.75rem',
				padding: '0.6rem 0.8rem',
				background: '#450a0a',
				border: '1px solid #7f1d1d',
				borderRadius: '6px',
				color: '#fecaca',
				fontSize: '0.8rem',
			}}
		>
			{message}
		</div>
	);
}

/** The codes, with the one warning that matters: this is the only time they are shown. */
function RecoveryCodes({ codes }: { codes: string[] }) {
	return (
		<div style={{ marginTop: '0.75rem' }}>
			<p style={{ fontSize: '0.78rem', color: '#fbbf24', margin: '0 0 0.5rem', fontWeight: 600 }}>
				These are shown once. Store them somewhere you can reach without this device.
			</p>
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
					gap: '0.35rem',
					fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
					fontSize: '0.8rem',
					color: '#e2e8f0',
				}}
			>
				{codes.map((code) => (
					<span key={code} style={{ background: '#0a0e1a', border: '1px solid #1a2340', borderRadius: '4px', padding: '0.3rem 0.45rem' }}>
						{code}
					</span>
				))}
			</div>
		</div>
	);
}

export default function MfaPanel({ enrolled, confirmed }: { enrolled: boolean; confirmed: boolean }) {
	const [enrolState, startEnrol, enrolling] = useActionState(beginMfaEnrolmentAction, IDLE);
	const [confirmState, confirm, confirming] = useActionState(confirmMfaEnrolmentAction, IDLE);
	const [regenState, regenerate, regenerating] = useActionState(regenerateMfaCodesAction, IDLE);
	const [disableState, disable, disabling] = useActionState(disableMfaAction, IDLE);

	// A confirmation result wins over the enrolment panel: once it exists, the secret is spent.
	const confirmation = confirmState.kind === 'confirmed' ? confirmState : regenState.kind === 'regenerated' ? regenState : null;
	const enrolment = enrolState.kind === 'enrolling' ? enrolState.enrolment : null;

	return (
		<>
			<Card
				title={confirmed ? 'Your second factor is active' : enrolled ? 'Finish enrolling' : 'Turn on two-factor authentication'}
				subtitle={
					confirmed
						? 'Sign-in requires a code from your authenticator app in addition to your password.'
						: 'You will need an authenticator app. Enrolment does nothing until you confirm a code.'
				}
			>
				{confirmation ? (
					<RecoveryCodes codes={confirmation.recoveryCodes} />
				) : enrolment ? (
					<div>
						<div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
							{/* Rendered by the browser from the URI; the URI itself is not a secret beyond this page. */}
							<img
								src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(enrolment.otpauthUri)}`}
								alt="Scan this with your authenticator app"
								width={180}
								height={180}
								style={{ background: '#fff', borderRadius: '6px', padding: '6px' }}
							/>
							<div style={{ flex: 1, minWidth: '260px' }}>
								<p style={{ fontSize: '0.8rem', color: '#94a3b8', margin: '0 0 0.4rem' }}>
									Scan the code, or type this secret into your app:
								</p>
								<code
									style={{
										display: 'block',
										background: '#0a0e1a',
										border: '1px solid #1a2340',
										borderRadius: '6px',
										padding: '0.5rem 0.7rem',
										fontSize: '0.85rem',
										color: '#e2e8f0',
										letterSpacing: '0.08em',
										wordBreak: 'break-all',
									}}
								>
									{enrolment.secret}
								</code>
								<p style={{ fontSize: '0.72rem', color: '#fbbf24', margin: '0.5rem 0 0' }}>
									This secret is shown once and cannot be read back.
								</p>
							</div>
						</div>

						<form action={confirm}>
							<label htmlFor="confirm-code" style={label}>
								Code from the app
							</label>
							<input
								id="confirm-code"
								name="code"
								inputMode="numeric"
								autoComplete="one-time-code"
								required
								placeholder="123456"
								style={input}
							/>
							<div style={{ marginTop: '0.75rem' }}>
								<button type="submit" disabled={confirming} style={button('#6366f1')}>
									{confirming ? 'Confirming…' : 'Confirm and enable'}
								</button>
							</div>
						</form>
					</div>
				) : confirmed ? (
					<>
						<form action={regenerate}>
							<label htmlFor="regen-code" style={label}>
								Replace recovery codes — enter a current code
							</label>
							<input id="regen-code" name="code" inputMode="numeric" required placeholder="123456" style={input} />
							<div style={{ marginTop: '0.75rem' }}>
								<button type="submit" disabled={regenerating} style={button('#334155')}>
									{regenerating ? 'Generating…' : 'Replace codes'}
								</button>
							</div>
						</form>

						<form action={disable} style={{ marginTop: '1.5rem', borderTop: '1px solid #1a2340', paddingTop: '1rem' }}>
							<label htmlFor="disable-password" style={label}>
								Disable two-factor authentication — password
							</label>
							<input
								id="disable-password"
								name="password"
								type="password"
								autoComplete="current-password"
								required
								style={input}
							/>
							<label htmlFor="disable-code" style={label}>
								and a current code
							</label>
							<input id="disable-code" name="code" inputMode="numeric" required placeholder="123456" style={input} />
							<p style={{ fontSize: '0.72rem', color: '#94a3b8', margin: '0.5rem 0 0' }}>
								Both are required. Your password alone must not be able to remove the control that
								exists to stop a phished password.
							</p>
							<div style={{ marginTop: '0.75rem' }}>
								<button type="submit" disabled={disabling} style={button('#7f1d1d')}>
									{disabling ? 'Disabling…' : 'Disable'}
								</button>
							</div>
						</form>
					</>
				) : (
					<form action={startEnrol}>
						<p style={{ fontSize: '0.82rem', color: '#94a3b8', margin: '0 0 0.75rem' }}>
							{enrolled
								? 'An earlier enrolment was never confirmed. Starting again replaces it.'
								: 'Starting enrolment shows a secret once. Nothing is enforced until you confirm a code.'}
						</p>
						<button type="submit" disabled={enrolling} style={button('#6366f1')}>
							{enrolling ? 'Starting…' : enrolled ? 'Start again' : 'Start enrolment'}
						</button>
					</form>
				)}

				{/* Every action's error, in one place, so the operator cannot miss which step failed. */}
				{[enrolState, confirmState, regenState, disableState]
					.filter((state): state is { kind: 'error'; message: string } => state.kind === 'error')
					.map((state, index) => (
						<ErrorNote key={index} message={state.message} />
					))}
			</Card>
		</>
	);
}
