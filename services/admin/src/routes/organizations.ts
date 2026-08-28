/**
 * @nova/admin — Organization admin routes.
 *
 * GET /admin/organizations — list orgs the user belongs to
 * GET /admin/organizations/:id — single org
 * PATCH /admin/organizations/:id — update org (owner/admin)
 */
import { Router } from 'express';
import { z } from 'zod';
import { q, qOne } from '../db.js';
import { AuthenticatedRequest, authenticateJwt, requirePermission, errorHandler } from '../middleware.js';

const router = Router();
router.use(authenticateJwt as any);

const UpdateOrgSchema = z.object({
 name: z.string().min(1).max(255).optional(),
 plan: z.enum(['free', 'pro', 'enterprise']).optional(),
});

router.get('', requirePermission('org:view'), async (req: AuthenticatedRequest, res, next) => {
 try {
 const ctx = req.auth!;
 const { rows } = await q(
 'SELECT id, name, slug, plan, created_at, updated_at FROM organizations WHERE id = $1',
 [ctx.orgId]
 );
 res.json({ data: rows, page: 1, pageSize: rows.length, totalItems: rows.length, totalPages: 1 });
 } catch (err) { next(err); }
});

router.get('/:id', requirePermission('org:view'), async (req: AuthenticatedRequest, res, next) => {
 try {
 const row = await qOne<any>('SELECT id, name, slug, plan, created_at FROM organizations WHERE id = $1', [req.params.id]);
 if (!row) return res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Organization not found' });
 res.json(row);
 } catch (err) { next(err); }
});

router.patch('/:id', requirePermission('org:update'), async (req: AuthenticatedRequest, res, next) => {
 try {
 const parsed = UpdateOrgSchema.safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ type: 'validation-error', title: 'Validation Error', status: 400, detail: parsed.error.message });

 const sets: string[] = [];
 const vals: unknown[] = [];
 let idx = 1;
 for (const [key, val] of Object.entries(parsed.data)) {
 sets.push(`${key} = $${idx++}`);
 vals.push(val);
 }
 sets.push(`updated_at = now()`);
 vals.push(req.params.id);

 const row = await qOne<any>(`UPDATE organizations SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, name, slug, plan, updated_at`, vals);
 if (!row) return res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Organization not found' });
 res.json(row);
 } catch (err) { next(err); }
});

export default router;
