import { describe, expect, it, vi } from 'vitest';
import { loadPage } from '../lib/page-data';

/**
 * `apps/admin` had **no tests at all** (`vitest run` reported "No test files found"
 * and exited 0 because `passWithNoTests` was on). These cover the logic that decides
 * whether a page shows data, an empty table, or an error — the distinction whose
 * absence was the console's most visible defect: a 401 rendered as "No users found".
 */
describe('loadPage', () => {
	it('returns rows and pagination on success', async () => {
		const result = await loadPage(async () => ({
			rows: [{ id: 'u1' }],
			totalItems: 42,
			totalPages: 3,
		}));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.rows).toEqual([{ id: 'u1' }]);
		expect(result.totalItems).toBe(42);
		expect(result.totalPages).toBe(3);
	});

	it('normalises missing pagination to null rather than inventing a count', async () => {
		const result = await loadPage(async () => ({ rows: [] }));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.totalItems).toBeNull();
		expect(result.totalPages).toBeNull();
	});

	it('turns a 401 into a session message, not an empty list', async () => {
		const error = Object.assign(new Error('Missing or invalid authorization header'), { status: 401 });
		const result = await loadPage(async () => {
			throw error;
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(401);
		expect(result.message).toMatch(/session has expired/i);
	});

	it('turns a 503 into a readiness message', async () => {
		const error = Object.assign(new Error('unavailable'), { status: 503 });
		const result = await loadPage(async () => {
			throw error;
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(503);
		expect(result.message).toMatch(/not ready/i);
	});

	it('reports an unknown status without claiming to know the cause', async () => {
		const error = Object.assign(new Error('teapot'), { status: 418 });
		const result = await loadPage(async () => {
			throw error;
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(418);
		expect(result.message).toContain('418');
	});

	it('surfaces a transport failure with no status', async () => {
		const result = await loadPage(async () => {
			throw new TypeError('fetch failed');
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBeNull();
		expect(result.message).toMatch(/could not reach the admin api/i);
	});

	it('logs the failure server-side outside production', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await loadPage(async () => {
			throw new Error('boom');
		});
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});
});
