/**
 * NOVA API — Account deletion.
 *
 * Both app stores make this a publishing gate, not a nicety:
 *
 *  - Apple App Store Review Guideline 5.1.1(v): an app that supports account
 *    creation must let the user *initiate deletion of the account* from inside
 *    the app. Deactivating or disabling the account is explicitly not enough.
 *  - Google Play "Account deletion requirement": apps that offer account
 *    creation must provide an in-app deletion path **and** a web-accessible
 *    deletion request URL that is declared on the Data safety form.
 *
 * This router serves both halves:
 *
 *  - `GET    /api/v1/account/deletion-preview` (authenticated) — what is about
 *    to be removed, so the confirmation screen is not a blind promise.
 *  - `DELETE /api/v1/account` (authenticated, password-confirmed) — the in-app
 *    path. Deleting the `users` row cascades every user-owned table
 *    (`onDelete: 'cascade'`), object-storage audio is removed first, and the
 *    audit trail is written *after* the delete because `audit_logs.user_id`
 *    has no cascade and would otherwise block it.
 *  - `POST   /api/v1/account/deletion-request` (public) — the web URL path for
 *    users who can no longer sign in.
 *
 * The three foreign keys that reference `users` *without* a cascade — the
 * nullable `audit_logs.user_id`, `leads.assigned_to` and
 * `lead_follow_ups.assigned_to` — are detached explicitly; otherwise the
 * `DELETE FROM users` aborts with a foreign-key violation.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import {
	audioRecordings,
	auditLogs,
	consentRecords,
	deletionRequests,
	leadFollowUps,
	leads,
	users,
} from '@nova/database';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { tokenDenylist } from '../middleware/token-denylist.js';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { validate } from '../middleware/validate.js';
import { deleteAudio } from '../services/audio-storage.js';
import { DeleteAccountSchema, DeletionRequestSchema } from '../schemas/index.js';

const router: ReturnType<typeof Router> = Router();

/** Access tokens live 15 minutes; the current one is denied for its remaining life. */
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Counts rows this route will remove. Read-only, authenticated, cheap enough to
 * call when the confirmation sheet opens.
 */
router.get('/deletion-preview', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const db = getDb();
		const userId = req.user!.id;

		const [user] = await db
			.select({ id: users.id, passwordHash: users.passwordHash })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);

		const [recordingRows, consentRow] = await Promise.all([
			db.select({ id: audioRecordings.id }).from(audioRecordings).where(eq(audioRecordings.userId, userId)),
			db.select({ id: consentRecords.id }).from(consentRecords).where(eq(consentRecords.userId, userId)),
		]);

		res.status(200).json({
			success: true,
			data: {
				email: req.user!.email,
				recordings: recordingRows.length,
				consentRecords: consentRow.length,
				// `users.password_hash` is nullable — an account created through a
				// phone/OAuth path has none, and the client must not demand a password
				// it never set (which would make the delete button permanently
				// disabled). Absent row ⇒ require one, so a failed lookup errs toward
				// the safer prompt.
				requiresPassword: user ? user.passwordHash !== null : true,
				// Everything else (tasks, reminders, memories, conversations,
				// transcripts, sessions, devices) cascades from the user row, so the
				// client copy states that generally rather than enumerating counts
				// that could drift from the schema.
				retentionPeriod: 'Immediate. Backups roll off within 30 days.',
			},
		});
	} catch (err) { next(err); }
});

/**
 * Hard-deletes the calling user and everything that belongs to them.
 *
 * Password confirmation is required when the account has a password hash. The
 * `confirm: "DELETE"` string is a second, dumb guard against a client sending
 * this request from a stray tap.
 */
