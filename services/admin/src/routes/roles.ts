/**
 * @nova/admin — Role listing route.
 *
 * GET /admin/roles — list all system roles
 */
import { Router } from 'express';
import { authenticateJwt, requirePermission } from '../middleware.js';
import { q } from '../db.js';

const router = Router();
router.use(authenticateJwt as any);

router.get('', requirePermission('org:view'), async (_req, res, next) => {
 try {
 const { rows } = await q('SELECT id, key, display_name, description FROM roles ORDER BY key');
 res.json(rows);
 } catch (err) { next(err); }
});

export default router;
