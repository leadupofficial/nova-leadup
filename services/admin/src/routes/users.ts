import { Router } from 'express';
import { z } from 'zod';
import { authenticateJwt } from '@nova/auth';

const router = Router();

const UserSchema = z.object({ name: z.string().optional(), role: z.string().optional() });

router.get('/', authenticateJwt, (_req, res) => {
 res.json({ users: [], total: 0 });
});

router.get('/:id', authenticateJwt, (req, res) => {
 res.json({ id: req.params.id, name: '', email: '', role: 'user' });
});

router.patch('/:id', authenticateJwt, (req, res, next) => {
 try {
 UserSchema.parse(req.body);
 res.json({ id: req.params.id, ...req.body });
 } catch (err) { next(err); }
});

router.delete('/:id', authenticateJwt, (req, res) => {
 res.status(204).send();
});

export { router as userRoutes };
