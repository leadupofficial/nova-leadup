import { Router, Request, Response } from 'express';
import { HttpError } from '../middleware/error-handler';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';

const router = Router();

router.get('/chat/:sessionId', authenticate, (req: AuthenticatedRequest, res, next) => {
 try {
 res.status(200).json({ sessionId: req.params.sessionId, stream: false });
 } catch (err) { next(err); }
});

router.post('/chat/:sessionId', authenticate, (req: AuthenticatedRequest, res, next) => {
 try {
 res.status(200).json({ sessionId: req.params.sessionId, response: 'Stream placeholder' });
 } catch (err) { next(err); }
});

export { router as streamingRoutes };
