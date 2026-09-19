/**
 * Webhooks routes — placeholder until full implementation.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';

const router: ReturnType<typeof Router> = Router();

router.use(authenticate);

router.post('/', (req: AuthenticatedRequest, res: Response) => {
	res.status(501).json({
		success: false,
		error: {
			code: 'NOT_IMPLEMENTED',
			message: 'Integration webhooks is not implemented yet.',
		},
	});
});

export default router;
