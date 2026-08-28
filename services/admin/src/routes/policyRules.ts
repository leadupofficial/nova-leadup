/**
 * @nova/admin — Admin policy rules (V1 placeholder for V2 engine).
 *
 * GET /admin/policy-rules — list rules for current org
 * POST /admin/policy-rules — create rule
 * PATCH /admin/policy-rules/:id — update rule
 * DELETE /admin/policy-rules/:id — soft-delete rule
 */
import { Router } from 'express';
import { z } from 'zod';
import { q, qOne } from '../db.js';
import { authenticateJwt, requirePermission, errorHandler } from '../middleware.js';

const router = Router();
router.use(authenticateJwt as any);

const CreateRuleSchema = z.object({
 name: z.string().min(1).max(255),
 description: z.string().optional(),
 rule_type: z.string().max(50).default('custom'),
 priority: z.number().int().default(0),
 condition: z.record(z.unknown()).default({}),
 action: z.record(z.unknown()).default({}),
});

const UpdateRuleSchema = z.object({
 name: z.string().min(1).max(255).optional(),
 description: z.string().optional(),
 priority: z.number().int().optional(),
 condition: z.record(z.unknown()).optional(),
 action: z.record(z.unknown()).optional(),
 enabled: z.boolean().optional(),
});

router.get('', requirePermission('settings:view'), async (req, res, next) => {
 try {
 const ctx = (req as unknown as { auth: { orgId: string } }).auth;
 const { rows } = await q(
 'SELECT id, name, description, rule_type, priority, condition, action, enabled, created_at FROM admin_policy_rules WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY priority DESC, created_at DESC',
 [ctx.orgId]
 );
 res.json(rows);
 } catch (err) { next(err); }
});

router.post('', requirePermission('settings:update'), async (req, res, next) => {
 try {
 const ctx = (req as unknown as { auth: { userId: string; orgId: string } }).auth;
 const parsed = CreateRuleSchema.safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ type: 'validation-error', title: 'Validation Error', status: 400, detail: parsed.error.message });

 const row = await qOne<any>(
 `INSERT INTO admin_policy_rules (organization_id, name, description, rule_type, priority, condition, action, created_by)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
 RETURNING id, name, description, rule_type, priority, condition, action, enabled, created_at`,
 [ctx.orgId, parsed.data.name, parsed.data.description ?? null, parsed.data.rule_type, parsed.data.priority, parsed.data.condition, parsed.data.action, ctx.userId]
 );
 res.status(201).json(row);
 } catch (err) { next(err); }
});

router.patch('/:id', requirePermission('settings:update'), async (req, res, next) => {
 try {
 const parsed = UpdateRuleSchema.safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ type: 'validation-error', title: 'Validation Error', status: 400, detail: parsed.error.message });

 const sets: string[] = ['updated_at = now()'];
 const vals: unknown[] = [];
 let idx = 1;
 for (const [key, val] of Object.entries(parsed.data)) {
 if (val !== undefined) { sets.push(`${key} = $${idx++}`); vals.push(val); }
 }
 vals.push(req.params.id);

 const row = await qOne<any>(`UPDATE admin_policy_rules SET ${sets.join(', ')} WHERE id = $${idx} AND deleted_at IS NULL RETURNING id, name, description, rule_type, priority, condition, action, enabled, created_at`, vals);
 if (!row) return res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Policy rule not found' });
 res.json(row);
 } catch (err) { next(err); }
});

router.delete('/:id', requirePermission('settings:update'), async (req, res, next) => {
 try {
 const row = await qOne<any>('UPDATE admin_policy_rules SET deleted_at = now() WHERE id = $1 RETURNING id', [req.params.id]);
 if (!row) return res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Policy rule not found' });
 res.status(204).end();
 } catch (err) { next(err); }
});

export default router;