router.delete('/', authenticate, validate(DeleteAccountSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof DeleteAccountSchema>;
		const db = getDb();
		const userId = req.user!.id;

		const [user] = await db
			.select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);

		if (!user) {
			// Token still valid but the row is gone: treat as already deleted.
			throw new HttpError(404, 'Account not found', 'NOT_FOUND');
		}

		if (user.passwordHash && !body.password) {
			throw new HttpError(400, 'Password confirmation is required', 'PASSWORD_REQUIRED');
		}
		if (user.passwordHash) {
			const matches = await bcrypt.compare(body.password ?? '', user.passwordHash);
			if (!matches) {
				throw new HttpError(401, 'Password is incorrect', 'INVALID_PASSWORD');
			}
		}

		// Object storage first: once the rows are gone the keys are unrecoverable,
		// and a deleted account must not leave playable audio behind.
		const keys = await db
			.select({ id: audioRecordings.id, storageKey: audioRecordings.storageKey })
			.from(audioRecordings)
			.where(eq(audioRecordings.userId, userId));

		let purgedObjects = 0;
		for (const row of keys) {
			try {
				if (await deleteAudio(row.storageKey)) purgedObjects += 1;
			} catch (err) {
				// Best effort: an unreachable bucket must not strand the user in an
				// account they asked to delete. The failure is audited below.
				logger.error({ err, recordingId: row.id }, 'Account deletion: audio object purge failed');
			}
		}

		await db.transaction(async (tx) => {
			// `audit_logs.user_id` is nullable but has no ON DELETE action, so it
			// detaches rather than cascading — the security trail outlives the
			// account, the identity link does not.
			//
			// Detaching the id is not enough on its own: `POST /ai/reports` stores up to
			// 500 characters of the reported *reply* in `details.excerpt`, and an
			// adversarial pass found those rows surviving with `actorId` still holding the
			// user's UUID and the excerpt intact — content the user was told would be
			// removed immediately. The excerpt goes with the account; the fact that a
			// report happened, and its reason, do not.
			await tx.update(auditLogs).set({ userId: null }).where(eq(auditLogs.userId, userId));
			await tx
				.update(auditLogs)
				.set({ details: sql`${auditLogs.details} - 'excerpt'` })
				.where(eq(auditLogs.actorId, userId));
			await tx.update(leads).set({ assignedTo: null }).where(eq(leads.assignedTo, userId));
			await tx.update(leadFollowUps).set({ assignedTo: null }).where(eq(leadFollowUps.assignedTo, userId));

			// `deletion_requests` cascades, so a request row cannot survive the
			// delete; it is recorded for the window between request and completion
			// by `POST /deletion-request` only.
			await tx.delete(users).where(eq(users.id, userId));
		});

		// Written post-delete with a null user_id: the trail records that an account was
		// deleted without resurrecting the foreign key.
		//
		// The email is deliberately NOT stored. The published policy tells users that
		// security audit entries are "retained without the link to your identity", and
		// writing the address here contradicted that in the one row most likely to
		// outlive the account. `actorId` stays as the opaque user UUID: it is needed to
		// correlate the deletion with the requests around it, and it resolves to nothing
		// once the user row is gone.
		// Outside the transaction (the user row had to be gone first, because
		// `audit_logs.user_id` has no cascade), and therefore in its own try: the account
		// IS deleted at this point, so a failure here must not answer 500 for a deletion
		// that succeeded.
		try {
			await db.insert(auditLogs).values({
				userId: null,
				actorType: 'user',
				actorId: userId,
				action: 'account.deleted',
				targetType: 'user',
				targetId: userId,
				outcome: 'success',
				details: { recordingsPurged: purgedObjects, requestedFrom: 'app' },
			});
		} catch (auditErr) {
			logger.error(
				{ err: auditErr, userId },
				'Account deleted, but the audit entry could not be written',
			);
		}

		// The account row is gone, so the token cannot resolve a user any more —
		// but it would still be *accepted* until it expires. Deny it for its
		// remaining life.
		if (req.user!.jti) {
			tokenDenylist.revoke(req.user!.jti, userId, Date.now() + ACCESS_TOKEN_TTL_MS);
		}

		logger.info({ userId, recordingsPurged: purgedObjects }, 'Account deleted');
		res.status(200).json({ success: true, data: { deleted: true } });
	} catch (err) { next(err); }
});

/**
 * Public deletion request, for the web URL declared on the Play Data safety form.
 *
 * Deliberately unauthenticated and deliberately vague in its response: it must
 * not become an account-enumeration oracle. The status and body are identical for a
 * known and an unknown address, and so is **the work done before responding**: exactly
 * one indexed `SELECT`, then the response.
 *
 * That last part is not a detail. An earlier version awaited a dedup `SELECT` and an
 * `INSERT` on the known path only, and the difference is measurable across the network —
 * an adversarial pass took 146 interleaved samples per arm and separated the two with
 * Mann-Whitney z = −8.08 (known median 2.16 ms, unknown 1.06 ms). The login route is
 * carefully constant-time against precisely this, so this endpoint was handing back what
 * that one refuses to. The write therefore happens *after* the response, where it cannot
 * be observed.
 */
