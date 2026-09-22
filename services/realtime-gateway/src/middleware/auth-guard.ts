import { verifyAccessToken } from '@nova/auth';
import type { JwtPayload } from '@nova/auth-types';
import { logger } from '../utils/logger.js';
import type { IncomingMessage } from 'node:http';

const TOKEN_RE = /^[A-Za-z0-9\-_]+$/;

/** Minimal user-lookup contract the gateway needs; injected by the caller. */
export interface AuthUserService {
 findById(userId: string): Promise<unknown | null>;
}

/** JWT payload as seen by the gateway, plus its own scope tag. */
export interface RealtimeJwtPayload extends JwtPayload {
 scope: string[];
}

export interface AuthGuardOptions {
 authSecret: string;
 userService: AuthUserService;
 tokenCacheTtlSeconds?: number;
}

export function createAuthGuard({ authSecret, userService }: AuthGuardOptions) {
 /**
 * Extract the bearer token from the most common WebSocket auth sources.
 * Priority: Authorization header > Sec-WebSocket-Protocol > query ?token=
 */
 function extractToken(req: IncomingMessage): string | undefined {
 const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

 // 1. Try Authorization header
 const authHeader = req.headers.authorization;
 if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
 return authHeader.slice(7).trim();
 }

 // 2. Try Sec-WebSocket-Protocol (proxy-issued, comma-separated)
 const swp = req.headers['sec-websocket-protocol'];
 if (typeof swp === 'string' && swp.includes('bearer ')) {
 const parts = swp.split(',').map((p) => p.trim());
 const bearerPart = parts.find((p) => p.startsWith('bearer '));
 if (bearerPart) return bearerPart.slice(7).trim();
 }

 // 3. Try query parameter
 return url.searchParams.get('token') ?? undefined;
 }

 async function verifyUserExists(userId: string): Promise<boolean> {
 let exists = false;
 try {
 const user = await userService.findById(userId);
 exists = user !== null;
 } catch {
 exists = false;
 }
 return exists;
 }

 async function verifyJwtSignature(token: string): Promise<{ ok: true; payload: JwtPayload } | { ok: false; reason: string }> {
 try {
 // @nova/auth verifies with the secret configured in its own environment.
 const payload = await verifyAccessToken(token);
 if (!payload.sub) {
 return { ok: false, reason: 'Token missing subject claim' };
 }
 return { ok: true, payload };
 } catch (err: any) {
 const msg = err?.message ?? String(err);
 if (/expired|jwt expired/i.test(msg)) {
 return { ok: false, reason: 'Token expired' };
 }
 if (/signature|invalid|malformed/i.test(msg)) {
 return { ok: false, reason: 'Invalid token' };
 }
 return { ok: false, reason: 'Token verification failed' };
 }
 }

 async function authenticateConnection(req: IncomingMessage): Promise<RealtimeJwtPayload> {
 // Reject obvious non-token inputs up-front
 const candidate = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim() ?? '';
 if (!candidate || !TOKEN_RE.test(candidate)) {
 // Fall back to multi-source extraction for ws/sec-websocket-protocol/query
 const extracted = extractToken(req);
 if (!extracted || !TOKEN_RE.test(extracted)) {
 throw new Error('Missing authentication token');
 }
 return authenticateWithToken(req, extracted);
 }
 return authenticateWithToken(req, candidate);
 }

 async function authenticateWithToken(req: IncomingMessage, token: string): Promise<RealtimeJwtPayload> {
 let payload: JwtPayload;
 try {
 const result = await verifyJwtSignature(token);
 if (!result.ok) {
 throw new Error(`[${result.reason}]`);
 }
 payload = result.payload;
 } catch (err: any) {
 const msg = err?.message ?? String(err);
 if (msg.startsWith('[') && msg.endsWith(']')) {
 throw new Error(msg.slice(1, -1));
 }
 if (/expired|jwt expired/i.test(msg)) throw new Error('Token expired');
 if (/signature|invalid|malformed/i.test(msg)) throw new Error('Invalid token');
 throw new Error('Token verification failed');
 }

 if (!(await verifyUserExists(payload.sub))) throw new Error('User not found');

 // Attach payload to request so callers can inspect it later
 const enriched: RealtimeJwtPayload = { ...payload, scope: ['realtime'] };
 (req as any).user = enriched;
 logger.info({ sessionId: (req as any).sessionId, userId: payload.sub, role: payload.role }, 'Session authenticated');
 return enriched;
 }

 return { authenticateConnection };
}
