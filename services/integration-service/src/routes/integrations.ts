import { Router } from 'express';
import { z } from 'zod';
import { authenticateJwt } from '@nova/auth';

const router = Router();

const IntegrationSchema = z.object({ provider: z.string(), config: z.record(z.string(), z.unknown()) });

router.get('/providers', (_req, res) => {
 res.json({ providers: ['google', 'github', 'microsoft'] });
});

router.post('/connect', authenticateJwt, async (req, res, next) => {
 try {
 IntegrationSchema.parse(req.body);
 res.status(201).json({ id: `int-${Date.now()}`, status: 'connected', provider: req.body.provider });
 } catch (err) { next(err); }
});

router.get('/status', authenticateJwt, (_req, res) => {
 res.json({ integrations: [] });
});

router.delete('/:provider', authenticateJwt, (req, res) => {
 res.json({ message: `Disconnected ${req.params.provider}` });
});

export { router as integrationRoutes };
