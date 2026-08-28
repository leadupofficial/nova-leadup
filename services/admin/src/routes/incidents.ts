/**
 * @nova/admin — Incident events routes.
 *
 * GET /admin/incidents — list incidents in current org
 * POST /admin/incidents — create incident
 * PATCH /admin/incidents/:id/acknowledge — acknowledge
 * PATCH /admin/incidents/:id/resolve — resolve
 */
import { Router } from 'express';
import { z } from 'zod';
import { q, qOne } from '../db.js';
import { authenticateJwt, requirePermission, errorHandler } from '../middleware.js';

const router = Router();
router.use(authenticateJwt as any);

const CreateIncidentSchema = z.object({
 severity: z.enum(['info', 'warning', 'error', 'critical']),
 category: z.string().min(1).max(50),
 title: z.string().min(1).max(255),
 description: z.string().optional(),
 source: z.string().max(100).optional(),
 metadata: z.record(z.unknown()).optional(),
});

router.get('', requirePermission('settings:view'), async (req, res, next) => {
 try {
 const ctx = (req as unknown as { auth: { orgId: string } }).auth;
 const { page = 1, pageSize = 20 } = req.query as Record<string, string>;
 const offset = (Number(page) - 1) * Number(pageSize);
 const where: string[] = ['organization_id = $1'];
 const params: unknown[] = [ctx.orgId];
 let idx = 2;

 if (req.query.severity) { where.push(`severity = $${idx++}`); params.push(req.query.severity); }
 if (req.query.category) { where.push(`category = $${idx++}`); params.push(req.query.category); }

 const { rows, rowCount } = await q<any>(
 `SELECT id, organization_id, severity, category, title, description, source, metadata,
 acknowledged_at, resolved_at, created_at
 FROM incident_events
 WHERE ${where.join(' AND ')}
 ORDER BY created_at DESC
 LIMIT $${idx} OFFSET $${idx + 1}`,
 [...params, pageSize, offset]
 );
 res.json({ data: rows, page: Number(page), pageSize: Number(pageSize), totalItems: rowCount ?? 0, totalPages: Math.ceil((rowCount ?? 0) / Number(pageSize)) });
 } catch (err) { next(err); }
});

router.post('', requirePermission('settings:update'), async (req, res, next) => {
 try {
 const ctx = (req as unknown as { auth: { userId: string; orgId: string } }).auth;
 const parsed = CreateIncidentSchema.safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ type: 'validation-error', title: 'Validation Error', status: 400, detail: parsed.error.message });

 const row = await qOne<any>(
 `INSERT INTO incident_events (organization_id, severity, category, title, description, source, metadata)
 VALUES ($1, $2, $3, $4, $5, $6, $7)
 RETURNING id, organization_id, severity, category, title, description, source, metadata, created_at`,
 [ctx.orgId, parsed.data.severity, parsed.data.category, parsed.data.title, parsed.data.description ?? null, parsed.data.source ?? null, parsed.data.metadata ?? {}]
 );
 res.status(201).json(row);
 } catch (err) { next(err); }
});

router.patch('/:id/acknowledge', requirePermission('settings:update'), async (req, res, next) => {
 try {
 const ctx = (req as unknown as { auth: { userId: string } }).auth;
 const row = await qOne<any>(
 'UPDATE incident_events SET acknowledged_at = now(), acknowledged_by = $1 WHERE id = $2 AND resolved_at IS NULL RETURNING id, acknowledged_at',
 [ctx.userId, req.params.id]
 );
 if (!row) return res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Incident not found or already resolved' });
 res.json(row);
 } catch (err) { next(err); }
});

router.patch('/:id/resolve', requirePermission('settings:update'), async (req, res, next) => {
 try {
 const ctx = (req as unknown as { auth: { userId: string } }).auth;
 const row = await qOne<any>(
 'UPDATE incident_events SET resolved_at = now(), resolved_by = $1 WHERE id = $2 RETURNING id, resolved_at',
 [ctx.userId, req.params.id]
 );
 if (!row) return res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Incident not found' });
 res.json(row);
 } catch (err) { next(err); }
});

export default router;
