/**
 * NOVA API — Rate limiting tests.
 *
 * Covers: requests under the limit succeed, requests over the limit return 429,
 * and the window resets after expiry.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
	MAX_FIXED_WINDOW_BUCKETS,
	SlidingWindowStore,
	buckets,
	rateLimit,
	stopBucketCleanup,
} from '../middleware/rateLimit.js';
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

 /**
  * Behind the loopback nginx proxy the limiter's default key generator reads
  * `req.ip`, which is only the real client when `trust proxy` is set to the
  * loopback preset. These tests pin that behaviour: distinct right-most
  * X-Forwarded-For entries through the trusted proxy get independent buckets,
  * earlier client-supplied XFF entries are ignored as spoofable, and a request
  * with no XFF header still keys on the socket address.
  */
 describe('default key generator behind the trusted proxy (trust proxy = loopback)', () => {
  function createProxyApp(max: number): express.Express {
   const app: express.Express = express();
   app.set('trust proxy', 'loopback');
   app.use(rateLimit({ windowMs: 60_000, max }));
   app.get('/test', (_req, res) => res.status(200).json({ ok: true }));
   app.use(errorHandler);
   return app;
  }

  it('gives two clients distinct buckets via their right-most XFF entries', async () => {
   const app = createProxyApp(1);

   // Client A exhausts its bucket through the proxy.
   expect((await request(app).get('/test').set('X-Forwarded-For', '203.0.113.10')).status).toBe(200);
   expect((await request(app).get('/test').set('X-Forwarded-For', '203.0.113.10')).status).toBe(429);

   // Client B is unaffected: without trust proxy both would share the
   // loopback socket bucket and B would already be limited.
   expect((await request(app).get('/test').set('X-Forwarded-For', '203.0.113.11')).status).toBe(200);
  });

  it('ignores earlier client-supplied XFF entries', async () => {
   const app = createProxyApp(1);

   // The spoofed front entry must not become the key; the right-most entry is.
   expect((await request(app).get('/test').set('X-Forwarded-For', '198.51.100.99, 203.0.113.20')).status).toBe(200);
   expect((await request(app).get('/test').set('X-Forwarded-For', '203.0.113.20')).status).toBe(429);
   // And the spoofed address keeps its own untouched bucket.
   expect((await request(app).get('/test').set('X-Forwarded-For', '198.51.100.99')).status).toBe(200);
  });

  it('keys on the socket address when no XFF header is present', async () => {
   const app = createProxyApp(1);

   expect((await request(app).get('/test')).status).toBe(200);
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

// ─── The sliding window store's memory bound (P-01) ───────────────────────────
//
// `rateLimitMiddleware` above keeps its state in a `SlidingWindowStore`, and the
// auth store is the brute-force protection: 10 requests per minute per
// `ip:route`, after which the key is *blocked* for the rest of the window. The
// store's reclamation used to evict the oldest 30 % of keys on every `check()`
// once the map was over its cap, so an attacker who flooded the limiter with
// fresh keys — `/api/v1/auth/<junk>` produces one new key per request — evicted
// their own accumulated block, and everyone else's, resetting brute-force
// protection. The store's cap is small enough here to reach the eviction path
// directly, which the module-level stores (5000 / 20000 keys) could never do in
// a test.

describe('the sliding window store never discards a live block', () => {
 afterEach(() => {
  vi.useRealTimers();
 });

 it('keeps an actively blocked key even when the store is flooded with junk keys', () => {
  const store = new SlidingWindowStore(60_000, 2, 100);
  try {
   // Accumulate a block on the victim key: two requests fill the window, the
   // third is refused and blocks the key for the rest of the window.
   expect(store.check('victim:auth').limited).toBe(false);
   expect(store.check('victim:auth').limited).toBe(false);
   expect(store.check('victim:auth').limited).toBe(true);

   for (let i = 0; i < 5_000; i++) store.check(`junk-${i}:auth`);

   const blocked = store.check('victim:auth');
   expect(blocked.limited).toBe(true);
   expect(blocked.retryAfterMs).toBeGreaterThan(0);
   // …and the flood itself does not grow the map without bound.
   expect(store.size).toBeLessThanOrEqual(100);
  } finally {
   store.destroy();
  }
 });

 it('reclaims windows that have fully elapsed', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const store = new SlidingWindowStore(1_000, 5, 2);
  try {
   store.check('elapsed-a');
   store.check('elapsed-b');
   expect(store.size).toBe(2);

   // Past the window: both entries are fully expired, so the third key is
   // admitted by reclaiming them rather than by evicting anything live.
   vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));
   store.check('fresh');

   expect(store.size).toBe(1);
  } finally {
   store.destroy();
  }
 });
});

// ─── The fixed-window bucket map's memory bound (P-02) ────────────────────────
//
// `rateLimit()` (the fixed-window limiter) keeps one counter per key in a
// module-level `buckets` map with no cap and no cleanup timer, so a one-off key
// leaked for the life of the process. It is latent today — `rateLimit()` is not
// mounted — but the map is exported and global, so the bound is asserted here.

describe('the fixed-window bucket map is bounded', () => {
 afterEach(() => {
  stopBucketCleanup();
  buckets.clear();
  vi.useRealTimers();
 });

 it('reclaims expired buckets instead of letting a flood of one-off keys grow it', async () => {
  const expired = Date.now() - 60_000;
  for (let i = 0; i < MAX_FIXED_WINDOW_BUCKETS + 25; i++) {
   buckets.set(`stale-${i}`, { count: 1, resetAt: expired });
  }

  const app = createRateLimitedApp(5, 60_000, 'live-after-a-flood-of-stale-keys');
  expect((await request(app).get('/test')).status).toBe(200);

  expect(buckets.size).toBeLessThanOrEqual(MAX_FIXED_WINDOW_BUCKETS);
  // The live counter is retained; the expired ones are the ones reclaimed.
  expect(buckets.has('live-after-a-flood-of-stale-keys')).toBe(true);
 });

 it('stays bounded even when no bucket has expired yet', async () => {
  const live = Date.now() + 60_000;
  for (let i = 0; i < MAX_FIXED_WINDOW_BUCKETS; i++) {
   buckets.set(`live-${i}`, { count: 1, resetAt: live });
  }

  const app = createRateLimitedApp(5, 60_000, 'newcomer');
  expect((await request(app).get('/test')).status).toBe(200);

  expect(buckets.size).toBeLessThanOrEqual(MAX_FIXED_WINDOW_BUCKETS);
 });

 it('sweeps expired buckets on a timer, without waiting for the next request', () => {
  vi.useFakeTimers();
  stopBucketCleanup();
  // Constructing the limiter is what starts the cleanup; no request is needed.
  rateLimit({ windowMs: 60_000, max: 5, keyGenerator: () => 'sweep-key' });

  buckets.set('expired', { count: 1, resetAt: Date.now() - 1 });
  buckets.set('live', { count: 1, resetAt: Date.now() + 120_000 });

  vi.advanceTimersByTime(60_000);

  expect(buckets.has('expired')).toBe(false);
  expect(buckets.has('live')).toBe(true);
 });
});
