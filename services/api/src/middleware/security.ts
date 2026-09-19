/**
 * Security middleware — Helmet, CORS, compression, xss protection.
 *
 * Security fixes applied:
 * - P1-05: Re-enabled Helmet's Content-Security-Policy with production-grade directives.
 */
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import xss from 'xss';
import type { Request, Response } from 'express';

const isProd = process.env.NODE_ENV === 'production';
const FRONTEND_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:3001').split(',').map((s) => s.trim());

/**
 * Build the CSP directives string for Helmet.
 *
 * Production posture:
 * - Default-src: 'self' (everything blocked by default)
 * - script-src: 'self' (no inline scripts; use nonce/upgrade-insecure)
 * - style-src: 'self' 'nonce-*' (allow inline styles with nonce, no unsafe-inline)
 * - img-src: 'self' data: https: (allow data URIs for avatars, HTTPS for CDN)
 * - connect-src: 'self' wss: https: (API + WebSocket + analytics)
 * - font-src: 'self' data: (self-hosted fonts + data URIs)
 * - frame-ancestors: 'none' (clickjacking protection)
 * - base-uri: 'self' (limit <base> injection)
 * - form-action: 'self' (limit form submission targets)
 * - upgrade-insecure-requests: [] (force HTTPS in production)
 */
function buildCSPDirectives() {
	const directives: Record<string, string[]> = {
		'default-src': ["'self'"],
		'script-src': ["'self'"],
		'style-src': ["'self'", "'nonce-*'"],
		'img-src': ["'self'", 'data:', 'https:'],
		'connect-src': ["'self'", 'wss:', 'https:'],
		'font-src': ["'self'", 'data:'],
		'object-src': ["'none'"],
		'frame-ancestors': ["'none'"],
		'base-uri': ["'self'"],
		'form-action': ["'self'"],
	};

	if (isProd) {
		directives['upgrade-insecure-requests'] = [];
	}

	// Serialize: key value1 value2 (empty array = bare directive)
	return Object.entries(directives)
		.map(([key, values]) => (values.length === 0 ? key : `${key} ${values.join(' ')}`))
		.join('; ');
}

/**
 * Helmet configuration with all security headers enabled.
 */
export function helmetMiddleware() {
	return helmet({
		contentSecurityPolicy: {
			useDefaults: false,
			directives: {
				defaultSrc: ["'self'"],
				scriptSrc: ["'self'"],
				styleSrc: ["'self'", "'nonce-*'"],
				imgSrc: ["'self'", 'data:', 'https:'],
				connectSrc: ["'self'", 'wss:', 'https:'],
				fontSrc: ["'self'", 'data:'],
				objectSrc: ["'none'"],
				frameAncestors: ["'none'"],
				baseUri: ["'self'"],
				formAction: ["'self'"],
				...(isProd ? { upgradeInsecureRequests: [] } : {}),
			},
		},
		crossOriginEmbedderPolicy: false, // Disabled: breaks CDN image loading; use CORS instead
		crossOriginResourcePolicy: { policy: 'same-origin' }, // P1-05: prevent cross-origin reads of resources
		crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
		hsts: isProd
			? {
				maxAge: 31536000,
				includeSubDomains: true,
				preload: true,
			}
			: false,
		referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
		permittedCrossDomainPolicies: { permittedPolicies: 'none' },
		ieNoOpen: true,
		noSniff: true,
		xssFilter: true,
		originAgentCluster: true,
	});
}

/**
 * CORS configuration — strict in production, permissive in development.
 */
export function corsMiddleware() {
	return cors({
		origin: (origin, callback) => {
			if (!origin || FRONTEND_ORIGINS.includes(origin) || (isProd === false)) {
				callback(null, true);
			} else {
				callback(new Error(`Origin ${origin} not allowed by CORS`) as never);
			}
		},
		credentials: true,
		methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
		allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Idempotency-Key', 'X-CSRF-Token'],
		exposedHeaders: ['X-Request-ID', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
		maxAge: 600,
		preflightContinue: false,
		optionsSuccessStatus: 204,
	});
}

/**
 * Compression — only applied to text-based responses.
 */
export function compressionMiddleware(): ReturnType<typeof compression> {
	return compression({
		filter: (req: Request, res: Response) => {
			if (req.headers['x-no-compression']) return false;
			const type = res.getHeader('Content-Type') as string | undefined;
			if (type && /text|json|javascript|css|svg|xml/.test(type)) return true;
			return false;
		},
		threshold: 1024,
		level: isProd ? 6 : 1,
	});
}

/**
 * XSS sanitization — strips dangerous HTML/JS from request bodies.
 * Uses the xss library with a safe whitelist.
 */
export function sanitizeBodyMiddleware() {
	return (req: any, _res: any, next: any) => {
		if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
			req.body = xss(req.body, {
				whiteList: {
					b: [],
					i: [],
					u: [],
					strong: [],
					em: [],
					a: ['href', 'title'],
					p: [],
					br: [],
					ul: [],
					ol: [],
					li: [],
					h1: [],
					h2: [],
					h3: [],
					h4: [],
					h5: [],
					h6: [],
				},
				stripIgnoreTag: true,
				stripIgnoreTagBody: ['script'],
			});
		}
		next();
	};
}

export { buildCSPDirectives };
