/**
 * NOVA API — Socket.IO notification event handlers.
 *
 * Registers real-time notification events on the Socket.IO server instance:
 * - client:join_user_room
 * - notification:new / notification:read / notification:deleted / notification:allRead
 * - notification:unreadCount
 */

import type { Server as SocketIOServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import { notificationService } from '../services/notification.service.js';
import { logger } from '../utils/logger.js';

const JWT_SECRET = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('FATAL: JWT_SECRET environment variable is not set. Application startup aborted.');
  }
  return secret;
})();

function verifySocketToken(token: string): { userId: string; email: string; role: string } {
	return jwt.verify(token, JWT_SECRET) as { userId: string; email: string; role: string };
}

export function setupNotificationSocketHandlers(io: SocketIOServer): void {
	io.use(async (socket, next) => {
		try {
			const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
			if (!token) {
				return next(new Error('Authentication required'));
			}
			const decoded = verifySocketToken(token);
			socket.data.userId = decoded.userId;
			next();
		} catch (err) {
			next(err as Error);
		}
	});

	io.on('connection', (socket) => {
		const userId = socket.data.userId;
		if (!userId) {
			socket.disconnect(true);
			return;
		}

		socket.join(`user:${userId}`);
		logger.debug({ socketId: socket.id, userId }, 'Socket joined notification room');

		socket.on('client:join_user_room', () => {
			socket.join(`user:${userId}`);
			logger.debug({ socketId: socket.id, userId }, 'Socket rejoined notification room');
		});

		socket.on('notification:unreadCount', async (callback) => {
			try {
				const result = await notificationService.getUnreadCount(userId);
				if (typeof callback === 'function') {
					callback({ success: true, data: result.data });
				}
			} catch (err) {
				logger.error({ err, userId }, 'Failed to fetch unread notification count');
				if (typeof callback === 'function') {
					callback({ success: false, error: 'Failed to fetch unread count' });
				}
			}
		});

		socket.on('disconnect', () => {
			logger.debug({ socketId: socket.id, userId }, 'Socket disconnected from notification room');
		});
	});

	logger.info('Socket.IO notification handlers registered');
}
