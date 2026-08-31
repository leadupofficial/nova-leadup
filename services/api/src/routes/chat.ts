import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';

const router = Router();

const ChatMessageSchema = z.object({ sessionId: z.string().uuid(), content: z.string().min(1), metadata: z.record(z.string(), z.unknown()).optional() });

router.post('/message', authenticate, async (req: AuthenticatedRequest, res, next) => {
 try {
 const body = ChatMessageSchema.parse(req.body);
 res.status(200).json({ message: 'Chat endpoint', sessionId: body.sessionId, content: body.content });
 } catch (err) { next(err); }
});

router.get('/history/:sessionId', authenticate, (req: AuthenticatedRequest, res) => {
 res.json({ messages: [], sessionId: req.params.sessionId });
});

router.delete('/history/:sessionId', authenticate, (req, res) => {
 res.status(204).send();
});

export { router as chatRoutes };
