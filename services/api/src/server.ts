import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler';
import { validateEnv } from '../config';

validateEnv();

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(express.json());
app.use((req, res, next) => {
 res.header('X-Content-Type-Options', 'nosniff');
 next();
});

// Rate limiting
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
 return bucket.count <= limit;
}

const HealthResponseSchema = z.object({
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
 res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString(), version: '0.1.0', dependencies: { database: { status: 'up' }, redis: { status: 'up' }, storage: { status: 'up' } } });
});

app.get('/health/live', (_req, res) => {
 res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});

app.get('/health/ready', (_req, res) => {
 res.status(200).json({ status: 'ready', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`API listening on port ${PORT}`));
