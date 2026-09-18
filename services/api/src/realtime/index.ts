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

		wss.handleUpgrade(req, socket, head, (ws) => {
			const session = new RealtimeVoiceSession(ws, user);
			session.start();
		});
	});

	logger.info(
		{ path: REALTIME_PATH },
		'Realtime voice WebSocket attached (auth: ?token= query parameter, or Authorization: Bearer header)',
	);
	return wss;
}

export { RealtimeVoiceSession } from './session.js';
export { REALTIME_PATH } from './protocol.js';
