/**
 * NOVA — authentication events.
 *
 * ## Why this module exists
 *
 * Nothing recorded a login attempt. `users.last_login_at` kept the timestamp of the most recent
 * **successful** sign-in for one account with no client information, and a failed attempt left no
 * trace anywhere: `audit_logs` and `admin_audit_logs` had no auth rows at all. The practical
 * consequence is that the question a control plane most needs to answer during an incident —
 * *"is somebody trying to get into this console, and from where"* — could not be answered from
 * persisted data. The Security Center was written to report "failed admin logins" and had to say
 * NOT AVAILABLE instead.
 *
 * ## What is recorded, and what is deliberately not
 *
 * Recorded: the attempted address (lower-cased, trimmed, length-capped), whether it succeeded, a
 * machine-readable reason, the account id **when the address matched a real account**, the IP, the
 * user agent and the request id.
 *
 * **Never recorded: the password, or anything derived from it.** Nothing in this module touches the
 * submitted credential; the route decides the outcome and passes only a reason string.
 *
 * ## The two trade-offs this makes, stated rather than hidden
 *
 * 1. **A failed attempt names an address that may not exist.** That is the point — "which addresses
 *    are being tried" is the credential-stuffing signal — but it does mean the table accumulates
 *    addresses people mistype. The row carries no account id in that case, so it cannot be joined
 *    to a user, and the Security Center reports it as an unmatched attempt rather than as activity
 *    on an account.
 * 2. **An attacker can write rows.** This is an append-only table with no pruning, so a distributed
 *    attempt inflates it. The auth route's rate limiter caps per-IP attempts and the rows are small,
 *    but the growth is real and is the price of having the signal at all. Ignoring failed logins to
 *    save rows would mean not noticing them, which is worse.
 *
 * ## Failure behaviour
 *
 * Never throws. A login that succeeded must not become a 500 because the audit write failed — the
 * same rule `recordAdminAction` follows. The failure is logged at error level so a broken sink is
 * visible rather than silent.
 */

import { auditLogs } from '@nova/database';
import { getDb } from '../db/connection.js';
import { logger } from '../utils/logger.js';

/** Why an attempt succeeded or failed. Stable strings: the Security Center groups by them. */
export const LOGIN_REASONS = [
	'ok',
	'unknown-account',
	'bad-password',
	'account-disabled',
	// The credential was correct and the account has a second factor: either it was not supplied, or
	// the one supplied was wrong. Distinguished from `bad-password` because "the password is right
	// and the code is failing" is a support call, not an attack.
	'mfa-required',
	'mfa-invalid',
] as const;

export type LoginReason = (typeof LOGIN_REASONS)[number];

/** Addresses are stored as typed, but bounded — the column is varchar(100) for the actor id. */
const MAX_EMAIL_LENGTH = 254;
const MAX_USER_AGENT_LENGTH = 255;
const MAX_REQUEST_ID_LENGTH = 100;

function clamp(value: string | null, max: number): string | null {
	if (value === null) return null;
	const trimmed = value.trim();
	return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

export type LoginAttempt = {
	/** The address the client sent. Recorded even when no account matches it. */
	email: string | null;
	reason: LoginReason;
	/** Known only when the address matched an account. */
	userId: string | null;
	ipAddress: string | null;
	userAgent: string | null;
	requestId: string | null;
};

/**
 * Writes one row for a sign-in attempt.
 *
 * `actorType` is `'user'` only when the attempt is attributable to a real account; an unmatched
 * address is `'anonymous'` with a null `actorId`, so a later join can never pin an unknown address
 * to somebody. The action name distinguishes the two outcomes so a query for failures is exact
 * rather than a string match on the details.
 */
export async function recordLoginAttempt(attempt: LoginAttempt): Promise<void> {
	const succeeded = attempt.reason === 'ok';
	try {
		const db = getDb();
		await db.insert(auditLogs).values({
			userId: attempt.userId ?? null,
			actorType: attempt.userId ? 'user' : 'anonymous',
			actorId: attempt.userId ?? null,
			action: succeeded ? 'auth.login' : 'auth.login_failed',
			targetType: 'session',
			targetId: null,
			outcome: succeeded ? 'success' : 'failure',
			details: {
				// The attempted address travels in `details`, not in `actor_id`: on a failed attempt
				// it is a claim by the caller, not an identity, and conflating the two is how a log
				// ends up asserting that an account did something it did not.
				attemptedEmail: clamp(attempt.email?.toLowerCase() ?? null, MAX_EMAIL_LENGTH),
				reason: attempt.reason,
				// `audit_logs` has no IP column (unlike `admin_audit_logs`), so the client address
				// lives here. "Which addresses are being tried, from where" is the whole point of
				// recording a failure, and it cannot be answered without it.
				clientIp: clamp(attempt.ipAddress, 45),
			},
			sourceDevice: clamp(attempt.userAgent, MAX_USER_AGENT_LENGTH),
			requestId: clamp(attempt.requestId, MAX_REQUEST_ID_LENGTH),
		});
	} catch (error) {
		logger.error({ err: error, reason: attempt.reason }, '[auth-events] could not record the login attempt');
	}
}
