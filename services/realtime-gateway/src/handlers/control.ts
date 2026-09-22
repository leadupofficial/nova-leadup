import { WebSocket } from 'ws';
import type { VoiceSession } from '@nova/shared-types';
import { logger } from '../utils/logger.js';
import { endSession } from '../sessions.js';

export interface ControlHandlerOptions {
 pingIntervalMs?: number;
 pongTimeoutMs?: number;
}

/**
 * Sets up control message handling on a WebSocket connection.
 *
 * Handles: ping/pong keepalive, session control, reconnection.
 */
export function setupControlHandler(
 ws: WebSocket,
 session: VoiceSession,
 _opts: ControlHandlerOptions = {}
): void {
 let pingTimer: NodeJS.Timeout | null = null;
 let pongTimer: NodeJS.Timeout | null = null;
 const pingInterval = _opts.pingIntervalMs ?? 30000;
 const pongTimeout = _opts.pongTimeoutMs ?? 5000;

 const startPing = (): void => {
 pingTimer = setInterval(() => {
 if (ws.readyState !== WebSocket.OPEN) {
 clearPingTimers();
 return;
 }

 ws.ping();

 pongTimer = setTimeout(() => {
 logger.warn({ sessionId: session.sessionId }, 'Pong timeout, closing connection');
 ws.close(1001, 'Pong timeout');
 clearPingTimers();
 }, pongTimeout);
 }, pingInterval);
};

 const clearPingTimers = (): void => {
 if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
 if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
 };

 ws.on('open', () => {
 logger.debug({ sessionId: session.sessionId }, 'Control handler attached');
 startPing();
 });

 ws.on('message', (data: Buffer) => {
 try {
 const msg = JSON.parse(data.toString('utf-8'));

 switch (msg.type) {
 case 'pong':
 if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
 break;

 case 'reconnect':
 logger.info({ sessionId: session.sessionId }, 'Reconnect request received');
 ws.send(JSON.stringify({
 type: 'reconnect_ack',
 data: { sessionId: session.sessionId, canReconnect: true },
 }));
 break;

 case 'cancel':
 logger.info({ sessionId: session.sessionId }, 'Client cancelled session');
 endSession(session.sessionId);
 break;

 default:
 // Ignore unknown control messages
 break;
 }
 } catch {
 // Non-JSON control frames are ignored
 }
 });

 ws.on('close', () => {
 clearPingTimers();
 logger.debug({ sessionId: session.sessionId }, 'Control handler cleaned up');
 });

 ws.on('error', (err) => {
 clearPingTimers();
 logger.error({ sessionId: session.sessionId, err }, 'WebSocket error in control handler');
 });
}
