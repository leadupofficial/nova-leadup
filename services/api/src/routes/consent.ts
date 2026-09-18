/**
 * NOVA API — Consent ledger, backed by `consent_records`.
 *
 * Consent is append-only: recording a decision inserts a row and never mutates
 * history. Revoking a purpose additionally stamps `revoked_at` on the open
 * granted row so "is this purpose active?" is answerable from the newest row
 * alone without rewriting the audit trail.
 *
 * Every statement is scoped to `req.user!.id`.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { consentRecords } from '@nova/database';
import { eq, desc, and, isNull } from 'drizzle-orm';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { validate } from '../middleware/validate.js';
import { CreateConsentSchema } from '../schemas/index.js';

const router: ReturnType<typeof Router> = Router();

// ─── /consent ────────────────────────────────────────────────────────────────

router.get('/', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const db = getDb();

		// The set of purposes is small and fixed, so the whole ledger is returned
		// rather than a page that a client could silently truncate.
		const rows = await db.select({
			id: consentRecords.id,
			purpose: consentRecords.purpose,
			granted: consentRecords.granted,
			method: consentRecords.method,
			consentedAt: consentRecords.consentedAt,
			revokedAt: consentRecords.revokedAt,
		})
			.from(consentRecords)
			.where(eq(consentRecords.userId, req.user!.id))
			.orderBy(desc(consentRecords.consentedAt));

		res.status(200).json({ success: true, data: { consent: rows } });
	} catch (err) { next(err); }
});

router.post('/', authenticate, validate(CreateConsentSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof CreateConsentSchema>;
		const db = getDb();
		const userId = req.user!.id;
		const now = new Date();

		// A revocation closes the currently-open grant for that purpose, if any.
		if (body.granted === false) {
			await db.update(consentRecords)
				.set({ revokedAt: now })
				.where(and(
					eq(consentRecords.userId, userId),
					eq(consentRecords.purpose, body.purpose),
					eq(consentRecords.granted, true),
					isNull(consentRecords.revokedAt),
				));
		}

		const [record] = await db.insert(consentRecords).values({
			userId,
			purpose: body.purpose,
			granted: body.granted,
			// `method` is NOT NULL; the client does not always say how consent
			// was captured, so in-app capture is the default.
			method: body.method ?? 'app',
			ipAddress: req.ip ?? null,
			userAgent: req.headers['user-agent'] ?? null,
			consentedAt: now,
		}).returning();

		logger.info({ consentId: record.id, userId, purpose: body.purpose, granted: body.granted }, 'Consent recorded');
		res.status(201).json({ success: true, data: record });
	} catch (err) { next(err); }
});

export { router as consentRoutes };
