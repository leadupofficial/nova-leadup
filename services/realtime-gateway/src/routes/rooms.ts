import { Router, Request, Response } from 'express';

const router: ReturnType<typeof Router> = Router();

/**
 * GET /api/v1/realtime/rooms
 * List all active rooms.
 */
router.get('/', async (_req: Request, res: Response) => {
	try {
		const rooms = await getActiveRooms();

		res.json({
			success: true,
			data: rooms,
			meta: {
				total: rooms.length,
				timestamp: new Date().toISOString(),
			},
		});
	} catch (error) {
		console.error('[RealtimeGateway] Failed to list rooms:', error);
		res.status(500).json({
			success: false,
			error: 'ROOMS_LIST_FAILED',
			message: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

/**
 * GET /api/v1/realtime/rooms/:roomId
 * Get details of a specific room.
 */
router.get('/:roomId', async (req: Request<{ roomId: string }>, res: Response) => {
	try {
		const { roomId } = req.params;

		if (!roomId) {
			return res.status(400).json({
				success: false,
				error: 'INVALID_ROOM_ID',
				message: 'Room ID is required',
			});
		}

		const room = await getRoom(roomId);

		if (!room) {
			return res.status(404).json({
				success: false,
				error: 'ROOM_NOT_FOUND',
				message: `Room ${roomId} not found`,
			});
		}

		res.json({
			success: true,
			data: room,
		});
	} catch (error) {
		console.error(`[RealtimeGateway] Failed to get room ${req.params.roomId}:`, error);
		res.status(500).json({
			success: false,
			error: 'ROOM_FETCH_FAILED',
			message: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

/**
 * DELETE /api/v1/realtime/rooms/:roomId
 * Close a room and disconnect all participants.
 */
router.delete('/:roomId', async (req: Request<{ roomId: string }>, res: Response) => {
	try {
		const { roomId } = req.params;

		if (!roomId) {
			return res.status(400).json({
				success: false,
				error: 'INVALID_ROOM_ID',
				message: 'Room ID is required',
			});
		}

		const room = await getRoom(roomId);

		if (!room) {
			return res.status(404).json({
				success: false,
				error: 'ROOM_NOT_FOUND',
				message: `Room ${roomId} not found`,
			});
		}

		await closeRoom(roomId);

		res.json({
			success: true,
			message: `Room ${roomId} closed successfully`,
		});
	} catch (error) {
		console.error(`[RealtimeGateway] Failed to close room ${req.params.roomId}:`, error);
		res.status(500).json({
			success: false,
			error: 'ROOM_CLOSE_FAILED',
			message: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

export { router as roomRoutes };

interface Room {
	id: string;
	name: string;
	participants: number;
	createdAt: string;
	lastActivity: string;
}

async function getActiveRooms(): Promise<Room[]> {
	const rooms: Room[] = [];
	const now = new Date().toISOString();

	for (const [id, room] of ROOMS) {
		rooms.push({
			id: room.id,
			name: room.name,
			participants: room.participants.size,
			createdAt: room.createdAt,
			lastActivity: room.lastActivity,
		});
	}

	return rooms.sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
}

async function getRoom(roomId: string): Promise<Room | null> {
	const room = ROOMS.get(roomId);

	if (!room) {
		return null;
	}

	return {
		id: room.id,
		name: room.name,
		participants: room.participants.size,
		createdAt: room.createdAt,
		lastActivity: room.lastActivity,
	};
}

async function closeRoom(roomId: string): Promise<void> {
	const room = ROOMS.get(roomId);

	if (room) {
		for (const socket of room.participants) {
			socket.leave(roomId);
			try {
				socket.emit('room_closed', { roomId, reason: 'Room closed by server' });
			} catch {
				// Socket may already be disconnected
			}
		}
		ROOMS.delete(roomId);
	}
}

// In-memory room store (matches server.ts pattern)
interface RoomData {
	id: string;
	name: string;
	participants: Set<any>;
	createdAt: string;
	lastActivity: string;
}

const ROOMS: Map<string, RoomData> = new Map();
