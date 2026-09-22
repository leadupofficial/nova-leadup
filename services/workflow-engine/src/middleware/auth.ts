/**
 * JWT authentication middleware for @nova/workflow-engine.
 *
 * Verifies the Bearer token from the Authorization header using JWT_SECRET.
 * Rejects requests with missing, malformed, or invalid tokens.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { tokenDenylist } from './token-denylist.js';

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.warn('[workflow-engine] JWT_SECRET is not set — JWT authentication will fail at runtime');
}

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    orgId?: string;
    workspaceId?: string;
    jti?: string;
  };
}

export function authenticateJwt(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!JWT_SECRET) {
    return res.status(500).json({ error: 'Server misconfigured: JWT_SECRET not set' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header', code: 'UNAUTHORIZED' });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token', code: 'UNAUTHORIZED' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as {
      sub: string;
      email: string;
      role: string;
      orgId?: string;
      workspaceId?: string;
      jti?: string;
    };
    const jti = payload.jti;
    if (jti && tokenDenylist.isRevoked(jti)) {
      return res.status(401).json({ error: 'Token has been revoked', code: 'UNAUTHORIZED' });
    }
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      orgId: payload.orgId,
      workspaceId: payload.workspaceId,
      jti,
    };
    next();
  } catch (err) {
    if ((err as Error)?.message === 'Token has been revoked') {
      return res.status(401).json({ error: 'Token has been revoked', code: 'UNAUTHORIZED' });
    }
    return res.status(401).json({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' });
  }
}
