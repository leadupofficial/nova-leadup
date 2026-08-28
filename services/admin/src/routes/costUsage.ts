/**
 * @nova/admin — Cost / Usage metering routes.
 *
 * GET /admin/cost-usage — list records with filters
 * GET /admin/cost-usage/summary — aggregate cost summary
 */
import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { authenticateJwt, requirePermission, errorHandler } from '../middleware.js';

const router = Router();
router.use(authenticateJwt as any);

router.get('', requirePermission('settings:view'), async (req, res, next) => {
 try {
 const ctx = (req as unknown as { auth: { orgId: string } }).auth;
 const { page = 1, pageSize = 20 } = req.query as Record<string, string>;
 const offset = (Number(page) - 1) * Number(pageSize);

 const where: string[] = ['organization_id = $1'];
 const params: unknown[] = [ctx.orgId];
 let idx = 2;

 if (req.query.metric) { where.push(`metric = $${idx++}`); params.push(req.query.metric); }
 if (req.query.from) { where.push(`recorded_at >= $${idx++}`); params.push(req.query.from); }
 if (req.query.to) { where.push(`recorded_at <= $${idx++}`); params.push(req.query.to); }

 const { rows, rowCount } = await q<any>(
 `SELECT id, organization_id, workspace_id, user_id, session_id, metric, unit, quantity, cost_cents, provider, model, metadata, recorded_at
 FROM cost_usage_records
 WHERE ${where.join(' AND ')}
 ORDER BY recorded_at DESC
 LIMIT $${idx} OFFSET $${idx + 1}`,
 [...params, pageSize, offset]
 );
 res.json({ data: rows, page: Number(page), pageSize: Number(pageSize), totalItems: rowCount ?? 0, totalPages: Math.ceil((rowCount ?? 0) / Number(pageSize)) });
 } catch (err) { next(err); }
});

router.get('/summary', requirePermission('settings:view'), async (req, res, next) => {
 try {
 const ctx = (req as unknown as { auth: { orgId: string } }).auth;
 const params = [ctx.orgId];
 const from = (req.query.from as string) ?? null;
 const to = (req.query.to as string) ?? null;
 let dateFilter = 'recorded_at >= date_trunc(\'month\', now())';
 if (from) { dateFilter += ` AND recorded_at >= $${params.length + 1}`; params.push(from); }
 if (to) { dateFilter += ` AND recorded_at <= $${params.length + 1}`; params.push(to); }

 const { rows } = await q<any>(
 `SELECT metric, SUM(quantity) as total_quantity, SUM(cost_cents) as total_cost_cents,
 COUNT(DISTINCT session_id) as session_count
 FROM cost_usage_records
 WHERE organization_id = $1 AND ${dateFilter}
 GROUP BY metric ORDER BY total_cost_cents DESC`,
 params
 );
 res.json({ data: rows, totalMetrics: rows.length });
 } catch (err) { next(err); }
});

export default router;
