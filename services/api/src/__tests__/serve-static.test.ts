/**
 * NOVA API — serve-static middleware tests.
 *
 * Covers: normal file serving, directory-traversal rejection (403),
 * non-existent files (404), null-byte rejection, and symlink escape attempts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { serveStatic, resolveSafePath } from '../middleware/serve-static.js';
import express from 'express';
import request from 'supertest';

const CURRENT_DIR = fileURLToPath(new URL('.', import.meta.url));
const ASSETS_DIR = resolve(join(CURRENT_DIR, '..', '__tests__', 'fixtures', 'serve-static-assets'));

beforeAll(() => {
	mkdirSync(ASSETS_DIR, { recursive: true });
	writeFileSync(join(ASSETS_DIR, 'index.html'), '<html><body>index</body></html>');
	writeFileSync(join(ASSETS_DIR, 'style.css'), 'body{}');
	writeFileSync(join(ASSETS_DIR, 'app.js'), 'console.log(1)');

	// Create a nested file that should be accessible
	mkdirSync(join(ASSETS_DIR, 'sub'), { recursive: true });
	writeFileSync(join(ASSETS_DIR, 'sub', 'nested.txt'), 'nested');
});

afterAll(() => {
	try {
		unlinkSync(join(ASSETS_DIR, 'index.html'));
		unlinkSync(join(ASSETS_DIR, 'style.css'));
		unlinkSync(join(ASSETS_DIR, 'app.js'));
		unlinkSync(join(ASSETS_DIR, 'sub', 'nested.txt'));
		rmSync(join(ASSETS_DIR, 'sub'), { recursive: true });
		rmSync(ASSETS_DIR, { recursive: true });
	} catch {
		// best-effort cleanup
	}
});

describe('serveStatic middleware', () => {
	const buildApp = (root: string) => {
		const app = express();
		app.use(serveStatic({ root, index: 'index.html' }));
		return app;
	};

	describe('normal file requests', () => {
		it('serves index.html at the root path with 200', async () => {
			const app = buildApp(ASSETS_DIR);
			const res = await request(app).get('/');
			expect(res.status).toBe(200);
			expect(res.headers['content-type']).toContain('text/html');
			expect(res.text).toContain('index');
		});

		it('serves a known CSS file with 200', async () => {
			const app = buildApp(ASSETS_DIR);
			const res = await request(app).get('/style.css');
			expect(res.status).toBe(200);
			expect(res.headers['content-type']).toContain('text/css');
		});

		it('serves a known JS file with 200', async () => {
			const app = buildApp(ASSETS_DIR);
			const res = await request(app).get('/app.js');
			expect(res.status).toBe(200);
			expect(res.headers['content-type']).toContain('application/javascript');
		});

		it('serves files in subdirectories with 200', async () => {
			const app = buildApp(ASSETS_DIR);
			const res = await request(app).get('/sub/nested.txt');
			expect(res.status).toBe(200);
			expect(res.text).toContain('nested');
		});

		it('returns the correct Content-Length', async () => {
			const app = buildApp(ASSETS_DIR);
			const res = await request(app).get('/app.js');
			expect(res.status).toBe(200);
			expect(res.headers['content-length']).toBeDefined();
			expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
		});
	});

	describe('path traversal attempts', () => {
		const app = buildApp(ASSETS_DIR);

		it('blocks a simple ../ traversal with 403', async () => {
			const res = await request(app).get('/../../../etc/passwd');
			expect(res.status).toBe(403);
		});

		it('blocks a double-dot traversal with 403', async () => {
			const res = await request(app).get('/sub/../../etc/passwd');
			expect(res.status).toBe(403);
		});

		it('blocks a traversal to a legitimate file outside the root with 403', async () => {
			const res = await request(app).get('/../../../package.json');
			expect(res.status).toBe(403);
		});

		it('blocks percent-encoded ../ (%2e%2e) traversal with 403', async () => {
			const res = await request(app).get('/..%2f..%2fetc%2fpasswd');
			expect(res.status).toBe(403);
		});

		it('blocks double-encoded traversal with 403', async () => {
			const res = await request(app).get('/..%252f..%252fetc%252fpasswd');
			expect(res.status).toBe(403);
		});

		it('blocks a null-byte injection attempt', async () => {
			const res = await request(app).get('/style.css%00.txt');
			expect(res.status).toBe(403);
		});
	});

	describe('non-existent files', () => {
		const app = buildApp(ASSETS_DIR);

		it('returns 404 for a missing file', async () => {
			const res = await request(app).get('/does-not-exist.html');
			expect(res.status).toBe(404);
		});

		it('returns 404 for a deeply nested missing file', async () => {
			const res = await request(app).get('/a/b/c/missing.html');
			expect(res.status).toBe(404);
		});

		it('returns 404 for a directory without an index file', async () => {
			// We only set index.html for the root; other dirs should 404 if no file is requested
			const res = await request(app).get('/sub/');
			expect(res.status).toBe(404);
		});
	});

	describe('symlink escape attempts', () => {
		const app = buildApp(ASSETS_DIR);

		beforeAll(() => {
			// Create a symlink inside the assets dir pointing outside the root
			try {
				symlinkSync(resolve(join(ASSETS_DIR, '..', '..', 'package.json')), join(ASSETS_DIR, 'escape-link'));
			} catch {
				// symlink may already exist or permissions may block it
			}
		});

		afterAll(() => {
			try {
				unlinkSync(join(ASSETS_DIR, 'escape-link'));
			} catch {
				// best-effort
			}
		});

		it('does NOT serve a symlink pointing outside the root (returns 403)', async () => {
			const res = await request(app).get('/escape-link');
			// The middleware rejects non-file entries, so expect 404 (we chose
			// to return 404 for non-files rather than 403 for symlinks).
			// Either 403 or 404 is acceptable as long as the file is not served.
			expect([403, 404]).toContain(res.status);
		});
	});

	describe('extension allow-listing', () => {
		it('allows only configured extensions and 404s everything else', async () => {
			const app = express();
			app.use(serveStatic({ root: ASSETS_DIR, index: 'index.html', allowedExtensions: ['.html'] }));

			const ok = await request(app).get('/index.html');
			expect(ok.status).toBe(200);

			const blocked = await request(app).get('/style.css');
			expect(blocked.status).toBe(404);
		});
	});

	describe('method gating', () => {
		it('passes POST requests through to the next handler', async () => {
			const app = express();
			app.use(serveStatic({ root: ASSETS_DIR, index: 'index.html' }));
			app.post('/style.css', (_req, res) => res.sendStatus(200));
			const res = await request(app).post('/style.css');
			expect(res.status).toBe(200);
		});
	});
});

describe('resolveSafePath', () => {
	const root = resolve('/var/www/assets');

	it('resolves a normal path under the root', () => {
		const result = resolveSafePath(root, '/style.css');
		expect(result).toBe(resolve('/var/www/assets/style.css'));
	});

	it('resolves a path starting with / correctly', () => {
		const result = resolveSafePath(root, '/sub/nested.txt');
		expect(result).toBe(resolve('/var/www/assets/sub/nested.txt'));
	});

	it('returns null for a ../ traversal', () => {
		expect(resolveSafePath(root, '/../../../etc/passwd')).toBeNull();
	});

	it('returns null for a nested traversal', () => {
		expect(resolveSafePath(root, '/sub/../../etc/passwd')).toBeNull();
	});

	it('returns null for a null-byte injection', () => {
		expect(resolveSafePath(root, '/style.css%00.txt')).toBeNull();
	});

	it('returns null for a percent-encoded double-dot traversal', () => {
		expect(resolveSafePath(root, '/..%2f..%2fetc%2fpasswd')).toBeNull();
	});

	it('returns null for a root-only request that resolves outside root', () => {
		expect(resolveSafePath('/var/www/assets', '/../../etc/passwd')).toBeNull();
	});

	it('accepts a deeply nested legitimate path', () => {
		const result = resolveSafePath(root, '/a/b/c/d/file.txt');
		expect(result).toBe(resolve('/var/www/assets/a/b/c/d/file.txt'));
	});
});
