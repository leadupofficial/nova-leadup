import { Router } from 'express';
import { z } from 'zod';
import { authenticateJwt } from '@nova/auth';

const router: ReturnType<typeof Router> = Router();

const IntegrationSchema = z.object({ provider: z.string(), config: z.record(z.string(), z.unknown()) });

// These endpoints previously reported success without doing anything. `/connect`
// returned status 'connected' with a `int-${Date.now()}` id and no OAuth, no token
// storage and no provider call; `/status` was hardcoded empty; DELETE claimed to
// have disconnected a provider it had never contacted.
//
// A client was told an integration worked when nothing had happened. That is worse
// than an honest failure, and the master document is explicit that tool success is
// never reported without authoritative confirmation (§2.9, §22.3). They now answer
// 501 until implemented — replace each as it lands.
const NOT_IMPLEMENTED = {
	success: false,
	error: {
		code: 'NOT_IMPLEMENTED',
		message: 'Integration connection is not implemented yet.',
	},
} as const;

// A provider is only usable when this deployment holds OAuth client credentials for
// it. Listing a name without them would repeat the mistake this file already made
// once: telling a caller something works when it cannot.
const PROVIDER_ENV: Record<string, { id: string; secret: string }> = {
	google: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
	microsoft: { id: 'MICROSOFT_CLIENT_ID', secret: 'MICROSOFT_CLIENT_SECRET' },
	github: { id: 'GITHUB_CLIENT_ID', secret: 'GITHUB_CLIENT_SECRET' },
};

function providerState(name: string): 'configured' | 'not_configured' {
	const keys = PROVIDER_ENV[name];
	if (!keys) return 'not_configured';
	return process.env[keys.id] && process.env[keys.secret] ? 'configured' : 'not_configured';
}

router.get('/providers', (_req, res) => {
	const names = Object.keys(PROVIDER_ENV);
	const state = Object.fromEntries(names.map((n) => [n, providerState(n)]));
	const configured = names.filter((n) => state[n] === 'configured');
	res.json({
		providers: names,
		state,
		configured,
		// Stated plainly rather than left for the caller to infer from an empty list.
		note: configured.length
			? 'Only configured providers can be connected.'
			: 'No provider is configured on this deployment, so none can be connected yet. OAuth requires a client id and secret registered with each vendor; those are a deployment decision, not something the service can supply.',
	});
});

router.post('/connect', authenticateJwt, async (req, res, next) => {
	try {
		IntegrationSchema.parse(req.body);
		res.status(501).json(NOT_IMPLEMENTED);
	} catch (err) { next(err); }
});

router.get('/status', authenticateJwt, (_req, res) => {
	// An empty list is truthful: nothing can have been connected, because
	// connecting is not implemented. Kept at 200 so the UI renders an empty state
	// rather than an error banner.
	res.json({ integrations: [] });
});

router.delete('/:provider', authenticateJwt, (_req, res) => {
	res.status(501).json(NOT_IMPLEMENTED);
});

export { router as integrationRoutes };
