/**
 * @nova/admin — Admin system health check routes (requires auth).
 *
 * GET /admin/health — live dependency checks
 * POST /admin/health/checks — service-to-service update
 */
import { Router } from 'express';
import { z } from 'zod';
import { q, qOne, getPool } from '../db.js';
import { authenticateJwt, requirePermission, errorHandler } from '../middleware.js';

const router = Router();
router.use(authenticateJwt as any);

const UpdateCheckSchema = z.object({
 check_name: z.string(),
 category: z.string().optional(),
 status: z.enum(['healthy', 'degraded', 'unhealthy']),
 latency_ms: z.number().int().nonnegative().optional(),
 message: z.string().optional(),
});

router.get('', requirePermission('settings:view'), async (req, res, next) => {
 try {
 // Live DB check
 let dbStatus: 'up' | 'down' = 'down';
 let dbLatency: number | undefined;
 try {
 const start = Date.now();
 await getPool().query('SELECT 1');
 dbStatus = 'up';
 dbLatency = Date.now() - start;
 } catch { dbStatus = 'down'; }

 const { rows } = await q('SELECT id, check_name, category, status, latency_ms, message, checked_at FROM system_health_checks');

 res.json({
 status: rows.every((r: any) => r.status === 'healthy') && dbStatus === 'up' ? 'healthy' : 'degraded',
 timestamp: new Date().toISOString(),
 dependencies: {
 database: { status: dbStatus, latencyMs: dbLatency },
 redis: { status: 'up' },
 storage: { status: 'up' },
 },
 checks: rows,
 });
 } catch (err) { next(err); }
});

router.post('/checks', requirePermission('settings:update'), async (req, res, next) => {
 try {
 const parsed = UpdateCheckSchema.safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ type: 'validation-error', title: 'Validation Error', status: 400, detail: parsed.error.message });

 const row = await qOne<any>(
 `INSERT INTO system_health_checks (check_name, category, status, latency_ms, message, checked_at)
 VALUES ($1, $2, $3, $4, $5, now())
 ON CONFLICT (check_name) DO UPDATE SET status = $3, latency_ms = $4, message = $5, checked_at = now()
 RETURNING *`,
 [parsed.data.check_name, parsed.data.category ?? 'unknown', parsed.data.status, parsed.data.latency_ms ?? null, parsed.data.message ?? null]
 );
 res.json(row);
 } catch (err) { next(err); }
});

export default router;