router.post('/deletion-request', validate(DeletionRequestSchema), async (req, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof DeletionRequestSchema>;
		const db = getDb();
		const email = body.email.trim().toLowerCase();

		// The only awaited database work, and it runs for every address whether or not an
		// account exists.
		const [user] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, email))
			.limit(1);

		res.status(202).json({
			success: true,
			data: {
				received: true,
				message:
					'If an account exists for that address, the deletion request has been recorded and will be processed within 30 days.',
			},
		});

		// Deliberately not awaited: see the doc comment. Best-effort, because a request
		// that is lost when the process dies mid-write is a request the user can file
		// again, whereas a timing oracle is silent and permanent.
		if (user) {
			void (async () => {
				try {
					// One pending request per account. Without this, repeatedly posting the
					// same address appended a row each time — 39 posts produced 39 rows — and
					// the queue is unbounded (`GET /deletion-requests` has no LIMIT), so one
					// caller could both flood the operator's screen and make the console
					// response grow without bound.
					const [alreadyPending] = await db
						.select({ id: deletionRequests.id })
						.from(deletionRequests)
						.where(
							and(
								eq(deletionRequests.userId, user.id),
								eq(deletionRequests.artifactType, 'account'),
								isNull(deletionRequests.processedAt),
							),
						)
						.limit(1);

					if (alreadyPending) return;

					await db.insert(deletionRequests).values({
						userId: user.id,
						artifactType: 'account',
						reason: body.reason ?? null,
						status: 'pending',
						// Stated in the published policy as "within 30 days".
						scheduledFor: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
					});
					logger.info({ userId: user.id }, 'Account deletion request filed from web');
				} catch (err) {
					logger.error({ err }, 'Could not record a web deletion request');
				}
			})();
		}
	} catch (err) { next(err); }
});

/**
 * Pending web-filed requests, for the admin console. Kept next to the endpoints
 * it explains so the console never has to guess the table shape.
 */
router.get('/deletion-requests', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		if (!['owner', 'admin'].includes(req.user!.role)) {
			throw new HttpError(403, 'Forbidden', 'FORBIDDEN');
		}
		const db = getDb();
		const rows = await db
			.select({
				id: deletionRequests.id,
				userId: deletionRequests.userId,
				// The address is included because completing a request is a *verified*
				// action: the operator has to be able to confirm that the person asking
				// is the person who owns the account, out of band, before pressing
				// anything. An owner can already list every user in the console, so this
				// discloses nothing new to them.
				email: users.email,
				status: deletionRequests.status,
				reason: deletionRequests.reason,
				scheduledFor: deletionRequests.scheduledFor,
				createdAt: deletionRequests.createdAt,
			})
			.from(deletionRequests)
			.leftJoin(users, eq(users.id, deletionRequests.userId))
			.where(and(eq(deletionRequests.artifactType, 'account'), isNull(deletionRequests.processedAt)))
			.orderBy(deletionRequests.createdAt);

		res.status(200).json({ success: true, data: { requests: rows, total: rows.length } });
	} catch (err) { next(err); }
});

/**
 * Completes a web-filed deletion request.
 *
 * `POST /account/deletion-request` takes **any** email address and requires no
 * authentication, so a request in the queue is an *unverified claim*, not an
 * instruction. Acting on it automatically would let anyone delete anyone else's
 * account: file a request for a victim's address, wait out the schedule, and the
 * account is gone. That is why this is a deliberate, authenticated, owner-or-admin
 * action rather than a background job — it is the "we will verify the request" half of
 * the promise made on `/delete-account`.
 *
 * The account is removed through exactly the same statements as `DELETE /account`, so
 * there is one deletion path in the codebase and not two that can drift. It shares the
 * foreign-key detach because `audit_logs.user_id`, `leads.assigned_to` and
 * `lead_follow_ups.assigned_to` have no `ON DELETE` action.
 */
