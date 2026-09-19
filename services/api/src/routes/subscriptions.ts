/**
 * Subscriptions routes — placeholder until full implementation.
 */
import { Router, Request, Response } from 'express';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';

const router: ReturnType<typeof Router> = Router();

router.use(authenticate);

router.get('/', (req: AuthenticatedRequest, res: Response) => {
	// This returned HTTP 200 with { success: true, data: null, message:
	// "implementation pending" }. A success envelope carrying no data is harder to
	// detect than a 404 - the client sees the shape it expects and reports the
	// feature as working. 501 is the honest answer until subscriptions exist, which
	// matters because the product is sold on a subscription tier.
	res.status(501).json({
		success: false,
		error: {
			code: 'NOT_IMPLEMENTED',
			message: 'Subscription management is not implemented yet.',
		},
	});
});

export default router;
