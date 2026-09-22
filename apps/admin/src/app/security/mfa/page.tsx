/**
 * Admin Control Center — two-factor authentication for the signed-in operator.
 *
 * §30 lists MFA/2FA alongside session management and forced logout, and the control plane had none:
 * an operator's account was protected by a password alone, and that same password unlocks every
 * other NOVA surface including the mobile app.
 *
 * ## What this page can and cannot do
 *
 * It acts on **your own account only**, because every route behind it takes the caller's identity
 * from their token and has no user id to tamper with. A SUPER_ADMIN cannot enrol, confirm or strip
 * another operator's factor here — recovering an operator who has lost both their phone and their
 * recovery codes is a deliberate human process, not a button in a console, and pretending otherwise
 * would mean an endpoint that can remove anyone's second factor.
 *
 * ## The two things shown once
 *
 * The **secret** at enrolment and the **recovery codes** at confirmation are rendered from the action
 * result and never fetched again: the secret is ciphertext at rest and the codes are hashes, so a
 * second read is impossible rather than merely unimplemented. The page says so, because an operator
 * who assumes they can come back for the codes will lose them.
 */

import { getMfaStatus } from '../../../lib/api';
import { loadPage } from '../../../lib/page-data';
import { PageError } from '../../../components/PageError';
import { Card, Metric, MetricGrid, Notes, PageHeader, StatusBadge, formatDateTime } from '../../../components/ui';
import MfaPanel from './MfaPanel';

export const dynamic = 'force-dynamic';

export default async function MfaPage() {
	const result = await loadPage<Awaited<ReturnType<typeof getMfaStatus>>>(async () => {
		const status = await getMfaStatus();
		return { rows: [status] };
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Two-Factor Authentication" />
				<PageError
					title="Could not load your two-factor status"
					message={result.message}
					status={result.status}
					retryHref="/security/mfa"
				/>
			</div>
		);
	}

	const status = result.rows[0];

	return (
		<div>
			<PageHeader
				title="Two-Factor Authentication"
				subtitle="Your own account. Enrolment is per account and applies to console sign-in."
			/>

			<MetricGrid minWidth={200}>
				<Metric
					label="Second factor"
					value={status.confirmed ? 'On' : status.enrolled ? 'Incomplete' : 'Off'}
					tone={status.confirmed ? 'good' : status.enrolled ? 'warn' : 'bad'}
					hint={
						status.confirmed
							? `Confirmed ${status.confirmedAt ? formatDateTime(status.confirmedAt) : ''}`
							: status.enrolled
								? 'Enrolment started but never confirmed — nothing is enforced yet'
								: 'A password alone protects this account'
					}
				/>
				<Metric
					label="Recovery codes left"
					value={status.confirmed ? status.remainingRecoveryCodes : null}
					tone={status.confirmed && status.remainingRecoveryCodes <= 2 ? 'warn' : 'default'}
					hint={status.confirmed ? 'Each works once, and replaces a code you cannot generate' : 'Issued when enrolment is confirmed'}
				/>
			</MetricGrid>

			<MfaPanel enrolled={status.enrolled} confirmed={status.confirmed} />

			<Notes
				notes={[
					'An unconfirmed enrolment is not enforced. If you start enrolling and abandon it, your password still signs you in — nothing is locked out until a code has been confirmed.',
					'The secret is shown once, when enrolment starts, and the recovery codes are shown once, when it is confirmed. Neither can be read back: the secret is encrypted at rest and the codes are stored only as hashes. Write the codes down now if you want them.',
					'Disabling needs your password and a current code together. A stolen console session cannot remove the control that exists to stop a stolen session.',
					'Codes are valid for one 30-second step and cannot be reused, so a code cannot be replayed within its own validity window.',
					'This page acts on your own account only. There is no route to enrol, confirm or remove another operator’s factor — recovering an operator who has lost both their phone and their codes is a separate, deliberate process.',
				]}
				tone="warn"
			/>
		</div>
	);
}
