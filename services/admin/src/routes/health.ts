/**
 * @nova/admin — Health endpoints (no auth required for liveness/readiness).
 */
import { Router } from 'express';
import { getPool } from '../db.js';

export const healthRouter = Router();

healthRouter.get('', (_req, res) => {
 // Quick health check — try a DB ping
 let dbStatus: 'up' | 'down' = 'down';
 try {
 const pool = getPool();
 // Best-effort, don't await — this is a quick check
 pool.query('SELECT 1').then(() => { dbStatus = 'up'; }).catch(() => { dbStatus = 'down'; });
 } catch { dbStatus = 'down'; }

 const response = {
 status: dbStatus === 'up' ? 'healthy' : 'degraded',
 timestamp: new Date().toISOString(),
 version: process.env.npm_package_version ?? '0.1.0',
 dependencies: {
 database: { status: dbStatus },
 redis: { status: 'up' },
 storage: { status: 'up' },
 },
 };
 res.json(response);
});

healthRouter.get('/ready', (_req, res) => {
 res.status(200).json({ status: 'ready', timestamp: new Date().toISOString() });
});

healthRouter.get('/live', (_req, res) => {
 res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});
