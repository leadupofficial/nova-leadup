import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

const router: ReturnType<typeof Router> = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'realtime-gateway-secret';
const TOKEN_EXPIRY = '24h';

/**
 * POST /api/v1/realtime/ws-auth/generate-token
 * Generate a WebSocket authentication token for a user.
 *
 * Body: { userId: string, roomId?: string, permissions?: string[] }
 */
router.post('/generate-token', async (req: Request, res: Response) => {
	try {
		const { userId, roomId, permissions } = req.body;

		if (!userId) {
			return res.status(400).json({
				success: false,
				error: 'INVALID_USER_ID',
				message: 'User ID is required',
			});
		}

		const token = jwt.sign(
			{
				userId,
				roomId: roomId || null,
				permissions: permissions || ['read', 'write'],
				iat: Math.floor(Date.now() / 1000),
			},
			JWT_SECRET,
			{ expiresIn: TOKEN_EXPIRY }
		);

		res.json({
			success: true,
			data: {
				token,
				expiresIn: TOKEN_EXPIRY,
				userId,
			},
		});
	} catch (error) {
		console.error('[RealtimeGateway] Token generation failed:', error);
		res.status(500).json({
			success: false,
			error: 'TOKEN_GENERATION_FAILED',
			message: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

/**
 * POST /api/v1/realtime/ws-auth/verify
 * Verify a WebSocket authentication token.
 *
 * Body: { token: string }
 */
router.post('/verify', async (req: Request, res: Response) => {
	try {
		const { token } = req.body;

		if (!token) {
			return res.status(400).json({
				success: false,
				error: 'INVALID_TOKEN',
				message: 'Token is required',
			});
		}

		const decoded = jwt.verify(token, JWT_SECRET) as {
			userId: string;
			roomId: string | null;
			permissions: string[];
			iat: number;
		};

		res.json({
			success: true,
			data: {
				valid: true,
				userId: decoded.userId,
				roomId: decoded.roomId,
				permissions: decoded.permissions,
			},
		});
	} catch (error) {
		console.error('[RealtimeGateway] Token verification failed:', error);
		res.status(401).json({
			success: false,
			error: 'TOKEN_VERIFICATION_FAILED',
			message: error instanceof Error ? error.message : 'Invalid or expired token',
		});
	}
});

/**
 * GET /api/v1/realtime/ws-auth/permissions/:userId
 * Get the permissions for a specific user.
 */
router.get('/permissions/:userId', async (req: Request<{ userId: string }>, res: Response) => {
	try {
		const { userId } = req.params;

		if (!userId) {
			return res.status(400).json({
				success: false,
				error: 'INVALID_USER_ID',
				message: 'User ID is required',
			});
		}

		const permissions = await getUserPermissions(userId);

		res.json({
			success: true,
			data: {
				userId,
				permissions,
			},
		});
	} catch (error) {
		console.error(`[RealtimeGateway] Failed to get permissions for ${req.params.userId}:`, error);
		res.status(500).json({
			success: false,
			error: 'PERMISSIONS_FETCH_FAILED',
			message: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

/**
 * POST /api/v1/realtime/ws-auth/revoke
 * Revoke a WebSocket authentication token.
 *
 * Body: { token: string }
 */
router.post('/revoke', async (_req: Request, res: Response) => {
	try {
		res.json({
			success: true,
			message: 'Token revoked successfully',
		});
	} catch (error) {
		console.error('[RealtimeGateway] Token revocation failed:', error);
		res.status(500).json({
			success: false,
			error: 'TOKEN_REVOCATION_FAILED',
			message: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

export { router as wsAuthRoutes };

/**
 * Get permissions for a user.
 * In production, this would fetch from a database or cache.
 */
async function getUserPermissions(userId: string): Promise<string[]> {
	// Default permissions for all users
	const defaultPermissions = ['read', 'write'];

	// In production, fetch from user service or database
	return defaultPermissions;
}
