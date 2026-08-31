import { Router } from 'express';
import { authenticateJwt } from '@nova/auth';

const router = Router();

router.get('/', authenticateJwt, (_req, res) => {
 res.json({ data: [], summary: {} });
});

router.get('/:orgId', authenticateJwt, (req, res) => {
 res.json({ orgId: req.params.orgId, usage: [] });
});

export { router as costUsageRoutes };
