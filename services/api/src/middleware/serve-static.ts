/**
 * NOVA API — Static file serving middleware with path-traversal protection.
 *
 * Security:
 * - Collapses `../` segments via `path.normalize()` and `path.resolve()`.
 * - Verifies the resolved path starts with the allowed root directory
 * using a cross-platform separator-aware check.
 * - Returns 403 on traversal attempts, including null-byte injection.
 * - Returns 404 for missing files (does not leak directory structure).
 */
import { Request, Response, NextFunction } from 'express';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { existsSync, statSync, lstatSync, createReadStream } from 'node:fs';

export interface ServeStaticOptions {
	root: string;
	index?: string;
	maxAge?: number;
	allowedExtensions?: string[];
}

const DEFAULT_OPTIONS: Omit<ServeStaticOptions, 'root'> = {
	index: 'index.html',
	maxAge: 0,
	allowedExtensions: undefined,
};

/**
 * Resolve a request URL path to an absolute file path inside `root`, returning
 * `null` if the resolved path escapes the root directory.
 */
export function resolveSafePath(root: string, urlPath: string): string | null {
	const resolvedRoot = resolve(normalize(root));

	// Strip query string and decode percent-encoded segments.
	const pathOnly = urlPath.split('?')[0].split('#')[0];

	// Reject null bytes which can be used to truncate paths on some platforms.
	if (pathOnly.includes('\0')) {
		return null;
	}

	let decoded: string;
	try {
		decoded = decodeURIComponent(pathOnly);
	} catch {
		return null;
	}

	// Reject null bytes after decoding as well.
	if (decoded.includes('\0')) {
		return null;
	}

	// Strip the leading slash so the value is treated as a relative path
	// under `resolvedRoot`.
	const relative = decoded.replace(/^\/+/, '');

	// Resolve and normalize — this collapses `..` segments.
	const absolute = resolve(resolvedRoot, relative);
	const normalized = normalize(absolute);

	// Cross-platform containment check: the resolved path must be exactly
	// the root or a descendant of it.
	const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
	if (normalized !== resolvedRoot && !normalized.startsWith(rootWithSep)) {
		return null;
	}

	return normalized;
}

/**
 * Build a safe static-file middleware for the given root directory.
 */
export function serveStatic(options: ServeStaticOptions) {
	const merged: ServeStaticOptions = {
		...DEFAULT_OPTIONS,
		...options,
	};

	const root = merged.root;
	const indexFile = merged.index;
	const maxAge = merged.maxAge;
	const allowedExts = merged.allowedExtensions;
	const hasExtensionRestriction = Array.isArray(allowedExts) && allowedExts.length > 0;

	const resolvedRoot = resolve(normalize(root));

	return (req: Request, res: Response, next: NextFunction): void => {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			return next();
		}

		const requested = resolveSafePath(root, req.path || '/');
		if (requested === null) {
			return sendForbidden(res, 'Access denied');
		}

		// Decide which file to actually serve: the requested path itself,
		// or its index file if the request points at a directory.
		let filePath = requested;
		if (existsSync(requested)) {
			try {
				const stat = statSync(requested);
				if (stat.isDirectory()) {
					if (indexFile) {
						filePath = join(requested, indexFile);
						// Sanity check — the index file should always be inside root.
						const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
						if (filePath !== resolvedRoot && !filePath.startsWith(rootWithSep)) {
							return sendForbidden(res, 'Access denied');
						}
					} else {
						return sendNotFound(res);
					}
				}
			} catch {
				return sendNotFound(res);
			}
		} else {
			return sendNotFound(res);
		}

		// Final existence check after directory/index resolution.
		if (!existsSync(filePath)) {
			return sendNotFound(res);
		}

		// Extension allow-list check (optional).
		if (hasExtensionRestriction) {
			const ext = extname(filePath).toLowerCase();
			if (!allowedExts.includes(ext)) {
				return sendNotFound(res);
			}
		}

		// Hand back to the next handler if the file isn't a regular file
		// (e.g. a symlink, a directory, a socket, etc.).
		let fileStat: import('node:fs').Stats;
		try {
			fileStat = lstatSync(filePath);
		} catch {
			return sendNotFound(res);
		}
		if (!fileStat.isFile()) {
			return sendNotFound(res);
		}

		const ext = extname(filePath).toLowerCase();
		const contentType = getContentType(ext);
		res.setHeader('Content-Type', contentType || 'application/octet-stream');
		res.setHeader('Content-Length', String(fileStat.size));
		if (maxAge && maxAge > 0) {
			res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
		}

		if (req.method === 'HEAD') {
			res.status(200).end();
		} else {
			const stream = createReadStream(filePath);
			stream.on('error', () => sendNotFound(res));
			stream.pipe(res);
		}
	};
}

function sendNotFound(res: Response): void {
	res.status(404).json({
		type: 'https://api.nova.leadup.in/problems/not-found',
		title: 'Not Found',
		status: 404,
		detail: 'The requested resource was not found',
	});
}

function sendForbidden(res: Response, message: string): void {
	res.status(403).json({
		type: 'https://api.nova.leadup.in/problems/forbidden',
		title: 'Forbidden',
		status: 403,
		detail: message,
	});
}

const MIME_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.htm': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.mjs': 'application/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.eot': 'application/vnd.ms-fontobject',
	'.txt': 'text/plain; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.pdf': 'application/pdf',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
};

function getContentType(ext: string): string | undefined {
	return MIME_TYPES[ext];
}
