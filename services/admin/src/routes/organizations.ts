import { Router } from 'express';
import { authenticateJwt } from '@nova/auth';

const router = Router();

router.get('/', authenticateJwt, (_req, res) => {
 res.json({ organizations: [], total: 0 });
});

router.post('/', authenticateJwt, (req, res) => {
 res.status(201).json({ id: `org-${Date.now()}`, name: req.body.name });
});

router.get('/:id', authenticateJwt, (req, res) => {
 res.json({ id: req.params.id, name: '', members: [] });
});

router.patch('/:id', authenticateJwt, (req, res) => {
 res.json({ id: req.params.id, ...req.body });
});

router.delete('/:id', authenticateJwt, (req) => {
 res.status(204).send();
});

export { router as orgRoutes };
