import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';

const router = Router();

const VoiceTranscribeSchema = z.object({ audioUrl: z.string().url(), language: z.string().length(2).optional() });

router.post('/transcribe', authenticate, async (req: AuthenticatedRequest, res, next) => {
 try {
 VoiceTranscribeSchema.parse(req.body);
 res.status(200).json({ text: 'Voice transcription placeholder', confidence: 0.95 });
 } catch (err) { next(err); }
});

router.post('/speak', authenticate, async (req: AuthenticatedRequest, res, next) => {
 try {
 const body = z.object({ text: z.string().min(1), voice: z.string().optional() }).parse(req.body);
 res.status(200).json({ audioUrl: null, format: 'mp3', voice: body.voice || 'default' });
 } catch (err) { next(err); }
});

export { router as voiceRoutes };
