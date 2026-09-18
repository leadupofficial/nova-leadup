import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

export type RequestWithId = Request & { id?: string };

export const requestIdMiddleware = (req: RequestWithId, _res: Response, next: NextFunction) => {
	// Accept incoming X-Request-Id for distributed tracing correlation, or generate new
	req.id = (req.headers['x-request-id'] as string) || randomUUID();
	_res.setHeader('X-Request-Id', req.id);
	next();
};
