/**
 * @nova/admin — Audit event ingestion (service-to-service).
 *
 * POST /admin/audit-log/events — emit an audit event
 * GET /admin/audit-log — query with filters
 * GET /admin/audit-log/:id — single event
 * GET /admin/audit-log/stats — aggregate stats
 */
import { Router } from 'express';
import { z } from 'zod';
import { q, qOne, getPool } from '../db.js';
import { authenticateJwt, requirePermission, errorHandler } from '../middleware.js';

const router = Router();
router.use(authenticateJwt as any);

const AuditEventSchema = z.object({
 action: z.string().min(1).max(100),
 resource_type: z.string().max(50).optional(),
 resource_id: z.string().uuid().optional(),
 changes: z.record(z.unknown()).optional(),
 tool_name: z.string().max(100).optional(),
 tool_input: z.record(z.unknown()).optional(),
 tool_output: z.record(z.unknown()).optional(),
 decision: z.enum(['allowed', 'denied', 'escalated']).optional(),
 request_id: z.string().max(64).optional(),
 actor_session_id: z.string().uuid().optional(),
 actor_device_id: z.string().uuid().optional(),
 correlation_id: z.string().max(64).optional(),
 ip_address: z.string().ip().optional(),
 user_agent: z.string().optional(),
});

// Ingest audit event (append-only)
router.post('/events', async (req, res, next) => {
 try {
 const ctx = (req as unknown as { auth: { userId: string; orgId: string } }).auth;
 if (!ctx) return res.status(401).json({ type: 'unauthorized', title: 'Unauthorized', status: 401 });

 const parsed = AuditEventSchema.safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ type: 'validation-error', title: 'Validation Error', status: 400, detail: parsed.error.message });

 const pool = getPool();
 const row = await pool.query(
 `INSERT INTO audit_log (
 organization_id, actor_user_id, action, resource_type, resource_id,
 changes, tool_name, tool_input, tool_output, decision,
 request_id, actor_session_id, actor_device_id, correlation_id,
 ip_address, user_agent
 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
 RETURNING id, created_at`,
 [
 ctx.orgId,
 ctx.userId,
 parsed.data.action,
 parsed.data.resource_type ?? null,
 parsed.data.resource_id ?? null,
 parsed.data.changes ?? null,
 parsed.data.tool_name ?? null,
 parsed.data.tool_input ?? null,
 parsed.data.tool_output ?? null,
 parsed.data.decision ?? 'allowed',
 parsed.data.request_id ?? null,
 parsed.data.actor_session_id ?? null,
 parsed.data.actor_device_id ?? null,
 parsed.data.correlation_id ?? null,
 parsed.data.ip_address ?? null,
 parsed.data.user_agent ?? null,
 ]
 );

 res.status(201).json(row.rows[0]);
 } catch (err) { next(err); }
});

router.get('', requirePermission('audit:view'), async (req, res, next) => {
 try {
 const ctx = (req as unknown as { auth: { orgId: string } }).auth;
 const page = Number(req.query.page ?? 1);
 const pageSize = Number(req.query.pageSize ?? 20);
 const offset = (page - 1) * pageSize;

 const where: string[] = ['organization_id = $1'];
 const params: unknown[] = [ctx.orgId];
 let idx = 2;

 const map: Record<string, string | undefined> = {
 actorUserId: 'actor_user_id',
 resourceType: 'resource_type',
 action: 'action',
 toolName: 'tool_name',
 decision: 'decision',
 };
 for (const [qKey, col] of Object.entries(map)) {
 const val = req.query[qKey];
 if (val) { where.push(`${col} = $${idx++}`); params.push(val); }
 }
 if (req.query.from) { where.push(`created_at >= $${idx++}`); params.push(req.query.from); }
 if (req.query.to) { where.push(`created_at <= $${idx++}`); params.push(req.query.to); }

 const { rows, rowCount } = await q<any>(
 `SELECT id, organization_id, actor_user_id, action, resource_type, resource_id,
 changes, ip_address, user_agent, request_id, tool_name, tool_input, tool_output,
 decision, correlation_id, created_at
 FROM audit_log
 WHERE ${where.join(' AND ')}
 ORDER BY created_at DESC
 LIMIT $${idx} OFFSET $${idx + 1}`,
 [...params, pageSize, offset]
 );
 res.json({ data: rows, page, pageSize, totalItems: rowCount ?? 0, totalPages: Math.ceil((rowCount ?? 0) / pageSize) });
 } catch (err) { next(err); }
});

router.get('/stats', requirePermission('audit:view'), async (req, res, next) => {
 try {
 const ctx = (req as unknown as { auth: { orgId: string } }).auth;
 const where = `organization_id = $1`;
 const params = [ctx.orgId];
 const from = req.query.from as string | undefined;
 const to = req.query.to as string | undefined;
 const extra = [from, to].filter(Boolean).map((v, i) => `created_at ${i === 0 ? '>=' : '<='} $${params.length + i}`).join(' AND ');
 const whereClause = extra ? `${where} AND ${extra}` : where;

 const { rowCount: totalCount } = await q(`SELECT COUNT(*) FROM audit_log WHERE ${whereClause}`, params);
 const total = totalCount ?? 0;

 const { rows: actionRows } = await q(`SELECT action, COUNT(*) as cnt FROM audit_log WHERE ${whereClause} GROUP BY action ORDER BY cnt DESC LIMIT 20`, params);
 const actionCounts: Record<string, number> = {};
 for (const r of actionRows) actionCounts[r.action] = r.cnt;

 const { rows: toolRows } = await q(
 `SELECT tool_name, COUNT(*) as cnt FROM audit_log WHERE ${whereClause} AND tool_name IS NOT NULL GROUP BY tool_name ORDER BY cnt DESC LIMIT 20`,
 params
 );
 const toolCounts: Record<string, number> = {};
 for (const r of toolRows) toolCounts[r.tool_name] = r.cnt;

 const { rows: decisionRows } = await q(`SELECT decision, COUNT(*) as cnt FROM audit_log WHERE ${whereClause} GROUP BY decision ORDER BY cnt DESC`, params);
 const decisions: Record<string, number> = {};
 for (const r of decisionRows) decisions[r.decision] = r.cnt;

 res.json({ totalEvents: total, actionCounts, toolCounts, decisions });
 } catch (err) { next(err); }
});

router.get('/:id', requirePermission('audit:view'), async (req, res, next) => {
 try {
 const row = await qOne<any>(
 `SELECT id, organization_id, actor_user_id, action, resource_type, resource_id,
 changes, ip_address, user_agent, request_id, tool_name, tool_input, tool_output,
 decision, correlation_id, created_at
 FROM audit_log WHERE id = $1`,
 [req.params.id]
 );
 if (!row) return res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Audit event not found' });
 res.json(row);
 } catch (err) { next(err); }
});

export default router;
