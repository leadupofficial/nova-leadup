import { Router, Request, Response } from 'express';

export const healthRouter = Router();

healthRouter.get('/live', (_req: Request, res: Response) => {
	res.json({ status: 'ok' });
});

healthRouter.get('/ready', async (_req: Request, res: Response) => {
	res.json({ status: 'ok' });
});
