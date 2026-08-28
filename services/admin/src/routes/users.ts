/**
 * @nova/admin — User management routes.
 *
 * GET /admin/users — list users in current org
 * GET /admin/users/:id — single user
 * PATCH /admin/users/:id/role — change user role
 */
import { Router } from 'express';
import { z } from 'zod';
import { q, qOne } from '../db.js';
import { authenticateJwt, requirePermission, errorHandler, AdminAuthContext } from '../middleware.js';

const router = Router();
router.use(authenticateJwt as any);

const ChangeRoleSchema = z.object({
 role: z.enum(['owner', 'admin', 'manager', 'member', 'auditor', 'support_limited']),
});

router.get('', requirePermission('user:view'), async (req, res, next) => {
 try {
 const ctx = (req as unknown as { auth: AdminAuthContext }).auth!;
 const { page = 1, pageSize = 20 } = req.query as Record<string, string>;
 const offset = (Number(page) - 1) * Number(pageSize);

 const { rows, rowCount } = await q<any>(
 `SELECT u.id, u.email, up.display_name, rb.role, rb.created_at
 FROM users u
 LEFT JOIN user_profiles up ON up.user_id = u.id
 JOIN role_bindings rb ON rb.user_id = u.id
 WHERE rb.workspace_id IN (
 SELECT id FROM workspaces WHERE organization_id = $1
 )
 ORDER BY u.created_at DESC
 LIMIT $2 OFFSET $3`,
 [ctx.orgId, pageSize, offset]
 );
 res.json({ data: rows, page: Number(page), pageSize: Number(pageSize), totalItems: rowCount ?? 0, totalPages: Math.ceil((rowCount ?? 0) / Number(pageSize)) });
 } catch (err) { next(err); }
});

router.get('/:id', requirePermission('user:view'), async (req, res, next) => {
 try {
 const row = await qOne<any>(
 `SELECT u.id, u.email, up.display_name, u.created_at
 FROM users u
 LEFT JOIN user_profiles up ON up.user_id = u.id
 WHERE u.id = $1`,
 [req.params.id]
 );
 if (!row) return res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'User not found' });
 res.json(row);
 } catch (err) { next(err); }
});

router.patch('/:id/role', requirePermission('user:update_role'), async (req, res, next) => {
 try {
 const parsed = ChangeRoleSchema.safeParse(req.body);
 if (!parsed.success) return res.status(400).json({ type: 'validation-error', title: 'Validation Error', status: 400, detail: parsed.error.message });

 const ctx = (req as unknown as { auth: AdminAuthContext }).auth!;
 const roleId = await qOne<string>('SELECT id FROM roles WHERE key = $1', [parsed.data.role]);
 if (!roleId) return res.status(400).json({ type: 'validation-error', title: 'Invalid role', status: 400 });

 const workspaceId = await qOne<string>(
 'SELECT id FROM workspaces WHERE organization_id = $1 LIMIT 1',
 [ctx.orgId]
 );
 if (!workspaceId) return res.status(400).json({ type: 'validation-error', title: 'No workspace in org', status: 400 });

 const row = await qOne<any>(
 `UPDATE role_bindings SET role_id = $1, updated_at = now()
 WHERE user_id = $2 AND workspace_id = $3 AND deleted_at IS NULL
 RETURNING id, user_id, role_id, updated_at`,
 [roleId, req.params.id, workspaceId]
 );
 if (!row) return res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Role binding not found' });
 res.json(row);
 } catch (err) { next(err); }
});

export default router;
