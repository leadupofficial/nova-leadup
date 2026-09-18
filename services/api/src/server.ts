// dotenv removed — env injected by docker / CI
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { validateEnv } from './utils/env.js';
import { authRoutes } from './routes/auth.js';
import { aiRoutes } from './routes/ai.js';
import { chatRoutes } from './routes/chat.js';
import { conversationsRoutes } from './routes/conversations.js';
import { tasksRoutes } from './routes/tasks.js';
import { remindersRoutes } from './routes/reminders.js';
import { memoriesRoutes } from './routes/memories.js';
import { recordingsRoutes } from './routes/recordings.js';
import { activityRoutes } from './routes/activity.js';
import { toolsRoutes } from './routes/tools.js';
import { consentRoutes } from './routes/consent.js';
import { settingsRouter as settingsRoutes } from './routes/settings.js';
import { streamingRoutes } from './routes/streaming.js';
import { voiceRoutes } from './routes/voice.js';
import { healthRoutes } from './routes/health.js';
import { biometricRoutes } from './routes/biometric.js';
import adminRoutes from './routes/admin.js';
import { errorHandler } from './middleware/error-handler.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import { attachRealtimeVoice } from './realtime/index.js';

// ─── Env validation (fail fast) ────────────────────────────────────────────
validateEnv();

const app: ReturnType<typeof express> = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Security
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',').map((s) => s.trim()).filter(Boolean) || ['https://nova.leadup.in'], credentials: true }));
app.use(helmet());
app.use(compression() as any);

// Body parsing
app.use(express.json({ limit: '5mb' }));

// Request ID
app.use((req, res, next) => {
 res.setHeader('X-Request-Id', `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
 next();
});

// Health endpoints (no rate limit — must always respond)
app.use('/', healthRoutes);

// Rate limiting on API routes only
app.use('/api/v1', rateLimitMiddleware());

// API v1 routes
const apiV1 = express.Router();
apiV1.use('/auth', authRoutes);
apiV1.use('/ai', aiRoutes);
apiV1.use('/conversations', conversationsRoutes);
apiV1.use('/chat', chatRoutes);
apiV1.use('/tasks', tasksRoutes);
apiV1.use('/reminders', remindersRoutes);
apiV1.use('/memories', memoriesRoutes);
apiV1.use('/recordings', recordingsRoutes);
apiV1.use('/activity', activityRoutes);
apiV1.use('/tools', toolsRoutes);
apiV1.use('/consent', consentRoutes);
apiV1.use('/settings', settingsRoutes);
apiV1.use('/streaming', streamingRoutes);
apiV1.use('/voice', voiceRoutes);
apiV1.use('/biometric', biometricRoutes);
apiV1.use('/admin', adminRoutes);

app.use('/api/v1', apiV1);

// 404 handler
app.use((req, res) => {
 res.status(404).json({ error: 'Not Found', path: req.path });
});

// Error handler
app.use(errorHandler);

// ─── Database migrations ──────────────────────────────────────────────────
// Auto-migration on boot was removed. It called `migrate()` from @nova/database,
// which applied packages/database/src/migrations/*.ts — a legacy migration set whose
// schema directly contradicted packages/database/src/schema.ts (the schema every route
// actually queries through). It created `users.display_name` / `users.is_active` and a
// `sessions.token_hash NOT NULL` column, while the Drizzle schema reads `users.name` /
// `users.disabled` and writes `sessions.refresh_token_hash` only. Running it produced a
// database that no route could query.
//
// The authoritative schema is packages/database/drizzle/0000_regular_colossus.sql,
// generated from schema.ts. Apply it as an explicit deploy step:
//
//   pnpm db:migrate            # packages/database/scripts/migrate.ts (drizzle-kit)
//
// Keeping migrations out of the service boot path also avoids several replicas racing
// to migrate the same database on a rolling deploy.

// ─── Start server ──────────────────────────────────────────────────────────
// The Express app is mounted on an explicit HTTP server rather than
// `app.listen()` so the realtime voice WebSocket can take over the `upgrade`
// event for `/api/v1/voice/realtime`. Every REST route is served exactly as
// before — `http.createServer(app)` is what `app.listen()` does internally.
const server = http.createServer(app);

// Realtime voice (WebSocket). Registers an `upgrade` listener only; it opens no
// port of its own and rejects upgrade requests for any other path.
attachRealtimeVoice(server);

if (process.env.NODE_ENV !== 'test') {
 server.listen(PORT, () => console.log(`[API] Listening on :${PORT}`));
}

export { server };
export default app;
