/**
 * @nova/auth — Authentication and RBAC Service
 *
 * Express app mounted at:
 * POST /auth/register
 * POST /auth/login
 * POST /auth/refresh
 * POST /auth/phone/otp/request
 * POST /auth/phone/otp/verify
 * POST /auth/password-reset/request
 * POST /auth/password-reset/confirm
 * POST /auth/mfa/enroll
 * POST /auth/mfa/verify
 * GET /auth/me
 * POST /orgs
 * GET /orgs/:id
 * PATCH /orgs/:id
 * DELETE /orgs/:id
 * POST /orgs/:id/members
 * POST /api-keys
 * GET /api-keys
 * DELETE /api-keys/:id
 * GET /health
 */

import express from 'express';
import Redis from 'ioredis';
import { authRoutes } from './routes/authRoutes.js';
import { orgRoutes } from './routes/orgRoutes.js';
import { apiKeyRoutes, authenticateApiKey } from './routes/apiKeyRoutes.js';
import { authenticateJwt, errorHandler } from './middleware.js';
import { rateLimitMiddleware } from './ratelimit.js';

const app = express();
const PORT = process.env.PORT ?? 3003;

// CORS (tighten in production)
app.use((req, res, next) => {
 res.header('X-Content-Type-Options', 'nosniff');
 res.header('X-Frame-Options', 'DENY');
 res.header('X-XSS-Protection', '1; mode=block');
 res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
 res.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
 next();
});

app.use(express.json({ limit: '50kb' }));

// Request logger
app.use((req, _res, next) => {
 console.log(`[auth] ${req.method} ${req.path}`);
 next();
});

// Rate limiting (IP-based, per endpoint)
app.use(rateLimitMiddleware as any);

// Mount routes
app.use('/auth', authRoutes);
app.use('/orgs', authenticateJwt, orgRoutes);
app.use('/api-keys', authenticateJwt, apiKeyRoutes);

// Service-to-service health (requires valid API key)
app.get('/health/service', authenticateApiKey, (_req, res) => {
 res.json({ status: 'healthy', service: 'auth', timestamp: new Date().toISOString() });
});

// Liveness
app.get('/health/live', (_req, res) => res.json({ status: 'alive' }));

// 404
app.use((_req, res) => {
 res.status(404).json({
 type: 'https://api.nova.leadup.in/problems/not-found',
 title: 'Not Found',
 status: 404,
 detail: `No route matches ${_req.method} ${_req.path}`,
 instance: _req.path,
 });
});

// Global error handler (RFC 7807)
app.use(errorHandler);

app.listen(PORT, () => {
 console.log(`[auth] @nova/auth listening on :${PORT}`);
});

export default app;
