/**
 * NOVA — administrator MFA routes.
 *
 * ## Self-service, on purpose
 *
 * Every route here acts on **the caller's own account**, taken from the authenticated actor. There
 * is no `:userId` parameter, which means there is no parameter to tamper with: the IDOR class of bug
 * that a "manage another operator's second factor" endpoint would introduce simply cannot be
 * expressed. A SUPER_ADMIN cannot enrol, confirm or strip another operator's factor through these
 * routes — recovering an operator who has lost both their phone and their recovery codes is a
 * deliberate, separate, human process rather than a button.
 *
 * ## Why disabling needs the password
 *
 * `disable` and `regenerate recovery codes` sit behind the factor itself, because a stolen console
 * session must not be able to remove the control that exists to stop a stolen session. Disabling
 * additionally requires the account's **current password** — the re-authentication §47 asks for on a
 * destructive action — so a session hijacked from a machine where the password was not typed cannot
 * strip the factor on its way out.
 *
 * ## What is never returned
 *
 * The TOTP secret is returned **once**, at enrolment. The recovery codes are returned **once**, at
 * confirmation. Neither can be read back: the secret is ciphertext at rest and the codes are
 * hashes, so a second read is impossible rather than merely unimplemented.
 */

import { Router, type NextFunction, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { users } from '@nova/database';
import { z } from 'zod';
import { type AdminRequest, adminGate, requirePermission } from '../../admin/access.js';
import { actorFromRequest, auditedOperation } from '../../admin/audit.js';
import {
	beginEnrolment,
	confirmEnrolment,
	countEnrolledAdmins,
	disableMfa,
	mfaStatusFor,
	regenerateRecoveryCodes,
	verifySecondFactor,
} from '../../admin/mfa.js';
import { getDb } from '../../db/connection.js';
import { HttpError } from '../../middleware/error-handler.js';
import { validate } from '../../middleware/validate.js';

const router: ReturnType<typeof Router> = Router();
router.use(adminGate);

/**
 * The authenticated actor, or a 401.
 *
 * `adminGate` guarantees one, but it is typed optional because it is also read on routes that run
 * before the gate. Resolving it in one place keeps the invariant explicit instead of scattering
 * non-null assertions through every handler.
 */
function actorOf(req: AdminRequest) {
	const actor = actorFromRequest(req);
	if (!actor) throw new HttpError(401, 'No administrator context on this request', 'UNAUTHORIZED');
	return actor;
}

/** A six-digit TOTP code or a twelve-character recovery code; the service decides which. */
const CodeSchema = z.object({ code: z.string().min(4).max(64) });

/**
 * The caller's own factor status.
 *
 * Deliberately not behind a permission: this is an operator reading their **own** account's security
 * state, and requiring `security.read` would mean an operator who can administer users but not read
 * the security dashboard could not see whether their own second factor is on.
 */
router.get('/admin-mfa', async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		res.json({ success: true, data: await mfaStatusFor(actorOf(req).id) });
	} catch (error) {
		next(error);
	}
});

/** How many administrators are covered. For the Security Center. */
router.get(
	'/admin-mfa/coverage',
	requirePermission('security.read'),
	async (_req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			res.json({ success: true, data: await countEnrolledAdmins() });
		} catch (error) {
			next(error);
		}
	},
);

router.post('/admin-mfa/enrol', async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const actor = actorOf(req);
		const result = await beginEnrolment(actor.id, actor.email);
		if ('blocked' in result) {
			throw new HttpError(
				409,
				'A second factor is already confirmed on this account. Disable it first to enrol a new device.',
				'MFA_ALREADY_CONFIRMED',
			);
		}

		await auditedOperation({
			req,
			action: 'admin_mfa.enrol_started',
			permission: null,
			targetType: 'admin_mfa',
			targetId: actor.id,
			reason: 'Started two-factor enrolment for their own account',
			// Only the fact, never the secret: the audit table is readable and the secret is not.
			before: { enrolled: false },
			// `after` is a projection of the result, not a literal: the audit row must not be able to
			// claim something the operation did not return.
			after: () => ({ enrolled: true, confirmed: false }),
			run: async () => ({ started: true }),
		});

		// Shown once. `secret` is in the body because the operator has to type it into an app; the
		// `otpauthUri` is what a QR code would encode.
		res.json({ success: true, data: result });
	} catch (error) {
		next(error);
	}
});

