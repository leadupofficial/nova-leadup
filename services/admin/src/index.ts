import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { authenticateJwt, requireRole } from '@nova/auth';
// Validates DATABASE_URL and JWT_SECRET at import, so a misconfigured container exits
// with a named variable instead of starting and failing on the first request. This
// module existed and was never imported — the contract was written but not enforced.
import './utils/env.js';
import { adminHealthRoutes } from './routes/adminHealth.js';
import { healthRouter } from './routes/health.js';
import { errorHandler } from './middleware.js';

const app: Express = express();
const PORT = process.env.PORT || 3007;

/**
 * CORS allow-list from the environment.
 *
 * This was hard-coded to three `http://localhost:*` origins, so the deployed console
 * origin (`https://nova.leadup.in`) got no `Access-Control-Allow-Origin` while a
 * developer's laptop did. `docker-compose.prod.yml` has always set `CORS_ORIGIN` for
 * this service; nothing read it. Same-origin nginx routing hides the problem today,
 * and any future cross-origin client would be blocked until it was fixed here.
 *
 * In production with no `CORS_ORIGIN` set, the list is empty: no cross-origin caller is
 * allowed. Same-origin requests are unaffected.
 */
const configuredOrigins = (process.env.CORS_ORIGIN ?? '')
	.split(',')
	.map((origin) => origin.trim())
	.filter(Boolean);
const allowedOrigins =
	configuredOrigins.length > 0
		? configuredOrigins
		: process.env.NODE_ENV === 'production'
			? []
			: ['http://localhost:3000', 'http://localhost:3004', 'http://localhost:3005'];

app.use(helmet());
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));

// `/health`, `/health/live`, `/health/ready`. The deployed service already answered
// `/health` with the `{status, dependencies:{database}}` shape from `routes/health.ts`,
// but this entry point only defined `/health/live` inline and never mounted that router
// — so the two had drifted, and the version with the real (previously broken) database
// check was unreachable from a clean build. Mounted, with the duplicate inline route
// removed.
app.use('/health', healthRouter);

// Admin data routes require authentication **and** an admin role.
//
// Every route file mounts `authenticateJwt`, which answers "is this a valid token?" —
// it never answered "is this person an administrator?". The default role for a
// self-registered account is `user` (services/api/src/routes/auth.ts), so any signed-in
// end user could enumerate every user and organization and mutate feature flags,
// policy rules, roles and workspaces through `/api/admin/*`. The health probes stay
// public so an orchestrator can still check the container.
const adminOnly = [authenticateJwt, requireRole('owner', 'admin')];

app.use('/api/admin', adminHealthRoutes);

/**
 * Every data route in this service is a stub.
 *
 * `routes/users.ts` answered `{users: [], total: 0}`, `routes/organizations.ts`,
 * `featureFlags.ts`, `policyRules.ts`, `roles.ts`, `workspaces.ts` and `costUsage.ts`
 * returned fabricated payloads, and `auditEvents.ts` / `incidents.ts` say
 * "Stub: replace with real DB query" in their own source. None of them touches the
 * database. A 200 with invented data is worse than an honest failure: a client cannot
 * tell it apart from an empty table.
 *
 * The console does not call them anyway — `apps/admin` is built with
 * `NEXT_PUBLIC_API_BASE=https://nova.leadup.in/api/v1` and its server components use
 * `API_INTERNAL_URL=http://api:3001/api/v1`, so the real admin API it consumes is
 * `services/api`'s `/api/v1/admin/*`, which answers with live rows. These routes now
 * say so instead of pretending.
 *
 * Implement them against the canonical schema (or delete the service) before pointing
 * anything at `/api/admin/*`.
 */
const notImplemented = (area: string) => (_req: express.Request, res: express.Response) => {
	res.status(501).json({
		type: 'https://api.nova.leadup.in/problems/not-implemented',
		title: 'Not Implemented',
		status: 501,
		detail: `${area} is not implemented in services/admin. The live admin API is /api/v1/admin/* in services/api, which is what the console calls.`,
	});
};

app.use('/api/admin/users', ...adminOnly, notImplemented('GET/PATCH/DELETE /api/admin/users'));
app.use('/api/admin/orgs', ...adminOnly, notImplemented('GET/POST/PATCH/DELETE /api/admin/orgs'));
app.use('/api/admin/audit', ...adminOnly, notImplemented('GET /api/admin/audit'));
app.use('/api/admin/incidents', ...adminOnly, notImplemented('GET/POST/PATCH /api/admin/incidents'));
app.use('/api/admin/feature-flags', ...adminOnly, notImplemented('GET/POST/PATCH/DELETE /api/admin/feature-flags'));
app.use('/api/admin/cost', ...adminOnly, notImplemented('GET /api/admin/cost'));
app.use('/api/admin/policies', ...adminOnly, notImplemented('GET/POST/PATCH/DELETE /api/admin/policies'));
app.use('/api/admin/roles', ...adminOnly, notImplemented('GET/POST/PATCH/DELETE /api/admin/roles'));
app.use('/api/admin/workspaces', ...adminOnly, notImplemented('GET/POST/PATCH/DELETE /api/admin/workspaces'));

// JSON error responses.
//
// Without this the service answered with Express's default **HTML** error page, which
// printed the raw driver message inside a `<pre>` — a pg error leaked table and column
// names to the caller. `errorHandler` returns RFC 7807 JSON and never echoes an
// internal `Error` message for a 500.
app.use(errorHandler);

/**
 * Last-resort process guards.
 *
 * There were none, and a transient Redis outage — ioredis emits `error` and rejects
 * queued commands with `MaxRetriesPerRequestError` — took the whole admin API down,
 * turning a degraded dependency into a dead service. A rejected promise is logged and
 * ignored; a genuinely uncaught exception is logged and exits so the supervisor
 * restarts a process whose state can no longer be trusted.
 */
process.on('unhandledRejection', (reason) => {
	console.error('[admin] unhandled promise rejection:', reason instanceof Error ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
	console.error('[admin] uncaught exception, exiting:', err);
	process.exit(1);
});

app.listen(PORT, () => {
	console.log(`[admin] listening on :${PORT}`);
});

export default app;
