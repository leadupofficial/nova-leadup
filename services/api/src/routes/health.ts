/**
 * NOVA API — Health routes.
 *
 * Security:
 * - /health and /health/live are restricted to localhost (for k8s/load-balancer probes).
 * - /health/ready requires authentication.
 * - /health/status requires authentication (full diagnostic details).
 */
import { Router, Response } from 'express';
import { runHealthChecks, getLiveness, HealthReport } from '../utils/health.js';
import { authenticate as authenticateJwt, type AuthenticatedRequest } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const router: ReturnType<typeof Router> = Router();

// ─── Restrict all health routes to localhost by default ────────────────────────
// Kubernetes probes typically originate from the node or localhost.
const allowLocalhost = (req: any, res: Response, next: any) => {
	// Use only the TCP peer address, never req.ip (which can be spoofed by client-set X-Forwarded-For)
	const ip = req.connection?.remoteAddress || req.socket?.remoteAddress || '';
	if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
		return next();
	}
	res.status(403).json({
		type: 'https://api.nova.leadup.in/problems/forbidden',
		title: 'Forbidden',
		status: 403,
		detail: 'Health endpoints are restricted to localhost',
	});
};

// ─── Liveness (localhost-only, minimal) ────────────────────────────────────────
// Used by load balancers and orchestrators for liveness probes.
// Restricted to localhost to avoid exposing service status to the public internet.

router.get('/health', allowLocalhost, (req, res: Response) => {
	const data = getLiveness();
	logger.info(
		{ requestId: (req as any).id, route: '/health', status: data.status, uptime: data.uptime },
		'health: liveness check'
	);
	res.status(200).json(data);
});

router.get('/health/live', allowLocalhost, (req, res: Response) => {
	const data = getLiveness();
	logger.info(
		{ requestId: (req as any).id, route: '/health/live', status: data.status, uptime: data.uptime },
		'health: liveness check'
	);
	res.status(200).json(data);
});

// ─── Readiness (authenticated) ─────────────────────────────────────────────────
// Returns sanitized dependency status. Requires authentication.

router.get('/health/ready', authenticateJwt, async (req: AuthenticatedRequest, res: Response) => {
	try {
		const report = await runHealthChecks();
		const isReady = report.status !== 'unhealthy';
		const statusCode = isReady ? 200 : 503;

		// Build sanitized version: keep status, timestamp, uptime, and check names,
		// but strip sensitive details (key prefixes, pool sizes, error messages, IPs).
		const sanitized: Partial<HealthReport> = {
			status: report.status,
			timestamp: report.timestamp,
			uptime: report.uptime,
			checks: report.checks.map((check) => ({
				name: check.name,
				status: check.status,
				latencyMs: check.latencyMs,
				message: sanitizeCheckMessage(check),
			})),
			summary: report.summary,
		};

		logger.info(
			{
				requestId: (req as any).id,
				route: '/health/ready',
				status: report.status,
				checksUp: report.summary.up,
				checksDown: report.summary.down,
				checksDisabled: report.summary.disabled,
			},
			'health: readiness check'
		);

		res.status(statusCode).json(sanitized);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.error({ requestId: (req as any).id, route: '/health/ready', err: message }, 'health: readiness check failed');
		res.status(503).json({
			status: 'unhealthy',
			timestamp: new Date().toISOString(),
			uptime: 0,
			checks: [],
			summary: { total: 0, up: 0, down: 1, disabled: 0 },
		});
	}
});

// ─── Full health status (authenticated) ────────────────────────────────────────
// Returns full diagnostic details including dependency specifics.
// Requires authentication to prevent information disclosure to unauthenticated clients.

router.get('/health/status', authenticateJwt, async (req: AuthenticatedRequest, res: Response) => {
	try {
		const report = await runHealthChecks();

		logger.info(
			{
				requestId: (req as any).id,
				route: '/health/status',
				userId: req.user?.id,
				status: report.status,
				checksUp: report.summary.up,
				checksDown: report.summary.down,
			},
			'health: full status check (authenticated)'
		);

		res.status(200).json(report);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.error(
			{ requestId: (req as any).id, route: '/health/status', userId: req.user?.id, err: message },
			'health: full status check failed'
		);
		res.status(500).json({ error: 'Health check failed' });
	}
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip sensitive details from a health check message.
 *
 * Removes:
 * - API key prefixes (e.g., "sk-ant-...")
 * - Connection strings and internal IPs
 * - Raw error messages that may leak internal paths or credentials
 * - Specific version numbers that could aid targeted attacks
 */
function sanitizeCheckMessage(check: {
	name: string;
	status: 'up' | 'down' | 'disabled';
	message?: string;
	details?: Record<string, string>;
}): string | undefined {
	if (check.status === 'up') {
		// For healthy checks, return a generic message without specifics
		const genericMessages: Record<string, string> = {
			database: 'PostgreSQL connection healthy',
			redis: 'Redis connection healthy',
			ai_providers: 'AI provider configured',
			storage: 'Object storage reachable',
		};
		return genericMessages[check.name] ?? 'Check passed';
	}

	if (check.status === 'disabled') {
		return 'Service not configured';
	}

	// For failed checks, return a safe generic message
	// Do NOT leak raw error messages that may contain internal paths, credentials, etc.
	if (check.status === 'down') {
		const genericFailures: Record<string, string> = {
			database: 'Database connection failed',
			redis: 'Redis connection failed',
			ai_providers: 'AI provider unavailable',
			storage: 'Object storage unreachable',
		};
		return genericFailures[check.name] ?? 'Dependency unavailable';
	}

	return check.message;
}

export { router as healthRoutes };
