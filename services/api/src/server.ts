// Pin the process timezone before any timestamp is written or read.
//
// Every `timestamp` column in this schema is *without* time zone, so a driver stores a bare
// wall-clock string, and node-postgres parses such a string back in the **process** timezone.
// Two drivers write these columns: Drizzle serialises a Date as UTC, node-postgres serialises it
// in local time. When the process is not UTC the two disagree by the host offset, so a value
// written by one and read by the other is wrong by hours.
//
// Measured on a machine set to Asia/Kolkata: `admin_sessions.expires_at` held the correct UTC
// literal `2026-09-21 19:24:07` and was read back as `13:54:07Z` — 5h30m in the past, which the
// session listing rendered as an already-expired session. The database runs `Etc/UTC`, so pinning
// the process to the same zone is the fix. The deployment does it too (see `Dockerfile`); this
// line means a bare `node dist/server.js` behaves identically.
//
// `formatInZone(date, 'Asia/Kolkata')` is unaffected: it passes an explicit IANA zone.
process.env.TZ = 'UTC';

// dotenv removed — env injected by docker / CI
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { validateEnv } from './utils/env.js';
import { config } from './config.js';
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
// Account deletion — App Store 5.1.1(v) and the Play account-deletion policy both
// require an in-app path, and Play additionally requires a public web request URL.
import { accountRoutes } from './routes/account.js';
import { notificationsRoutes } from './routes/notifications.js';
import { briefingRoutes } from './routes/briefing.js';
import { settingsRouter as settingsRoutes } from './routes/settings.js';
import { deviceRouter as deviceRoutes } from './routes/device.js';
import { streamingRoutes } from './routes/streaming.js';
import { voiceRoutes } from './routes/voice.js';
import { healthRoutes } from './routes/health.js';
import { biometricRoutes } from './routes/biometric.js';
import adminRoutes from './routes/admin.js';
// Admin Control Center routers. `routes/admin.ts` remains the legacy `/admin`
// surface the mobile app's bundled console reads; the three below are the
// Control Center proper, all mounted under the same `/api/v1/admin` prefix and all
// gated by `adminGate` + a named permission.
import adminMetricsRoutes from './routes/admin/metrics.js';
import adminUsersRoutes from './routes/admin/users.js';
import adminOperationsRoutes from './routes/admin/operations.js';
// NOTE: `admin/system.ts` and `admin/ai.ts` are mounted immediately below their
// siblings; both are declared here so the control center's routers are visible in
// one place.
import adminSystemRoutes from './routes/admin/system.js';
import adminAiRoutes from './routes/admin/ai.js';
import adminRolesRoutes from './routes/admin/roles.js';
import adminSessionsRoutes from './routes/admin/sessions.js';
import adminAdminSessionsRoutes from './routes/admin/admin-sessions.js';
import adminSecurityRoutes from './routes/admin/security.js';
import adminMfaRoutes from './routes/admin/mfa.js';
import { tokenDenylist } from './middleware/token-denylist.js';
import { startJobWorker } from './jobs/worker.js';
import adminPermissionsRoutes from './routes/admin/permissions.js';
import deviceBootstrapRoutes from './routes/device-bootstrap.js';
import { requireCapability } from './admin/enforcement.js';
import { primeRuntimeOverlay } from './admin/runtime-config.js';
import subscriptionsRoutes from './routes/subscriptions.js';
import { errorHandler } from './middleware/error-handler.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import { attachRealtimeVoice } from './realtime/index.js';
import { startRetentionSweep } from './jobs/retention.js';
import { startRecordingReaper } from './jobs/recording-reaper.js';
import { startFollowUpEngine } from './jobs/follow-up-engine.js';
import { getDb } from './db/connection.js';

// ─── Env validation (fail fast) ────────────────────────────────────────────
validateEnv();

const app: ReturnType<typeof express> = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Security
app.use(cors({ origin: config.cors.origins, credentials: true }));
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

// ─── Operator capability gates ────────────────────────────────────────────────
// The emergency controls in `admin/control.ts` are enforced here, at the mount, so
// a kill switch thrown in the console actually refuses requests instead of only
// changing a row. Each gate answers 503 with a machine-readable code
// (`MAINTENANCE_MODE` / `CAPABILITY_DISABLED`) so the client can branch without
// string matching, and every gate fails OPEN when the control store is unreachable —
// see the module comment in `admin/enforcement.ts` for why that direction is right.
apiV1.use('/ai', requireCapability('ai'), aiRoutes);
apiV1.use('/conversations', requireCapability('ai'), conversationsRoutes);
apiV1.use('/chat', requireCapability('ai'), chatRoutes);
apiV1.use('/tasks', tasksRoutes);
apiV1.use('/reminders', requireCapability('notifications'), remindersRoutes);
apiV1.use('/memories', memoriesRoutes);
apiV1.use('/recordings', recordingsRoutes);
apiV1.use('/activity', activityRoutes);
apiV1.use('/tools', toolsRoutes);
apiV1.use('/consent', consentRoutes);
apiV1.use('/account', accountRoutes);
apiV1.use('/notifications', notificationsRoutes);
// The daily briefing (§9.4). Opt-in on the client; this route only answers when
// asked, and returns speakable text plus the list of sources it actually had.
apiV1.use('/briefing', requireCapability('ai'), briefingRoutes);
apiV1.use('/settings', settingsRoutes);
// Device-scoped config (§13.10). `GET|PATCH /device/wake-word/config` records
// the user's chosen wake word. The phrase itself is enforced on the device by
// the installed classifiers — see routes/device.ts.
//
// `device-bootstrap.ts` is mounted here too: it is the endpoint that delivers
// operator-controlled remote configuration (feature flags, kill switches,
// maintenance state and the version gate) to the mobile client, which is what makes
// the admin panel a control plane rather than a read-only dashboard.
apiV1.use('/device', deviceRoutes);
apiV1.use('/device', deviceBootstrapRoutes);
apiV1.use('/streaming', streamingRoutes);
apiV1.use('/voice', requireCapability('voice'), voiceRoutes);
apiV1.use('/biometric', biometricRoutes);
apiV1.use('/admin', adminRoutes);

