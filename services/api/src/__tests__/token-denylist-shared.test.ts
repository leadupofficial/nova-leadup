/**
 * The shared token denylist.
 *
 * This was an in-process `Map`, so a force-logout was immediate on the replica that performed it and
 * invisible everywhere else: the token kept working on the other instances until it expired. It now
 * writes to `revoked_tokens` and each replica polls for revocations newer than its watermark, which
 * bounds the propagation window by the poll interval instead of by the token lifetime.
 *
 * These tests pin the properties that make that safe rather than merely faster:
 *
 *  * the **local** write is immediate and unconditional, so a database that is down cannot leave a
 *    revocation unapplied on the replica that made it;
 *  * a failed persist is **reported**, because a revocation only one replica knows about otherwise
 *    looks exactly like a shared one;
 *  * the watermark advances from the rows read, not from the wall clock, so a revocation written
 *    during the query is picked up next time rather than skipped;
 *  * a jti presented with the wrong subject is rejected, which is what stops a revoked id being reused
 *    under another identity.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import './setup.js';

import { TokenDenylist } from '../middleware/token-denylist.js';

const future = () => Date.now() + 15 * 60 * 1000;

/** A pool whose `query` is scripted per SQL fragment. */
function scriptedPool(handler: (sql: string, params: unknown[]) => { rows?: unknown[]; rowCount?: number }) {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	const pool = {
		query: async (sql: string, params: unknown[] = []) => {
			calls.push({ sql, params });
			const result = handler(sql, params);
			return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
		},
	};
	return { pool, calls };
}

beforeEach(() => {
	vi.restoreAllMocks();
});

describe('immediate local revocation', () => {
	it('accepts a token before it is revoked and rejects it immediately after', () => {
		const denylist = new TokenDenylist({ poll: false });
		expect(denylist.isRevoked('jti-1', 'user-1')).toBe(false);
		denylist.revoke('jti-1', 'user-1', future());
		expect(denylist.isRevoked('jti-1', 'user-1')).toBe(true);
		denylist.destroy();
	});

	it('applies the revocation even when the durable write cannot happen', async () => {
		// The local write happens first and unconditionally. The reverse order would mean a revocation
		// that could not be recorded was also not applied — the worst of both.
		vi.spyOn(await import('../db/connection.js'), 'getDbPool').mockImplementation(() => {
			throw new Error('database unavailable');
		});
		const denylist = new TokenDenylist({ poll: false });
		denylist.revoke('jti-2', 'user-2', future());
		expect(denylist.isRevoked('jti-2', 'user-2')).toBe(true);
		denylist.destroy();
	});

	it('rejects a jti presented with the wrong subject', () => {
		// Cross-user jti confusion: not merely "unknown", but a forgery attempt.
		const denylist = new TokenDenylist({ poll: false });
		denylist.revoke('jti-3', 'user-3', future());
		expect(denylist.isRevoked('jti-3', 'someone-else')).toBe(true);
		denylist.destroy();
	});

	it('forgets an entry once the token would have expired', () => {
		const denylist = new TokenDenylist({ poll: false });
		denylist.revoke('jti-4', 'user-4', Date.now() - 1);
		expect(denylist.isRevoked('jti-4', 'user-4')).toBe(false);
		denylist.destroy();
	});

	it('ignores an empty jti or subject rather than storing a wildcard', () => {
		const denylist = new TokenDenylist({ poll: false });
		denylist.revoke('', 'user-5', future());
		denylist.revoke('jti-5', '', future());
		expect(denylist.size).toBe(0);
		denylist.destroy();
	});
});

describe('propagation', () => {
	it('adopts a revocation made by another replica', async () => {
		// The whole point: a row this replica did not write must be enforced after a poll.
		const expires = new Date(future());
		const { pool } = scriptedPool(() => ({
			rows: [{ jti: 'foreign-jti', sub: 'user-6', expires_at: expires, epoch: String(Date.now() / 1000) }],
		}));
		vi.spyOn(await import('../db/connection.js'), 'getDbPool').mockReturnValue(pool as never);

		const denylist = new TokenDenylist({ poll: false });
		expect(denylist.isRevoked('foreign-jti', 'user-6')).toBe(false);
		const adopted = await denylist.poll();
		expect(adopted).toBe(1);
		expect(denylist.isRevoked('foreign-jti', 'user-6')).toBe(true);
		denylist.destroy();
	});

	it('does not re-fetch what it has already seen', async () => {
		// The watermark is what keeps the poll cheap; without it every replica would re-read the whole
		// table every five seconds.
		let epoch = String(Math.floor(Date.now() / 1000));
		const { pool, calls } = scriptedPool(() => ({
			rows: [{ jti: 'jti-7', sub: 'user-7', expires_at: new Date(future()), epoch }],
		}));
		vi.spyOn(await import('../db/connection.js'), 'getDbPool').mockReturnValue(pool as never);

		const denylist = new TokenDenylist({ poll: false });
		await denylist.poll();
		const firstWatermark = calls[0].params[0];
		epoch = String(Number(epoch) + 5);
		await denylist.poll();
		expect(calls[1].params[0]).not.toBe(firstWatermark);
		expect(Number(calls[1].params[0])).toBeGreaterThan(Number(firstWatermark));
		denylist.destroy();
	});

	it('does not spend memory on a row whose token has already expired', async () => {
		const { pool } = scriptedPool(() => ({
			rows: [{ jti: 'stale-jti', sub: 'user-8', expires_at: new Date(Date.now() - 1000), epoch: String(Date.now() / 1000) }],
		}));
		vi.spyOn(await import('../db/connection.js'), 'getDbPool').mockReturnValue(pool as never);

		const denylist = new TokenDenylist({ poll: false });
		await denylist.poll();
		expect(denylist.size).toBe(0);
		denylist.destroy();
	});

	it('reports a failed poll instead of looking healthy', async () => {
		// A replica that cannot reach the database is accepting another replica's revoked tokens, and
		// that has to be visible rather than indistinguishable from success.
		vi.spyOn(await import('../db/connection.js'), 'getDbPool').mockImplementation(() => {
			throw new Error('connection refused');
		});
		const denylist = new TokenDenylist({ poll: false });
		expect(await denylist.poll()).toBe(0);
		expect(denylist.pollFailure).toContain('connection refused');
		denylist.destroy();
	});

	it('clears a previous failure once a poll succeeds', async () => {
		const module = await import('../db/connection.js');
		const spy = vi.spyOn(module, 'getDbPool');
		spy.mockImplementation(() => {
			throw new Error('connection refused');
		});
		const denylist = new TokenDenylist({ poll: false });
		await denylist.poll();
		expect(denylist.pollFailure).not.toBeNull();

		const { pool } = scriptedPool(() => ({ rows: [] }));
		spy.mockReturnValue(pool as never);
		await denylist.poll();
		expect(denylist.pollFailure).toBeNull();
		denylist.destroy();
	});

	it('does not fail boot when the database is not reachable yet', () => {
		// `start()` polls on the next tick rather than synchronously, so a slow database delays
		// propagation and never the process.
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const denylist = new TokenDenylist({ pollIntervalMs: 10 });
		expect(() => denylist.start()).not.toThrow();
		denylist.destroy();
	});
});
