import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';

const router = Router();

const RegisterSchema = z.object({ email: z.string().email(), password: z.string().min(8), name: z.string().optional() });
const LoginSchema = z.object({ email: z.string().email(), password: z.string() });
const RefreshSchema = z.object({ refreshToken: z.string() });

router.post('/register', async (req, res, next) => {
 try {
 const body = RegisterSchema.parse(req.body);
 res.status(201).json({ message: 'Registration endpoint', email: body.email });
 } catch (err) { next(err); }
});

router.post('/login', async (req, res, next) => {
 try {
 const body = LoginSchema.parse(req.body);
 res.status(200).json({ message: 'Login endpoint', email: body.email });
 } catch (err) { next(err); }
});

router.post('/refresh', async (req, res, next) => {
 try {
 RefreshSchema.parse(req.body);
 res.status(200).json({ message: 'Refresh endpoint' });
 } catch (err) { next(err); }
});

router.post('/logout', authenticate, async (req, res) => {
 res.status(204).send();
});

router.get('/me', authenticate, (req: AuthenticatedRequest, res) => {
 res.json({ user: req.user });
});

export { router as authRoutes };
