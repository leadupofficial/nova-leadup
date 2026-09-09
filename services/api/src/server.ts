// dotenv removed — env injected by docker / CI
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { z } from 'zod';
import { validateEnv } from './utils/env';
import { migrate } from '@nova/database';
import authRoutes from './routes/auth';
import { chatRoutes } from './routes/chat';
import { conversationsRoutes } from './routes/conversations';
import { tasksRoutes } from './routes/tasks';
import { memoriesRoutes } from './routes/memories';
import { settingsRoutes } from './routes/settings';
import { streamingRoutes } from './routes/streaming';
import { voiceRoutes } from './routes/voice';
import { healthRoutes } from './routes/health';
import { biometricRoutes } from './routes/biometric';
import adminRoutes from './routes/admin';
import { errorHandler } from './middleware/error-handler';

// ─── Env validation (fail fast) ────────────────────────────────────────────
validateEnv();

const app: ReturnType<typeof express> = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Security
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || ['https://nova.leadup.in'], credentials: true }));
app.use(helmet());
app.use(compression() as any);

// Body parsing
app.use(express.json({ limit: '5mb' }));

// Request ID
app.use((req, res, next) => {
 res.setHeader('X-Request-Id', `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
 next();
});

// Health endpoints
app.use('/', healthRoutes);

// API v1 routes
const apiV1 = express.Router();
apiV1.use('/auth', authRoutes);
apiV1.use('/conversations', conversationsRoutes);
apiV1.use('/chat', chatRoutes);
apiV1.use('/tasks', tasksRoutes);
apiV1.use('/memories', memoriesRoutes);
apiV1.use('/settings', settingsRoutes);
apiV1.use('/streaming', streamingRoutes);
apiV1.use('/voice', voiceRoutes);
apiV1.use('/biometric', biometricRoutes);
apiV1.use('/admin', adminRoutes);

// Inline reminder routes (no separate file yet)
const remindersRouter = express.Router();
remindersRouter.get('/', (req, res) => {
 res.json({ success: true, data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });
});
remindersRouter.post('/', (req, res) => {
 const schema = z.object({ title: z.string().min(1), dueAt: z.string(), method: z.enum(['notification', 'sms', 'call']).default('notification') });
 const parsed = schema.safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid input', code: 'INVALID_INPUT' });
 res.status(201).json({ success: true, data: { id: Date.now().toString(), ...parsed.data, status: 'scheduled', createdAt: new Date().toISOString() } });
});
apiV1.use('/reminders', remindersRouter);

app.use('/api/v1', apiV1);

// 404 handler
app.use((req, res) => {
 res.status(404).json({ error: 'Not Found', path: req.path });
});

// Error handler
app.use(errorHandler);

// ─── Database migrations (best-effort) ────────────────────────────────────
if (process.env.DATABASE_URL) {
 migrate({ databaseUrl: process.env.DATABASE_URL })
 .then((r: { applied: string[]; skipped: string[] }) => console.log(`[API] Migrations applied: ${r.applied.length}, skipped: ${r.skipped.length}`))
 .catch((err: Error) => {
 console.error('[API] Migration failed:', err.message);
 if (process.env.NODE_ENV === 'production') {
 console.error('[API] Refusing to start in production with unapplied migrations.');
 process.exit(1);
 }
 });
}

// ─── Start server ──────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
 app.listen(PORT, () => console.log(`[API] Listening on :${PORT}`));
}

export default app;
