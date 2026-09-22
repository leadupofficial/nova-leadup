/**
 * NOVA Realtime Gateway — WebSocket gateway factory.
 *
 * Authenticates every connection via JWT before routing to handlers.
 */
import http from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { VoiceSession, VoiceProviderConfig } from '@nova/shared-types';
import { createRateLimiter } from './middleware/rate-limiter.js';
import { createAuthGuard } from './middleware/auth-guard.js';
import type { JwtPayload } from '@nova/auth-types';
import { setupAudioHandler } from './handlers/audio.js';
import { setupTextHandler } from './handlers/text.js';
import { setupControlHandler } from './handlers/control.js';
import { registerSession, unregisterSession, cleanupStale, endSession as endSessionInternal, startCleanupTimer, getActiveSessionCount } from './sessions.js';
import { logger } from './utils/logger.js';

export interface RealtimeGatewayOptions {
 port?: number;
 path?: string;
 authSecret?: string;
 corsOrigins?: string[];
 maxReconnectRateMs?: number; // minimum ms between reconnects per IP (default: 5000)
}

export function createRealtimeGateway(server: http.Server, _opts: RealtimeGatewayOptions = {}): void {
 const wss = new WebSocketServer({ server, path: '/ws/realtime', maxPayload: 1024 * 1024 });

 // Enforce reconnect rate-limit to prevent DoS on JWT crypto under reconnection storms.
 const reconnectRateLimiter = createRateLimiter({ windowMs: _opts.maxReconnectRateMs ?? 5000, limit: 1 });

 const authGuard = createAuthGuard({ authSecret: _opts.authSecret ?? '', userService: { findById: async () => null } as any });

 wss.on('connection', async (ws: WebSocket, req: http.IncomingMessage) => {
 // --- Rate-limit reconnects per IP ---
 const clientIp = req.socket.remoteAddress ?? 'unknown';
 const rateResult = await reconnectRateLimiter.check(clientIp);
 if (!rateResult.allowed) {
 logger.warn({ ip: clientIp, retryAfter: rateResult.resetTime - Date.now() }, 'Realtime reconnect rate-limited');
 ws.close(4429, 'Too many reconnects — please wait');
 return;
 }

 try {
 const payload = await authGuard.authenticateConnection(req);
 const session = await buildSession(ws, payload);

 setupAudioHandler(ws, session);
 setupTextHandler(ws, session);
 setupControlHandler(ws, session);

 ws.send(JSON.stringify({
 type: 'authenticated',
 sessionId: session.sessionId,
 }));
 } catch (err) {
 const message = err instanceof Error ? err.message : 'Authentication failed';
 logger.warn({ err: message }, 'WebSocket connection rejected');
 ws.close(4001, message);
 return;
 }

 ws.on('close', () => {
 const sessionId = (ws as any).sessionId;
 if (sessionId) {
 unregisterSession(sessionId);
 }
 });
 });
}

async function buildSession(ws: WebSocket, payload: JwtPayload): Promise<VoiceSession> {
 const sessionId = crypto.randomUUID();
 (ws as any).sessionId = sessionId;

 const voiceSession: VoiceSession = {
 sessionId,
 userId: payload.sub,
 provider: 'sarvam',
 config: {} as VoiceProviderConfig,
 status: 'connecting',
 transcriptBuffer: [],
 audioLevel: 0,
 startedAt: new Date(),
 };

 registerSession(voiceSession, ws);
 logger.info({ sessionId, userId: payload.sub, role: payload.role }, 'Session authenticated');

 return voiceSession;
}

export function getRealtimeStatus() {
 return {
 activeSessions: getActiveSessionCount(),
 uptime: process.uptime(),
 };
}

export function endSession(sessionId: string): void {
 endSessionInternal(sessionId);
}

startCleanupTimer();
