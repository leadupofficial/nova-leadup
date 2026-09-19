/**
 * NOVA API — Health endpoint tests.
 *
 * Covers: GET /health, GET /health/live, GET /health/ready, and security
 * headers set by the securityHeaders() middleware.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import './setup.js';

import app from '../server.js';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET!;

function createToken(
 payload: Record<string, unknown> = { sub: 'user-123', email: 'test@example.com', role: 'user' },
): string {
 return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

function authHeader(token: string): Record<string, string> {
 return { Authorization: `Bearer ${token}` };
}

describe('GET /health', () => {
 it('returns status 200 with the liveness status "alive"', async () => {
 // `/health` and `/health/live` are the same liveness probe — both call
 // `getLiveness()`, which reports 'alive'. 'ok' belongs to the public
 // mobile probe `GET /healthz`, not to this localhost-only route.
 const res = await request(app).get('/health');
 expect(res.status).toBe(200);
 expect(res.body).toHaveProperty('status', 'alive');
 });

 it('includes a timestamp', async () => {
 const res = await request(app).get('/health');
 expect(res.body).toHaveProperty('timestamp');
 expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
 });
});

describe('GET /health/live', () => {
 it('returns status 200 with status "alive"', async () => {
 const res = await request(app).get('/health/live');
 expect(res.status).toBe(200);
 expect(res.body).toHaveProperty('status', 'alive');
 });

 it('includes a timestamp', async () => {
 const res = await request(app).get('/health/live');
 expect(res.body).toHaveProperty('timestamp');
 expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
 });
});

describe('GET /health/ready', () => {
 it('returns 401 without a bearer token (readiness detail is not public)', async () => {
 // The route is deliberately authenticated: it reports dependency status
 // and must not be publicly enumerable. Making it public to satisfy a test
 // would be a security regression.
 const res = await request(app).get('/health/ready');
 expect(res.status).toBe(401);
 expect(res.body).toHaveProperty('error', 'UNAUTHORIZED');
 });

 it('returns the sanitised readiness report to an authenticated caller', async () => {
 // The report's status is the aggregate health status
 // (healthy | degraded | unhealthy) — the route never returns 'ready' —
 // together with a timestamp, uptime, and per-check summaries. The
 // database pool is stubbed by ./setup.js, so at most the disabled optional
 // dependencies are down and the route answers 200.
 const res = await request(app).get('/health/ready').set(authHeader(createToken()));
 expect(res.status).toBe(200);
 expect(['healthy', 'degraded', 'unhealthy']).toContain(res.body.status);
 expect(res.body).toHaveProperty('timestamp');
 expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
 expect(Array.isArray(res.body.checks)).toBe(true);
 expect(res.body.summary).toMatchObject({
 total: expect.any(Number),
 up: expect.any(Number),
 down: expect.any(Number),
 disabled: expect.any(Number),
 });
 });
});

describe('security headers', () => {
 it('sets X-Content-Type-Options: nosniff on all responses', async () => {
 const endpoints = ['/health', '/health/live', '/health/ready'];
 for (const endpoint of endpoints) {
 const res = await request(app).get(endpoint);
 expect(res.headers['x-content-type-options']).toBe('nosniff');
 }
 });
});
