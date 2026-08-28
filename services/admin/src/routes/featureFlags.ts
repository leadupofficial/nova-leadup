/**
 * @nova/admin — Feature flags routes.
 *
 * GET /admin/feature-flags — list all flags
 * PATCH /admin/feature-flags/:key — toggle / update flag
 */
import { Router } from 'express';
import { z } from 'zod';
import { q, qOne } from '../db.js';
import { authenticateJwt, requirePermission, errorHandler } from '../middleware.js';

const router = Router();
router.use(authenticateJwt as any);

const UpdateFlagSchema = z.object({
 enabled: z.boolean().optional(),
 rollout_percentage: z.number().int().min(0).max(100).optional(),
 allowed_org_ids: z.array(z.string().uuid()).optional(),
 allowed_user_ids: z.array(z.string().uuid()).optional(),
 metadata: z.record(z.unknown()).optional(),
});

router.get('', requirePermission('settings:view'), async (_req, res, next) => {
 try {
 const { rows } = await q(
 'SELECT id, key, description, enabled, rollout_percentage, allowed_org_ids, allowed_user_ids, metadata, created_at, updated_at FROM feature_flags ORDER BY key'
 );
 res.json(rows);
 } catch (err) { next(err); }
});

router.patch('/:key', requirePermission('settings:update'), async (req, res, next) => {
 try {
 const parsed = UpdateFlagSchema.safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ type: 'validation-error', title: 'Validation Error', status: 400, detail: parsed.error.message });

 const sets: string[] = ['updated_at = now()'];
 const vals: unknown[] = [];
 let idx = 1;
 for (const [key, val] of Object.entries(parsed.data)) {
 if (val !== undefined) {
 if (key === 'allowed_org_ids' || key === 'allowed_user_ids') {
 sets.push(`${key} = $${idx++}::uuid[]`);
 } else {
 sets.push(`${key} = $${idx++}`);
 }
 vals.push(val);
 }
 }
 vals.push(req.params.key);

 const row = await qOne<any>(
 `UPDATE feature_flags SET ${sets.join(', ')} WHERE key = $${idx} RETURNING id, key, description, enabled, rollout_percentage, allowed_org_ids, allowed_user_ids, metadata, created_at, updated_at`,
 vals
 );
 if (!row) return res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Feature flag not found' });
 res.json(row);
 } catch (err) { next(err); }
});

export default router;
