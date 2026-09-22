/**
 * NOVA API — WebSocket entry point for the realtime voice pipeline.
 *
 * `GET /api/v1/voice/realtime`, upgraded from the same HTTP server that serves
 * the REST app (`src/server.ts` builds it with `http.createServer(app)`), so
 * nothing about the existing routes changes.
 *
 * **Authentication — chosen mechanism:** the access token is read from the
 * `token` query parameter (`?token=<access token>`), falling back to an
 * `Authorization: Bearer <token>` header. Browsers cannot set headers on a
 * WebSocket handshake, and the Flutter client's `web_socket_channel` cannot
 * either, so the query parameter is the mechanism clients should use; the
 * header is accepted for parity with the REST API. The token is verified with
 * the exact same code path as the REST `authenticate` middleware (signature,
 * expiry and the JTI denylist) and an unauthenticated upgrade is rejected with
 * `401` *before* the socket is handed to a session — no anonymous connection is
 * ever accepted.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { logger } from '../utils/logger.js';
import { verifyAccessToken } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { REALTIME_PATH } from './protocol.js';
import { RealtimeVoiceSession } from './session.js';
import { registerRealtimeSession, unregisterRealtimeSession } from './registry.js';

/** Refuse an upgrade the way an HTTP endpoint would, instead of accepting then closing. */
function rejectUpgrade(socket: Duplex, status: number, message: string): void {
	const body = JSON.stringify({ error: message, status });
	try {
		socket.write(
			`HTTP/1.1 ${status} ${message}\r\n` +
				'Connection: close\r\n' +
				'Content-Type: application/json\r\n' +
				`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
				body,
		);
	} catch {
		/* client already gone */
	}
	socket.destroy();
}

function extractToken(req: IncomingMessage, url: URL): string | null {
	const fromQuery = url.searchParams.get('token');
	if (fromQuery?.trim()) return fromQuery.trim();
	const header = req.headers.authorization;
	if (header?.startsWith('Bearer ')) return header.slice(7).trim();
	return null;
}

/**
 * Attaches the realtime voice socket to an existing HTTP server.
 * Returns the `WebSocketServer` so callers (and tests) can close it.
 */
export function attachRealtimeVoice(server: Server): WebSocketServer {
	const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });

	server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		void handleUpgrade(req, socket, head, wss);
	});

	logger.info(
		{ path: REALTIME_PATH },
		'Realtime voice WebSocket attached (auth: ?token= query parameter, or Authorization: Bearer header)',
	);
	return wss;
}

/**
 * Upgrade handling, including the realtime/voice kill switches.
 *
 * Extracted and made async so it can consult the operator controls before accepting.
 * A switch that refuses is answered with `503` and a machine-readable body rather
 * than a silent socket close, so the client can distinguish "NOVA is offline for
 * maintenance" from "your connection dropped" and show the right message.
 *
 * The kill switch is checked **before** the token is verified for the same reason a
 * load balancer sheds traffic before it reaches the app: when voice is disabled,
 * every arriving socket is refused identically and cheaply.
 */
async function handleUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	wss: WebSocketServer,
): Promise<void> {
	let url: URL;
	try {
		url = new URL(req.url ?? '/', 'http://localhost');
	} catch {
		socket.destroy();
		return;
	}

	if (url.pathname !== REALTIME_PATH) {
		// This service owns no other upgraded endpoint; leaving the socket
		// open would park it until the client times out.
		socket.destroy();
		return;
	}

	// Operator kill switches. Imported lazily so the realtime module does not add a
	// database import to the WebSocket path for deployments that never mount it.
	try {
		const { getRuntimeControls } = await import('../admin/control.js');
		const controls = await getRuntimeControls();
		if (!controls.realtimeEnabled) {
			logger.warn({ path: url.pathname }, 'Realtime voice upgrade rejected: realtime disabled by operator');
			rejectUpgrade(socket, 503, 'Realtime transport is disabled');
			return;
		}
		if (!controls.voiceEnabled) {
			logger.warn({ path: url.pathname }, 'Realtime voice upgrade rejected: voice disabled by operator');
			rejectUpgrade(socket, 503, 'Voice is disabled');
			return;
		}
	} catch (error) {
		// A control lookup failure must not take voice down; log and continue.
		logger.error({ err: error }, 'Could not read operator controls before accepting realtime upgrade');
	}

	const token = extractToken(req, url);
	if (!token) {
		logger.warn({ path: url.pathname }, 'Realtime voice upgrade rejected: no access token');
		rejectUpgrade(socket, 401, 'Unauthorized');
		return;
	}

	let user: { id: string; email: string; role: string };
	try {
		user = verifyAccessToken(token);
	} catch (err) {
		const statusCode = err instanceof HttpError ? err.statusCode : 401;
		logger.warn({ err, path: url.pathname }, 'Realtime voice upgrade rejected: invalid token');
		if (statusCode >= 500) rejectUpgrade(socket, 500, 'Internal Server Error');
		else rejectUpgrade(socket, 401, 'Unauthorized');
		return;
	}

	const sessionId = registerRealtimeSession({ userId: user.id, email: user.email, role: user.role });

	wss.handleUpgrade(req, socket, head, (ws) => {
		const session = new RealtimeVoiceSession(ws, user);
		// The registry entry is released on close, however the socket ends —
		// including an abrupt client disappearance, which is the common case on
		// mobile. Without this the console's "active connections" would climb and
		// never fall.
		ws.once('close', () => unregisterRealtimeSession(sessionId));
		session.start();
	});
}

export { RealtimeVoiceSession } from './session.js';
export {
	getActiveRealtimeSessionCount,
	getActiveRealtimeUserCount,
	snapshotRealtimeSessions,
	realtimeSessionsForUser,
	closeRealtimeSessionsForUser,
} from './registry.js';
export { REALTIME_PATH } from './protocol.js';
