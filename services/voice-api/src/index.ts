import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { validateEnv, type Env } from './utils/env.js';

const env: Env = validateEnv();
const app: ReturnType<typeof express> = express();
const PORT = env.PORT || 8082;

const MOBILE_DEFAULT_ORIGINS = ['https://nova.leadup.in', 'capacitor://localhost', 'ionic://localhost'];
const allowedOrigins = env.CORS_ORIGIN?.split(',').map((s) => s.trim()).filter(Boolean) ?? MOBILE_DEFAULT_ORIGINS;

app.use(
 cors({
 origin: (origin, cb) => {
 if (!origin) return cb(new Error("CORS: null origin not allowed"));
 if (allowedOrigins.includes(origin)) return cb(null, true);
 return cb(new Error(`CORS: origin ${origin} not allowed`));
 },
 credentials: true,
 }),
);
app.use(express.json({ limit: '10mb' }));

app.get('/health/live', (_, res) => res.json({ status: 'ok', ts: Date.now() }));
app.get('/health/ready', (_, res) => res.json({ status: 'ready', services: { elevenlabs: !!env.ELEVENLABS_API_KEY, sarvam: !!env.SARVAM_API_KEY } }));
app.get('/healthz', (_req, res) => res.json({ status: 'ok', service: 'voice-api', uptime: process.uptime() }));

const TTS_SCHEMA = z.object({
 text: z.string().min(1).max(500),
 lang: z.enum(['en', 'ta']),
 voiceId: z.string().optional(),
 emotion: z.enum(['neutral','happy','thinking','concerned','excited']).optional(),
});

// ─── Auth middleware (delegates to @nova/auth) ─────────────────────────────────
import { authenticateJwt } from '@nova/auth';

// Public health endpoints — no auth required
app.use((req, _res, next) => {
 if (req.path.startsWith('/health') || req.path === '/healthz') return next();
 authenticateJwt(req, _res, next);
});

app.post('/api/v1/tts', async (req: express.Request, res: express.Response) => {
 const parsed = TTS_SCHEMA.safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.issues });
 const { text, lang, voiceId, emotion } = parsed.data;
 try {
 if (env.ELEVENLABS_API_KEY && lang === 'en') {
 const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + (voiceId || '21m00Tcm4TlvDq8ikWAM'), {
 method: 'POST',
 headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
 body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
 });
 if (!response.ok) throw new Error('ElevenLabs error');
 const audioBuffer = Buffer.from(await response.arrayBuffer());
 res.setHeader('Content-Type', 'audio/mpeg');
 res.setHeader('X-Visemes', JSON.stringify([]));
 res.send(audioBuffer);
 } else if (env.SARVAM_API_KEY && lang === 'ta') {
 res.setHeader('Content-Type', 'audio/mpeg');
 res.send(Buffer.from(''));
 } else {
 res.status(503).json({ error: 'NO_TTS_PROVIDER', message: 'No TTS provider configured for this language' });
 }
 } catch (err: any) {
 console.error('[VoiceAPI] TTS error:', err);
 res.status(500).json({ error: 'TTS_FAILED', message: err.message });
 }
});

app.post('/api/v1/stt', async (req: express.Request, res: express.Response) => {
 const schema = z.object({ audio: z.string(), lang: z.enum(['en', 'ta']).optional() });
 const parsed = schema.safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
 const { lang } = parsed.data;
 try {
 res.json({ transcript: '[Transcription placeholder]', language: lang || 'en', confidence: 0.95 });
 } catch (err: any) {
 res.status(500).json({ error: 'STT_FAILED', message: err.message });
 }
});

const VISEME_SCHEMA = z.object({ text: z.string().min(1).max(500), lang: z.string().optional() });
app.post('/api/v1/visemes', (req: express.Request, res: express.Response) => {
 const parsed = VISEME_SCHEMA.safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
 res.json({ visemes: [], duration: 0 });
});

app.listen(PORT, () => console.log(`[VoiceAPI] Listening on :${PORT}`));
