/**
 * Subscriptions routes — placeholder until full implementation.
 */
import { Router, Request, Response } from 'express';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';

const router: ReturnType<typeof Router> = Router();

router.use(authenticate);

router.get('/', (req: AuthenticatedRequest, res: Response) => {
	res.status(200).json({ success: true, data: null, message: 'Subscriptions endpoint - implementation pending' });
});

export default router;
