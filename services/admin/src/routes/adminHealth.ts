import { Router } from 'express';

const router = Router();

router.get('/live', (_req, res) => {
 res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

router.get('/ready', (_req, res) => {
 res.json({ status: 'ready', dependencies: { database: 'ok', cache: 'ok' } });
});

export { router as adminHealthRoutes };
