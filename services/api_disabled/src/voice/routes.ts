/**
 * LEA-008 — Voice session HTTP routes.
 *
 * REST endpoints for managing voice sessions (separate from the WebSocket
 * path at /api/v1/voice/sessions which is handled by VoiceAdapter).
 *
 * Endpoints:
 * POST /api/v1/voice/sessions — start a new voice session
 * GET /api/v1/voice/sessions — list user's sessions
 * GET /api/v1/voice/sessions/:id — get session details
 * POST /api/v1/voice/sessions/:id/end — end a session
 * GET /api/v1/voice/config — get voice provider config
 */

import { Router } from 'express';
import { InMemoryVoiceSessionManager } from './voice-adapter';
import { transitionState, VoiceSessionState, type VoiceSession } from './voice-session';

const router: Router = Router();

// Shared session manager — in production, wire via app startup (same as VoiceAdapter)
const sessionManager = new InMemoryVoiceSessionManager();

function requireAuth(req: any, res: any, next: any) {
 if (!req.user?.id) {
 return res.status(401).json({ error: 'Unauthorized', message: 'Valid session required' });
 }
 next();
}

router.use(requireAuth);

// POST /api/v1/voice/sessions — start a new voice session
router.post('/sessions', async (req: any, res: any) => {
 try {
 const { language, model, audioFormat } = req.body;

 const session = sessionManager.create({
 userId: req.user.id,
 language: language ?? 'en',
 model,
 audioFormat,
 metadata: {
 startedVia: 'rest',
 userAgent: req.get('user-agent') ?? undefined,
 },
 });

 res.status(201).json({
 data: {
 sessionId: session.sessionId,
 state: session.state,
 language: session.language,
 model: session.model,
 audioFormat: session.audioFormat,
 createdAt: session.createdAt,
 },
 });
 } catch (error) {
 res.status(500).json({ error: 'Failed to start voice session', message: (error as Error).message });
 }
});

// GET /api/v1/voice/sessions — list user's sessions
router.get('/sessions', async (req: any, res: any) => {
 try {
 const sessions: VoiceSession[] = [];
 for (const s of sessionManager.getAll()) {
 if (s.userId === req.user.id) sessions.push(s);
 }
 // Sort most recent first
 sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

 res.json({
 data: sessions.map((s) => ({
 sessionId: s.sessionId,
 state: s.state,
 language: s.language,
 model: s.model,
 messageCount: s.messageCount,
 interruptCount: s.interruptCount,
 createdAt: s.createdAt,
 updatedAt: s.updatedAt,
 })),
 meta: { count: sessions.length },
 });
 } catch (error) {
 res.status(500).json({ error: 'Failed to list voice sessions', message: (error as Error).message });
 }
});

// GET /api/v1/voice/sessions/:id — get session details
router.get('/sessions/:id', async (req: any, res: any) => {
 try {
 const session = sessionManager.get(req.params.id);
 if (!session || session.userId !== req.user.id) {
 return res.status(404).json({ error: 'Not found', message: 'Voice session not found' });
 }

 res.json({
 data: {
 sessionId: session.sessionId,
 state: session.state,
 language: session.language,
 model: session.model,
 audioFormat: session.audioFormat,
 messageCount: session.messageCount,
 interruptCount: session.interruptCount,
 metadata: session.metadata,
 createdAt: session.createdAt,
 updatedAt: session.updatedAt,
 },
 });
 } catch (error) {
 res.status(500).json({ error: 'Failed to get voice session', message: (error as Error).message });
 }
});

// POST /api/v1/voice/sessions/:id/end — end a session
router.post('/sessions/:id/end', async (req: any, res: any) => {
 try {
 const session = sessionManager.get(req.params.id);
 if (!session || session.userId !== req.user.id) {
 return res.status(404).json({ error: 'Not found', message: 'Voice session not found' });
 }

 // Transition to ended state
 const ended = transitionState(session, VoiceSessionState.ENDED);
 // Update in manager
 const manager = sessionManager as InMemoryVoiceSessionManager;
 manager['sessions'].set(ended.sessionId, ended);

 res.json({
 data: {
 sessionId: ended.sessionId,
 state: ended.state,
 messageCount: ended.messageCount,
 interruptCount: ended.interruptCount,
 endedAt: ended.updatedAt,
 },
 });
 } catch (error) {
 const message = (error as Error).message;
 if (message.includes('Invalid state transition')) {
 return res.status(400).json({ error: 'Bad request', message });
 }
 res.status(500).json({ error: 'Failed to end voice session', message: message });
 }
});

// ─── Config ──────────────────────────────────────────────────────────────────

// GET /api/v1/voice/config — get voice provider configuration
router.get('/config', async (_req: any, res: any) => {
 try {
 const sttProvider = process.env.SARVAM_API_KEY ? 'sarvam' : 'noop';
 const ttsProvider = process.env.ELEVENLABS_API_KEY ? 'elevenlabs' : 'noop';

 res.json({
 data: {
 stt: {
 provider: sttProvider,
 supportedLanguages: ['en', 'ta', 'tanglish'],
 configured: !!process.env.SARVAM_API_KEY,
 },
 tts: {
 provider: ttsProvider,
 supportedLanguages: ['en', 'ta'],
 voices: sttProvider === 'sarvam'
 ? ['sarvam-default', 'sarvam-tamil-female']
 : ['noop-default'],
 configured: !!process.env.ELEVENLABS_API_KEY,
 },
 features: {
 interruption: true,
 captions: true,
 pushToTalk: true,
 continuousListening: false,
 },
 },
 });
 } catch (error) {
 res.status(500).json({ error: 'Failed to get voice config', message: (error as Error).message });
 }
});

export default router;
