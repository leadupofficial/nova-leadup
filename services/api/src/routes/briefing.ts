/**
 * NOVA API — `GET /api/v1/briefing`.
 *
 * The daily briefing (§9.4), assembled server-side from the caller's own tasks,
 * reminders and memories and returned as text that is ready to be spoken. The
 * client is responsible for *when* it asks and for whether it opted in at all;
 * this route never pushes and never speaks on its own.
 *
 * `capabilities` is part of the payload on purpose. §9.4's example briefing
 * mentions meetings, and this repository has no calendar — no table, no route,
 * no provider — so a truthful briefing has to be able to say which sources it
 * actually had. Anything the briefing cannot see is reported as `false` rather
 * than silently omitted or, worse, filled in.
 */
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { BRIEFING_CAPABILITIES, composeBriefing } from '../services/briefing.js';

const router: ReturnType<typeof Router> = Router();

const BriefingQuerySchema = z.object({
	/** BCP-47-ish app language code (`en`, `ta`, `hi`, `tanglish`, …). */
	language: z.string().min(2).max(32).optional(),
});

router.get('/', authenticate, validate(BriefingQuerySchema, 'query'), async (req: AuthenticatedRequest, res, next) => {
	try {
		const q = (req as any).validatedQuery as z.infer<typeof BriefingQuerySchema>;
		const result = await composeBriefing(req.user!.id, { language: q.language });

		res.status(200).json({
			success: true,
			data: {
				text: result.text,
				source: result.source,
				language: result.language,
				counts: result.counts,
				guardRejection: result.guardRejection,
				generatedAt: result.generatedAt,
				capabilities: BRIEFING_CAPABILITIES,
			},
		});
	} catch (err) { next(err); }
});

export { router as briefingRoutes };
