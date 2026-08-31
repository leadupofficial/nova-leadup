import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler';
import { authenticate } from '../middleware/auth';
import { voiceService } from '../services/voice';

export const voiceRouter = Router();

voiceRouter.use(authenticate);

// Get voice status
voiceRouter.get('/status', asyncHandler(async (req, res) => {
 const status = await voiceService.getStatus(req.user!.id);
 res.json(status);
}));

// Start listening
voiceRouter.post('/listen', asyncHandler(async (req, res) => {
 const session = await voiceService.startListening(req.user!.id, req.body);
 res.status(201).json(session);
}));

// Stop listening
voiceRouter.post('/listen/:sessionId/stop', asyncHandler(async (req, res) => {
 const transcript = await voiceService.stopListening(req.user!.id, req.params.sessionId);
 res.json(transcript);
}));

// Text-to-speech
voiceRouter.post('/speak', asyncHandler(async (req, res) => {
 const { text, voice } = req.body;

 if (!text) {
 return res.status(400).json({ error: 'Text is required' });
 }

 const audio = await voiceService.synthesizeSpeech({
 text,
 voice: voice || 'nova',
 userId: req.user!.id,
 });

 res.setHeader('Content-Type', 'audio/mpeg');
 audio.pipe(res);
}));

// Available voices
voiceRouter.get('/voices', asyncHandler(async (req, res) => {
 const voices = await voiceService.getVoices(req.user!.id);
 res.json({ voices });
}));