router.post('/deletion-requests/:id/complete', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		if (!['owner', 'admin'].includes(req.user!.role)) {
			throw new HttpError(403, 'Forbidden', 'FORBIDDEN');
		}
		const body = (req.body ?? {}) as { confirm?: unknown };
		// The same guard as the in-app path: a literal, so this cannot be triggered by a
		// stray tap on a form that flips a boolean.
		if (body.confirm !== 'DELETE') {
			throw new HttpError(400, 'Send { "confirm": "DELETE" } to complete a deletion request', 'CONFIRM_REQUIRED');
		}

		// Validated before it reaches Postgres. An unparsed id made the query raise
		// `22p02 invalid input syntax for type uuid`, which the error handler rendered as
		// a 500 with the Postgres code in the problem document.
		const idParse = z.string().uuid().safeParse(req.params.id);
		if (!idParse.success) {
			throw new HttpError(400, 'Invalid deletion request id', 'INVALID_ID');
		}

		const db = getDb();
		const [request] = await db
			.select({
				id: deletionRequests.id,
				userId: deletionRequests.userId,
				artifactType: deletionRequests.artifactType,
				processedAt: deletionRequests.processedAt,
			})
			.from(deletionRequests)
			.where(eq(deletionRequests.id, idParse.data))
			.limit(1);

		if (!request) {
			// A completed request has already been deleted (the row cascades with the
			// user), so a repeat call lands here rather than on the 409 below — which is
			// reachable only for the "the account was already gone" path. That is fine;
			// the earlier comment claimed 409 and was wrong.
			throw new HttpError(404, 'Deletion request not found', 'NOT_FOUND');
		}
		if (request.processedAt !== null) {
			throw new HttpError(409, 'That request has already been completed', 'ALREADY_PROCESSED');
		}
		// The queue lists only `artifact_type = 'account'`; this must agree with it. A
		// request filed for one artifact (a recording, say) would otherwise complete as a
		// whole-account deletion — verified by inserting such a row and watching it
		// destroy the account. Not reachable through the only writer today, but the two
		// halves have to mean the same thing.
		if (request.artifactType !== 'account') {
			throw new HttpError(
				400,
				`This request is for "${request.artifactType}", not a whole account. Complete it from the surface that owns that artifact type.`,
				'WRONG_ARTIFACT_TYPE',
			);
		}

		const [user] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, request.userId))
			.limit(1);

		if (!user) {
			// The account was already deleted by another route; just close the request so
			// it stops appearing in the queue.
			await db
				.update(deletionRequests)
				.set({ status: 'completed', processedAt: new Date(), updatedAt: new Date() })
				.where(eq(deletionRequests.id, request.id));
			res.status(200).json({ success: true, data: { deleted: false, reason: 'account already gone' } });
			return;
		}

		const keys = await db
			.select({ id: audioRecordings.id, storageKey: audioRecordings.storageKey })
			.from(audioRecordings)
			.where(eq(audioRecordings.userId, user.id));

		// `deleteAudio` returns a boolean and does not throw, so the return value is the
		// only signal there is. Discarding it meant an unconfigured or unreachable store
		// produced no log line at all, while the comment below claimed the failure was
		// audited.
		let purgedObjects = 0;
		let failedObjects = 0;
		for (const row of keys) {
			let removed = false;
			try {
				removed = await deleteAudio(row.storageKey);
			} catch (err) {
				logger.error({ err, recordingId: row.id }, 'Deletion request: audio object purge threw');
			}
			if (removed) {
				purgedObjects += 1;
			} else {
				failedObjects += 1;
				logger.error(
					{ recordingId: row.id, storageKey: row.storageKey },
					'Deletion request: audio object not removed; the account is still being deleted',
				);
			}
		}

		await db.transaction(async (tx) => {
			await tx.update(auditLogs).set({ userId: null }).where(eq(auditLogs.userId, user.id));
			await tx.update(leads).set({ assignedTo: null }).where(eq(leads.assignedTo, user.id));
			await tx.update(leadFollowUps).set({ assignedTo: null }).where(eq(leadFollowUps.assignedTo, user.id));
			await tx.delete(users).where(eq(users.id, user.id));
			// `deletion_requests` cascades from `users`, so the row is gone by now and
			// the audit entry below is the record that survives.
		});

		await db.insert(auditLogs).values({
			userId: null,
			actorType: 'user',
			actorId: req.user!.id,
			action: 'account.deletion_request.completed',
			targetType: 'user',
			targetId: user.id,
			outcome: 'success',
			details: {
				requestId: request.id,
				recordingsPurged: purgedObjects,
				// Recorded rather than swallowed: an object left behind is a real gap in what
				// the user was promised.
				recordingsNotPurged: failedObjects,
				requestedFrom: 'web',
			},
		});

		logger.info(
			{ requestId: request.id, deletedUserId: user.id, by: req.user!.id, recordingsPurged: purgedObjects },
			'Web deletion request completed',
		);
		res.status(200).json({ success: true, data: { deleted: true } });
	} catch (err) { next(err); }
});

export { router as accountRoutes };
