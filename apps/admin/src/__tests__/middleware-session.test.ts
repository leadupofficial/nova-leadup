/**
 * The edge gate must not defeat silent refresh.
 *
 * `sessionCanBeRecovered` deliberately ignores `exp`. It did not: access tokens live 15
 * minutes, so after 15 minutes idle the gate rejected the cookie, redirected to `/login`
 * and *deleted* it — and since `/login` is public the client guard never ran, so the
 * 7-day refresh token in localStorage was never used and the operator had to sign in
 * again. An adversarial pass caught it in a browser, not here, because a cookie's
 * usefulness is not something `curl` reports.
 *
 * **These are source-level assertions, not behavioural ones, and that is a real
 * limitation.** `middleware.ts` targets the Edge runtime, so it cannot be imported into a
 * node vitest process; driving it properly would need a browser, which is how the bug was
 * actually found. What they can do is fail loudly if `exp` reappears inside the gate, if
 * the role check is dropped, or if a route is added to `PUBLIC_ROUTES` — the three edits
 * that would reintroduce this class of problem. Treat a pass here as "the shape is still
 * right", not as "the behaviour is verified"; the behavioural check lives in
 * `docs/REQUIREMENTS_VERIFICATION.md`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(resolve(__dirname, '../middleware.ts'), 'utf8');

describe('the edge session gate', () => {
	it('does not treat expiry as a reason to reject the cookie', () => {
		// The whole bug in one assertion: no `exp` comparison inside the gate.
		const gate = SOURCE.slice(
			SOURCE.indexOf('function sessionCanBeRecovered'),
			SOURCE.indexOf('function redirectToLogin'),
		);
		expect(gate).not.toMatch(/exp\s*\*\s*1000/);
		expect(gate).not.toMatch(/Date\.now\(\)/);
		expect(gate).toContain('ALLOWED_ROLES.has');
	});

	it('still requires a decodable token and an admin role', () => {
		const gate = SOURCE.slice(
			SOURCE.indexOf('function sessionCanBeRecovered'),
			SOURCE.indexOf('function redirectToLogin'),
		);
		expect(gate).toContain('if (!claims) return false');
		expect(gate).toContain("typeof claims.role === 'string'");
	});

	it('keeps exactly the four public routes public', () => {
		const match = SOURCE.match(/const PUBLIC_ROUTES = \[([^\]]*)\]/);
		expect(match).not.toBeNull();
		const routes = match![1]
			.split(',')
			.map((entry) => entry.trim().replace(/^'|'$/g, ''))
			.filter(Boolean);
		expect(routes.sort()).toEqual(['/delete-account', '/login', '/privacy', '/support']);
	});

	it('still lets a signed-in visitor read the public pages', () => {
		// The condition that used to bounce them to the dashboard.
		expect(SOURCE).toContain("if (usable && pathname === '/login')");
	});
});