router.post(
	'/admin-mfa/confirm',
	validate(CodeSchema),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { code } = (req as unknown as { validatedBody: { code: string } }).validatedBody;
			const actor = actorOf(req);
			const result = await confirmEnrolment(actor.id, code);
			if (!result.ok) {
				const message =
					result.reason === 'not-started'
						? 'No enrolment is in progress for this account.'
						: result.reason === 'already-confirmed'
							? 'This account already has a confirmed second factor.'
							: 'That code is not valid for the secret on this account.';
				throw new HttpError(result.reason === 'invalid-code' ? 400 : 409, message, `MFA_${result.reason.toUpperCase().replace('-', '_')}`);
			}

			await auditedOperation({
				req,
				action: 'admin_mfa.confirmed',
				permission: null,
				targetType: 'admin_mfa',
				targetId: actor.id,
				reason: 'Confirmed two-factor enrolment with a valid code',
				before: { confirmed: false },
				after: () => ({ confirmed: true, recoveryCodesIssued: result.recoveryCodes.length }),
				run: async () => ({ confirmed: true }),
			});

			res.json({
				success: true,
				data: {
					confirmed: true,
					// Returned exactly once. The table holds only hashes, so this is the only chance to
					// record them.
					recoveryCodes: result.recoveryCodes,
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

router.post(
	'/admin-mfa/recovery-codes',
	validate(CodeSchema),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { code } = (req as unknown as { validatedBody: { code: string } }).validatedBody;
			const actor = actorOf(req);
			const result = await regenerateRecoveryCodes(actor.id, code);
			if (!result.ok) {
				throw new HttpError(403, 'A currently valid code is required to replace recovery codes.', 'MFA_CODE_REQUIRED');
			}

			await auditedOperation({
				req,
				action: 'admin_mfa.recovery_codes_regenerated',
				permission: null,
				targetType: 'admin_mfa',
				targetId: actor.id,
				reason: 'Replaced their recovery codes',
				before: null,
				after: () => ({ issued: result.recoveryCodes.length }),
				run: async () => ({ regenerated: true }),
			});

			res.json({ success: true, data: { recoveryCodes: result.recoveryCodes } });
		} catch (error) {
			next(error);
		}
	},
);

/**
 * Removes the factor. Requires the account's current password **and** a current factor code.
 *
 * Both, not either. The password proves the person at the keyboard is the account holder; the code
 * proves they still hold the second factor. Requiring only the password would make a phished
 * password sufficient to remove the control installed against phishing, which is the one thing MFA
 * exists to prevent.
 */
router.post('/admin-mfa/disable', async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const body = z
			.object({ password: z.string().min(1), code: z.string().min(4).max(64) })
			.parse(req.body);

		const actor = actorOf(req);
		const status = await mfaStatusFor(actor.id);
		if (!status.confirmed) {
			throw new HttpError(409, 'This account has no confirmed second factor to disable.', 'MFA_NOT_ENROLLED');
		}

		const [account] = await getDb()
			.select({ passwordHash: users.passwordHash })
			.from(users)
			.where(eq(users.id, actor.id))
			.limit(1);

		if (!account?.passwordHash || !(await bcrypt.compare(body.password, account.passwordHash))) {
			// One message for both a wrong password and a wrong code, so this route cannot be used to
			// confirm a guessed password.
			throw new HttpError(403, 'The password or verification code is not correct.', 'MFA_REAUTH_FAILED');
		}

		const verified = await verifySecondFactor(actor.id, body.code);
		if (!verified.ok) {
			throw new HttpError(403, 'The password or verification code is not correct.', 'MFA_REAUTH_FAILED');
		}

		await disableMfa(actor.id);
		await auditedOperation({
			req,
			action: 'admin_mfa.disabled',
			permission: null,
			targetType: 'admin_mfa',
			targetId: actor.id,
			reason: 'Disabled two-factor authentication with password and a valid code',
			before: { confirmed: true },
			after: () => ({ confirmed: false }),
			run: async () => ({ disabled: true }),
		});

		res.json({ success: true, data: { confirmed: false } });
	} catch (error) {
		next(error);
	}
});

export default router;
