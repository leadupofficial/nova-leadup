import express from 'express';
import { z } from 'zod';

const app = express();
const PORT = process.env.PORT ?? 3001;

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

app.use(express.json({ limit: '50kb' }));

// Simple in-memory rate limiter (swap for Redis in production)
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(ip: string, limit: number, windowMs: number): boolean {
 const now = Date.now();
 const key = `rl:${ip}`;
 const bucket = rateLimitBuckets.get(key);
 if (!bucket || now > bucket.resetAt) {
 rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
 return true;
 }
 bucket.count++;
 if (bucket.count > limit) return false;
 return true;
}
app.use((req, res, next) => {
 const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
 if (!rateLimit(ip, 100, 60_000)) {
 res.set('Retry-After', '60');
 return res.status(429).json({ type: 'https://api.nova.leadup.in/problems/rate-limit', title: 'Too Many Requests', status: 429, detail: 'Rate limit exceeded', instance: req.path });
 }
 next();
});

const HealthCheckSchema = z.object({
 status: z.enum(['healthy', 'degraded', 'unhealthy']),
 timestamp: z.string().datetime(),
 version: z.string(),
 dependencies: z.object({
 database: z.object({ status: z.enum(['up', 'down']), latencyMs: z.number().optional() }),
 redis: z.object({ status: z.enum(['up', 'down']), latencyMs: z.number().optional() }),
 storage: z.object({ status: z.enum(['up', 'down']), latencyMs: z.number().optional() }),
 }),
});

app.get('/health', (_req, res) => {
 const response = {
 status: 'healthy',
 timestamp: new Date().toISOString(),
 version: process.env.npm_package_version ?? '0.1.0',
 dependencies: {
 database: { status: 'up' as const },
 redis: { status: 'up' as const },
 storage: { status: 'up' as const },
 },
 };
 res.json(response);
});

app.get('/health/ready', (_req, res) => {
 res.status(200).json({ status: 'ready', timestamp: new Date().toISOString() });
});

app.get('/health/live', (_req, res) => {
 res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
 console.log(`API service listening on port ${PORT}`);
});
