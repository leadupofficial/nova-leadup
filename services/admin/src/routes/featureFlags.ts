import { Router } from 'express';
import { authenticateJwt } from '@nova/auth';

const router = Router();

router.get('/', authenticateJwt, (_req, res) => {
 res.json({ flags: [] });
});

router.post('/', authenticateJwt, (req, res) => {
 res.status(201).json({ id: `flag-${Date.now()}`, ...req.body });
});

router.patch('/:id', authenticateJwt, (req, res) => {
 res.json({ id: req.params.id, ...req.body });
});

router.delete('/:id', authenticateJwt, (req) => {
 res.status(204).send();
});

export { router as featureFlagRoutes };
