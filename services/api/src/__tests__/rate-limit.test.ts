/**
 * NOVA API — Rate limiting tests.
 *
 * Covers: requests under the limit succeed, requests over the limit return 429,
 * and the window resets after expiry.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { rateLimit, buckets } from '../middleware/rateLimit.js';
import { errorHandler } from '../middleware/error-handler.js';
import express from 'express';
import request from 'supertest';

afterEach(() => {
 buckets.clear();
});

function createRateLimitedApp(
 max: number,
 windowMs = 60_000,
 key,
): express.Express {
 const app: express.Express = express();
 app.use(rateLimit({ windowMs, max, keyGenerator: (req: any) => (typeof key === 'function' ? key(req) : key) }));
 app.get('/test', (_req, res) => res.status(200).json({ ok: true }));
 app.use(errorHandler);
 return app;
}

describe('rate limiting', () => {
 describe('requests under the limit', () => {
 it('allows every request when count is below max', async () => {
 const app = createRateLimitedApp(5, 60_000, `rl-ok-${Math.random()}`);

 for (let i = 0; i < 3; i++) {
 const res = await request(app).get('/test');
 expect(res.status).toBe(200);
 expect(res.headers['x-ratelimit-remaining']).not.toBe('0');
 }
 });

 it('sets X-RateLimit-* headers on every response', async () => {
 const app = createRateLimitedApp(5, 60_000, `rl-headers-${Math.random()}`);

 const res = await request(app).get('/test');
 expect(res.headers['x-ratelimit-limit']).toBe('5');
 expect(res.headers['x-ratelimit-remaining']).toBe('4');
 expect(res.headers['x-ratelimit-reset']).toBeDefined();
 });
 });

 describe('requests over the limit', () => {
 it('returns 429 when the max is exceeded', async () => {
 const key = `rl-over-${Math.random()}`;
 const app = createRateLimitedApp(2, 60_000, key);

 await request(app).get('/test');
 await request(app).get('/test');

 const res = await request(app).get('/test');
 expect(res.status).toBe(429);
 expect(res.body).toHaveProperty('title', 'Too Many Requests');
 });

 it('sets Retry-After and X-RateLimit-* headers on 429', async () => {
 const key = `rl-429-${Math.random()}`;
 const app = createRateLimitedApp(1, 60_000, key);

 await request(app).get('/test');

 const res = await request(app).get('/test');
 expect(res.status).toBe(429);
 expect(res.headers['retry-after']).toBeDefined();
 expect(res.headers['x-ratelimit-limit']).toBe('1');
 expect(res.headers['x-ratelimit-remaining']).toBe('0');
 });
 });

 describe('window reset after expiry', () => {
 it('allows requests again once the window has elapsed', async () => {
 const key = `rl-reset-${Math.random()}`;
 const windowMs = 200;
 const app = createRateLimitedApp(2, windowMs, key);

 for (let i = 0; i < 2; i++) {
 const res = await request(app).get('/test');
 expect(res.status).toBe(200);
 }

 expect((await request(app).get('/test')).status).toBe(429);

 await new Promise<void>((resolve) => setTimeout(resolve, 300));

 const res = await request(app).get('/test');
 expect(res.status).toBe(200);
 expect(res.headers['x-ratelimit-remaining']).toBe('1');
 });

 it('resets bucket count, not just increments remaining', async () => {
 const key = `rl-reset-2-${Math.random()}`;
 const windowMs = 200;
 const app = createRateLimitedApp(2, windowMs, key);

 for (let i = 0; i < 2; i++) {
 await request(app).get('/test');
 }
 expect((await request(app).get('/test')).status).toBe(429);

 await new Promise<void>((resolve) => setTimeout(resolve, 300));

 for (let i = 0; i < 2; i++) {
 const res = await request(app).get('/test');
 expect(res.status).toBe(200);
 }
 expect((await request(app).get('/test')).status).toBe(429);
 });
 });

 describe('different clients are rate-limited independently', () => {
 it('applies separate limits per key generator result', async () => {
 const windowMs = 60_000;
 const app: express.Express = express();
 const limiter = rateLimit({ windowMs, max: 1, keyGenerator: (req: any) => req.headers['x-client'] as string });
 app.use(limiter);
 app.get('/test', (_req, res) => res.status(200).json({ ok: true }));
 app.use(errorHandler);

 const clientA = `client-a-${Math.random()}`;
 await request(app).get('/test').set('X-Client', clientA);
 expect((await request(app).get('/test').set('X-Client', clientA)).status).toBe(429);

 const clientB = `client-b-${Math.random()}`;
 const res = await request(app).get('/test').set('X-Client', clientB);
 expect(res.status).toBe(200);
 });
 });
});
