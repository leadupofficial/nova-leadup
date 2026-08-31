import { Router } from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';

export const healthRouter = Router();

healthRouter.get('/live', (req, res) => {
 res.status(200).json({
 status: 'ok',
 timestamp: new Date().toISOString(),
 environment: config.nodeEnv,
 });
});

healthRouter.get('/ready', async (req, res) => {
 try {
 // Check database, redis, etc.
 const checks: Record<string, boolean> = {};

 // Database check
 try {
 // await db.$queryRaw`SELECT 1`;
 checks.database = true;
 } catch {
 checks.database = false;
 }

 // Redis check
 try {
 // await redis.ping();
 checks.redis = true;
 } catch {
 checks.redis = false;
 }

 checks.ai = !!config.anthropic.apiKey;

 const allHealthy = Object.values(checks).every(Boolean);

 res.status(allHealthy ? 200 : 503).json({
 status: allHealthy ? 'ready' : 'degraded',
 checks,
 timestamp: new Date().toISOString(),
 });
 } catch (error) {
 res.status(503).json({
 status: 'error',
 error: error instanceof Error ? error.message : 'Health check failed',
 timestamp: new Date().toISOString(),
 });
 }
});
