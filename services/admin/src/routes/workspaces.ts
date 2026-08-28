/**
 * @nova/admin — Workspace admin routes.
 *
 * GET /admin/workspaces — list workspaces in current org
 * POST /admin/workspaces — create workspace
 * PATCH /admin/workspaces/:id — update workspace
 * DELETE /admin/workspaces/:id — soft-delete workspace
 */
import { Router } from 'express';
import { z } from 'zod';
import { q, qOne } from '../db.js';
import { authenticateJwt, requirePermission, errorHandler, AdminAuthContext } from '../middleware.js';

const router = Router();
router.use(authenticateJwt as any);

const CreateWorkspaceSchema = z.object({ name: z.string().min(1).max(255) });
const UpdateWorkspaceSchema = z.object({ name: z.string().min(1).max(255).optional() });

router.get('', requirePermission('workspace:view'), async (req, res, next) => {
 try {
 const ctx = (req as unknown as { auth: AdminAuthContext }).auth!;
 const { rows, rowCount } = await q<any>(
 'SELECT id, name, organization_id, created_at FROM workspaces WHERE organization_id = $1 AND deleted_at IS NULL',
 [ctx.orgId]
 );
 res.json({ data: rows, page: 1, pageSize: rows.length, totalItems: rowCount ?? 0, totalPages: 1 });
 } catch (err) { next(err); }
});

router.post('', requirePermission('workspace:create'), async (req, res, next) => {
 try {
 const parsed = CreateWorkspaceSchema.safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ type: 'validation-error', title: 'Validation Error', status: 400, detail: parsed.error.message });

 const ctx = (req as unknown as { auth: AdminAuthContext }).auth!;
 const row = await qOne<any>(
 'INSERT INTO workspaces (name, organization_id) VALUES ($1, $2) RETURNING id, name, organization_id, created_at',
 [parsed.data.name, ctx.orgId]
 );
 res.status(201).json(row);
 } catch (err) { next(err); }
});

router.patch('/:id', requirePermission('workspace:update'), async (req, res, next) => {
 try {
 const parsed = UpdateWorkspaceSchema.safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ type: 'validation-error', title: 'Validation Error', status: 400, detail: parsed.error.message });

 const sets: string[] = [];
 const vals: unknown[] = [];
 let idx = 1;
 for (const [key, val] of Object.entries(parsed.data)) {
 if (val !== undefined) { sets.push(`${key} = $${idx++}`); vals.push(val); }
 }
 sets.push('updated_at = now()');
 vals.push(req.params.id);

 const row = await qOne<any>(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, name, updated_at`, vals);
 if (!row) return res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Workspace not found' });
 res.json(row);
 } catch (err) { next(err); }
});

router.delete('/:id', requirePermission('workspace:delete'), async (req, res, next) => {
 try {
 const row = await qOne<any>('UPDATE workspaces SET deleted_at = now() WHERE id = $1 RETURNING id', [req.params.id]);
 if (!row) return res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Workspace not found' });
 res.status(204).end();
 } catch (err) { next(err); }
});

export default router;