// ─── Admin Control Center ─────────────────────────────────────────────────────
// Mounted under `/control`, NOT `/admin`, and that separation is load-bearing.
//
// `routes/admin.ts` above is the original `/admin` surface, and the admin screen
// bundled inside the Flutter app depends on its exact shapes
// (`GET /admin/dashboard` → `{status, metrics, checks}`). The Control Center routers
// define richer versions of several of the same paths, and Express answers with
// whichever handler was registered first — so mounting both at `/admin` made the new
// routers partially unreachable and, worse, made a key-addressed request
// (`PATCH /admin/feature-flags/PROACTIVE_ASSISTANT`) fall through to the legacy
// id-addressed handler and fail with a Postgres uuid parse error.
//
// Two namespaces remove the ambiguity entirely: the legacy contract keeps working
// byte-for-byte, and every Control Center route is reachable and independently
// permissioned.
apiV1.use('/control', adminMetricsRoutes);
apiV1.use('/control', adminUsersRoutes);
apiV1.use('/control', adminOperationsRoutes);
apiV1.use('/control', adminSystemRoutes);
apiV1.use('/control', adminAiRoutes);
apiV1.use('/control', adminRolesRoutes);
apiV1.use('/control', adminSessionsRoutes);
apiV1.use('/control', adminAdminSessionsRoutes);
apiV1.use('/control', adminSecurityRoutes);
apiV1.use('/control', adminMfaRoutes);
apiV1.use('/control', adminPermissionsRoutes);

// The token denylist polls a shared table so a revocation made here is seen by every replica within
// one interval. Started after the pool is configured — it must not be started by an import, or a unit
// test that touches the auth middleware would open a timer and a database connection.
tokenDenylist.start();

// The job queue's worker and scheduler. Started here rather than in the module, for the same reason as
// the denylist: an import must not open a timer or touch the database.
startJobWorker();
// `subscriptions.ts` existed but was never mounted, so `GET /api/v1/subscriptions`
// was a 404 while the route file claimed to answer 501. Mounted here alongside
// the rest of the API surface.
apiV1.use('/subscriptions', subscriptionsRoutes);

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

// Retention sweep. `privacy_preferences.auto_delete_recordings_days` and
// `auto_delete_transcripts_days` are rendered as working controls in
// Profile → Privacy controls → Auto-delete, and until this was wired nothing read
// them — the app promised to purge recordings and transcripts on a schedule and never
// did. Not started under test, so a suite cannot race a background timer against its
// own fixtures.
//
// Recording reaper. The transcription pipeline runs in-process with no durable
// queue, and the retention sweep above selects by age alone — so a process that
// died mid-run left the row at `processing` until the audio was deleted with no
// transcript, and a client that died between upload and `/process` left the row at
// `uploaded` with no owner at all. The reaper re-enqueues or closes those rows.
//
// Follow-up engine (§18). The product brief names a proactive follow-up engine as a
// major production requirement and nothing implemented it: a user could say "I'll
// send the proposal tonight", never do it, and NOVA would never mention it again.
// This sweep notices an overdue or long-pending task, a reminder whose time passed
// undismissed, and a reminder pushed back more than once, and raises at most one
// follow-up per item through the existing notification transport — bounded by quiet
// hours, a daily cap, a minimum interval and a per-item dedupe. Its state lives in
// `audit_logs`, so it needs no schema change.
if (process.env.NODE_ENV !== 'test') {
	startRetentionSweep(getDb);
	startRecordingReaper(getDb);
	startFollowUpEngine(getDb);

	// Populate the synchronous config overlay at boot.
	//
	// The AI call sites (`getAnthropicHttpConfig`, `defaultMaxOutputTokens`) cannot
	// await, so they read an in-memory overlay that the config cache republishes every
	// 15 seconds. Without this prime, the very first request after a deploy would use
	// environment values even when an operator had stored an override, for up to that
	// window. Failure is non-fatal: the overlay falls back to the environment.
	void primeRuntimeOverlay().catch((error) => {
		console.error('[API] Could not prime runtime config overlay:', error);
	});
}

if (process.env.NODE_ENV !== 'test') {
 server.listen(PORT, () => console.log(`[API] Listening on :${PORT}`));
}

export { server };
export default app;
