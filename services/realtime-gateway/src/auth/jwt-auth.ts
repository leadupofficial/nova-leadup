/**
 * JWT Authentication Middleware for WebSocket connections.
 *
 * Validates Bearer tokens from the Sec-WebSocket-Protocol header or
 * Authorization header on WebSocket upgrade requests.
 *
 * SECURITY: Uses proper JWT verification with the gateway's signing key.
 */

import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { IncomingMessage } from 'http';
import { tokenDenylist } from './token-denylist';

// Re-export secure random utilities for convenience
export { generateSessionId, generateConversationId, secureRandomHex } from './secure-random';

/**
 * Configuration for JWT authentication.
 */
export interface JwtAuthConfig {
 secret: string;
 algorithms?: string[];
 issuer?: string;
 audience?: string;
}

/**
 * Result of JWT authentication attempt.
 */
export interface AuthResult {
 success: boolean;
 userId?: string;
 sessionId?: string;
 conversationId?: string;
 error?: string;
}

/**
 * Create a JWT authentication middleware instance.
 *
 * @param config - JWT configuration including secret key
 * @returns Express middleware function
 */
export function createJwtAuthMiddleware(config: JwtAuthConfig) {
 const {
 secret,
 algorithms = ['HS256'],
 issuer,
 audience,
 } = config;

 /**
 * Extract Bearer token from Authorization header or Sec-WebSocket-Protocol.
 *
 * @param req - The incoming request
 * @returns The extracted token or null
 */
 function extractToken(req: Request | IncomingMessage): string | null {
 // Check standard Authorization header first
 const authHeader = 'headers' in req ? req.headers.authorization : undefined;
 if (authHeader?.startsWith('Bearer ')) {
 return authHeader.slice(7);
 }

 // Check Sec-WebSocket-Protocol header (WebSocket connections)
 const wsProtocol = 'headers' in req ? req.headers['sec-websocket-protocol'] : undefined;
 if (wsProtocol?.startsWith('Bearer ')) {
 return wsProtocol.slice(7);
 }

 // Check query parameter (fallback)
 const url = 'url' in req ? req.url : undefined;
 if (url) {
 const queryMatch = url.match(/[?&]token=([^&]+)/);
 if (queryMatch) {
 return decodeURIComponent(queryMatch[1]);
 }
 }

 return null;
 }

 /**
 * Verify and decode a JWT token.
 *
 * @param token - The JWT token to verify
 * @returns Decoded payload or null if invalid
 */
 function verifyToken(token: string): any {
 try {
 const decoded = jwt.verify(token, secret, {
 algorithms,
 issuer,
 audience,
 }) as any;
 return decoded;
 } catch (error) {
 return null;
 }
 }

 return (req: Request, res: Response, next: NextFunction) => {
 // Allow preflight OPTIONS requests
 if (req.method === 'OPTIONS') {
 return next();
 }

 const token = extractToken(req);

 if (!token) {
 res.status(401).json({ error: 'Missing authentication token' });
 return;
 }

 const payload = verifyToken(token);

 if (!payload) {
 res.status(401).json({ error: 'Invalid or expired authentication token' });
 return;
 }

 // Check token denylist (logout revocation)
 if (payload.jti && await tokenDenylist.isRevoked(payload.jti)) {
 res.status(401).json({ error: 'Token has been revoked' });
 return;
 }

 // Check subject-level revocation (e.g., after password change)
 const sub = payload.sub || payload.userId || payload.id;
 const subjectRevokedAt = await tokenDenylist.getSubjectRevocation(sub);
 if (subjectRevokedAt && payload.iat && payload.iat * 1000 < subjectRevokedAt) {
 res.status(401).json({ error: 'Token has been revoked' });
 return;
 }

 // Attach user context to request
 (req as any).user = {
 id: sub,
 email: payload.email,
 role: payload.role || 'user',
 sessionId: payload.sessionId,
 conversationId: payload.conversationId,
 };

 next();
 };
}

/**
 * WebSocket JWT authentication handler.
 *
 * @param config - JWT configuration
 * @returns Authentication result for WebSocket upgrade
 */
export function authenticateWebSocket(config: JwtAuthConfig): (req: IncomingMessage) => Promise<AuthResult> {
 return async (req: IncomingMessage) => {
 const token = extractToken(req);

 if (!token) {
 return { success: false, error: 'Missing authentication token' };
 }

 try {
 const payload = jwt.verify(token, config.secret, {
 algorithms: config.algorithms || ['HS256'],
 issuer: config.issuer,
 audience: config.audience,
 }) as any;

 // Check token denylist (logout revocation)
 if (payload.jti) {
 const revoked = await tokenDenylist.isRevoked(payload.jti);
 if (revoked) {
 return { success: false, error: 'Token has been revoked' };
 }
 }

 const sub = payload.sub || payload.userId || payload.id;
 const subjectRevokedAt = await tokenDenylist.getSubjectRevocation(sub);
 if (subjectRevokedAt && payload.iat && payload.iat * 1000 < subjectRevokedAt) {
 return { success: false, error: 'Token has been revoked' };
 }

 return {
 success: true,
 userId: sub,
 sessionId: payload.sessionId,
 conversationId: payload.conversationId,
 };
 } catch (error) {
 return { success: false, error: 'Invalid or expired token' };
 }
 };
}
