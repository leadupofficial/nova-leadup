import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';

const router = Router();

const AISummarizeSchema = z.object({ text: z.string().min(1), maxLength: z.number().optional() });
const AIEmbedSchema = z.object({ text: z.string().min(1) });

router.post('/summarize', authenticate, async (req: AuthenticatedRequest, res, next) => {
 try {
 AISummarizeSchema.parse(req.body);
 res.status(200).json({ summary: 'AI summary placeholder', originalLength: req.body.text.length });
 } catch (err) { next(err); }
});

router.post('/embed', authenticate, async (req: AuthenticatedRequest, res, next) => {
 try {
 AIEmbedSchema.parse(req.body);
 res.status(200).json({ embedding: [], dimensions: 1536 });
 } catch (err) { next(err); }
});

router.get('/models', (req, res) => {
 res.json({ models: [{ id: 'nova-1', name: 'NOVA-1', provider: 'anthropic', contextWindow: 200000 }] });
});

export { router as aiRoutes };
