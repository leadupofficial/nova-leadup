import { Router } from 'express';
import { z } from 'zod';
import { authenticateJwt } from '@nova/auth';

const router = Router();

const AgentRunSchema = z.object({ agentId: z.string().uuid(), input: z.unknown() });

router.get('/status', (_req, res) => {
 res.json({ status: 'ready', activeAgents: 0 });
});

router.post('/run', authenticateJwt, (req, res, next) => {
 try {
 AgentRunSchema.parse(req.body);
 res.status(202).json({ taskId: `task-${Date.now()}`, agentId: req.body.agentId, status: 'queued' });
 } catch (err) { next(err); }
});

export { router as agentRoutes };
