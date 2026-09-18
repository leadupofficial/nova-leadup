/**
 * Webhooks routes — placeholder until full implementation.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';

const router: ReturnType<typeof Router> = Router();

router.use(authenticate);

router.post('/', (req: AuthenticatedRequest, res: Response) => {
	res.status(200).json({ success: true, message: 'Webhook endpoint - implementation pending' });
});

export default router;
