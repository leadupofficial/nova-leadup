/**
 * @nova/admin — Admin Console, Audit, and Observability Service
 *
 * Routes:
 * GET /health, GET /health/ready, GET /health/live
 * GET /metrics
 *
 * Admin Console (authenticated + RBAC):
 * /admin/organizations — org CRUD
 * /admin/users — user management, role assignment
 * /admin/workspaces — workspace CRUD
 * /admin/roles — role listing
 *
 * Audit (authenticated + audit:view):
 * /admin/audit-log — query with filters
 * /admin/audit-log/stats — aggregate stats
 *
 * Feature Flags (settings:update):
 * /admin/feature-flags — list / toggle
 *
 * Health (authenticated):
 * /admin/health — full dependency checks
 *
 * Incidents (settings:update):
 * /admin/incidents — list / acknowledge / resolve
 *
 * Cost / Usage (settings:view):
 * /admin/cost-usage — query with filters / summary
 *
 * Policy Rules (settings:update):
 * /admin/policy-rules — CRUD for admin policy rules
 */

import express from 'express';
import cors from 'cors';
import { createLogger } from './logger.js';
import { authenticateJwt, errorHandler } from './middleware.js';
import { metricRegistry } from './metrics.js';
import { auditEventRouter } from './routes/auditEvents.js';
import { organizationRouter } from './routes/organizations.js';
import { userRouter } from './routes/users.js';
import { workspaceRouter } from './routes/workspaces.js';
import { roleRouter } from './routes/roles.js';
import { featureFlagRouter } from './routes/featureFlags.js';
import { healthRouter } from './routes/health.js';
import { adminHealthRouter } from './routes/adminHealth.js';
import { incidentRouter } from './routes/incidents.js';
import { costUsageRouter } from './routes/costUsage.js';
import { policyRuleRouter } from './routes/policyRules.js';

const app = express();
const PORT = process.env.PORT ?? 3004;

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:3000'], credentials: true }));

app.use(express.json({ limit: '50kb' }));

// Security headers
app.use((req, res, next) => {
 res.header('X-Content-Type-Options', 'nosniff');
 res.header('X-Frame-Options', 'DENY');
 res.header('X-XSS-Protection', '1; mode=block');
 res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
 res.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
 res.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
 next();
});

// Structured logging
app.use(createLogger());

// Request ID
app.use((req, res, next) => {
 const requestId = (req.headers['x-request-id'] as string) ?? crypto.randomUUID();
 res.setHeader('x-request-id', requestId);
 (req as unknown as { requestId: string }).requestId = requestId;
 next();
});

// Prometheus metrics endpoint
app.use('/metrics', metricRegistry.getMiddleware());

// Public health
app.use('/health', healthRouter);

// Admin health checks (auth)
app.use('/admin/health', adminHealthRouter);

// Authenticated admin routes
const adminRouter = express.Router();
adminRouter.use(authenticateJwt as any);

adminRouter.use('/organizations', organizationRouter);
adminRouter.use('/users', userRouter);
adminRouter.use('/workspaces', workspaceRouter);
adminRouter.use('/roles', roleRouter);
adminRouter.use('/audit-log', auditEventRouter);
adminRouter.use('/feature-flags', featureFlagRouter);
adminRouter.use('/cost-usage', costUsageRouter);
adminRouter.use('/incidents', incidentRouter);
adminRouter.use('/policy-rules', policyRuleRouter);

app.use('/admin', adminRouter);

// Service-to-service health (auth required)
app.get('/health/service', authenticateJwt, (_req, res) => {
 res.json({ status: 'healthy', service: 'admin', timestamp: new Date().toISOString() });
});

// 404
app.use((_req, res) => {
 res.status(404).json({
 type: 'https://api.nova.leadup.in/problems/not-found',
 title: 'Not Found',
 status: 404,
 detail: 'No route matches the requested path',
 });
});

app.use(errorHandler);

app.listen(PORT, () => {
 console.log(`[admin] @nova/admin listening on :${PORT}`);
});

export default app;
