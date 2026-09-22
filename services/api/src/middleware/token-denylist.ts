/**
 * NOVA — a token denylist that is shared between processes.
 *
 * ## What was wrong
 *
 * This was an in-process `Map`. A revocation was therefore immediate **on the replica that performed
 * it and invisible to every other replica**, so "force logout" ended a session on one instance while
 * the token kept working on the rest until it expired — up to fifteen minutes. The module's own comment
 * said to replace it with Redis for distributed deployments. Redis is not running in this deployment
 * and adding it for one table would be a larger operational decision than the problem needs, because
 * Postgres is already the shared, durable store and already on every request path.
 *
 * ## Why a polled cache rather than a query per request
 *
 * `isRevoked` is called from `authenticate` — the hot path of every authenticated request — so it has
 * to stay in memory. The compromise is explicit and bounded:
 *
 *  * revocations are written to `revoked_tokens` **and** to the local set, so the replica that
 *    performed the revocation is immediate (unchanged behaviour, no regression);
 *  * every `POLL_INTERVAL_MS` each replica pulls only the revocations newer than its watermark;
 *  * the window during which another replica may still accept a just-revoked token is therefore
 *    **bounded by the poll interval** rather than by the token's lifetime.
 *
 * Five seconds is the default: short enough that "force logout" is effectively immediate from an
 * operator's point of view, long enough that the poll is one indexed query on a table that stays tiny
 * (rows are deleted when the token they describe would have expired anyway).
 *
 * ## What it does not fix
 *
 * A replica that cannot reach the database sees no other replica's revocations at all; it keeps
 * serving its own set. That is stated rather than hidden — the poll failure is logged and exposed
 * through `pollFailure`, and the console's copy says the guarantee is "within one poll interval, when
 * the database is reachable".
 */

import { getDbPool } from '../db/connection.js';
import { logger } from '../utils/logger.js';

interface DenylistEntry {
	sub: string;
	expiresAt: number;
}

/** How often each replica pulls revocations it has not seen. Also the staleness bound. */
export const POLL_INTERVAL_MS = 5_000;

/** Local sweep of naturally-expired entries. Independent of the database. */
const LOCAL_CLEANUP_MS = 60_000;

/**
 * A revocation older than this is ignored on the first poll: the token it describes has expired, so
 * there is nothing to enforce. Bounds the first read on a long-lived table.
 */
const MAX_AGE_MS = 20 * 60 * 1000;

export class TokenDenylist {
	private readonly store = new Map<string, DenylistEntry>();
	/**
	 * Watermark: the newest `revoked_at` this replica has already pulled, in epoch seconds — the
	 * column's own unit, so the comparison cannot be confused by clock precision.
	 */
	private watermark = 0;
	private pollTimer: NodeJS.Timeout | null = null;
	private cleanupTimer: NodeJS.Timeout | null = null;
	private started = false;
	private pollInFlight = false;
	private lastPollError: string | null = null;

	constructor(private readonly options: { pollIntervalMs?: number; poll?: boolean } = {}) {}

	/**
	 * Begins polling and starts the local sweep.
	 *
	 * Not done in the constructor: `authenticate` imports this module, and a unit test that imports the
	 * auth middleware must not open a timer or touch a database.
	 */
	start(): void {
		if (this.started) return;
		this.started = true;

		if (this.options.poll !== false) {
			this.pollTimer = setInterval(() => {
				void this.poll();
			}, this.options.pollIntervalMs ?? POLL_INTERVAL_MS);
			this.pollTimer.unref?.();
			// The first poll runs on the next tick rather than synchronously, so boot is not blocked on
			// the database and a database that is slow to come up does not delay startup.
			void this.poll();
		}

		this.cleanupTimer = setInterval(() => this.sweepLocal(), LOCAL_CLEANUP_MS);
		this.cleanupTimer.unref?.();
	}

	/**
	 * Revokes a token locally, immediately, and records it for the other replicas.
	 *
	 * The local write happens first and unconditionally: if the database write fails, this replica still
	 * enforces the revocation and the failure is logged. The reverse order would mean a revocation that
	 * could not be recorded was also not applied — the worst of both.
	 */
	revoke(jti: string, sub: string, expiresAt: number): void {
		if (!jti || !sub) return;
		this.store.set(jti, { sub, expiresAt });
		void this.persist(jti, sub, expiresAt);
	}

	/**
	 * Checks whether a token is revoked, and belongs to the expected user.
	 *
	 * Synchronous and in-memory by design. Cross-replica staleness is the poll interval, which the
	 * console states wherever it describes the guarantee.
	 */
	isRevoked(jti: string | undefined, sub: string | undefined): boolean {
		if (!jti || !sub) return false;
		const entry = this.store.get(jti);
		if (!entry) return false;
		if (entry.sub !== sub) {
			// Cross-user jti lookup — reject as revoked to prevent token confusion.
			return true;
		}
		if (Date.now() > entry.expiresAt) {
			this.store.delete(jti);
			return false;
		}
		return true;
	}

	/** Removes every local entry for a subject. The durable row is left to expire on its own. */
	revokeAllForSubject(sub: string): void {
		if (!sub) return;
		for (const [jti, entry] of this.store.entries()) {
			if (entry.sub === sub) this.store.delete(jti);
		}
	}

	/** Entries currently held. For tests and for the health surface. */
	get size(): number {
		return this.store.size;
	}

	/** The newest `revoked_at` pulled from the shared table, as an ISO string. */
	get watermarkIso(): string | null {
		return this.watermark > 0 ? new Date(this.watermark * 1000).toISOString() : null;
	}

	get pollFailure(): string | null {
		return this.lastPollError;
	}

	private async persist(jti: string, sub: string, expiresAt: number): Promise<void> {
		try {
			await getDbPool().query(
				`INSERT INTO revoked_tokens (jti, sub, expires_at)
				 VALUES ($1, $2, to_timestamp($3 / 1000.0))
				 ON CONFLICT (jti) DO NOTHING`,
				[jti, sub, expiresAt],
			);
		} catch (error) {
			// Stated, not swallowed: without this line a revocation only one replica knows about looks
			// identical to one that is shared.
			logger.error(
				{ err: error, jti },
				'[token-denylist] could not persist a revocation — it is enforced on this replica only',
			);
		}
	}

	/**
	 * Pulls revocations newer than the watermark.
	 *
	 * The next watermark is taken from the rows just read rather than from the wall clock, so a
	 * revocation written while this query was running is picked up by the next poll instead of being
	 * skipped by a timestamp that had already passed it.
	 */
	async poll(): Promise<number> {
		if (this.pollInFlight) return 0;
		this.pollInFlight = true;
		try {
			const { rows } = await getDbPool().query<{
				jti: string;
				sub: string;
				expires_at: Date;
				epoch: string;
			}>(
				`SELECT jti, sub, expires_at, extract(epoch FROM revoked_at)::text AS epoch
				 FROM revoked_tokens
				 WHERE revoked_at > to_timestamp($1)
				   AND expires_at > now() - ($2 || ' milliseconds')::interval
				 ORDER BY revoked_at ASC
				 LIMIT 1000`,
				[this.watermark, String(MAX_AGE_MS)],
			);

			for (const row of rows) {
				const expiresAt = new Date(row.expires_at).getTime();
				// A row whose token has already expired is not worth remembering: the token cannot be
				// presented anyway, and holding it would grow the local set for no benefit.
				if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
					this.store.set(row.jti, { sub: row.sub, expiresAt });
				}
				const epoch = Number.parseFloat(row.epoch);
				if (Number.isFinite(epoch) && epoch > this.watermark) this.watermark = epoch;
			}

			// Nothing to pull is the common case and it clears a previous failure: a transient outage
			// that recovered should stop being reported.
			this.lastPollError = null;
			return rows.length;
		} catch (error) {
			this.lastPollError = error instanceof Error ? error.message : String(error);
			logger.warn(
				{ err: error },
				'[token-denylist] could not poll for revocations — this replica may accept another replica\'s revoked token',
			);
			return 0;
		} finally {
			this.pollInFlight = false;
		}
	}

	/** Deletes rows whose token expired long enough ago that nothing can present them. */
	async reap(): Promise<number> {
		try {
			const { rowCount } = await getDbPool().query(
				`DELETE FROM revoked_tokens WHERE expires_at < now() - interval '1 hour'`,
			);
			return rowCount ?? 0;
		} catch {
			return 0;
		}
	}

	private sweepLocal(): void {
		const now = Date.now();
		for (const [jti, entry] of this.store.entries()) {
			if (now > entry.expiresAt) this.store.delete(jti);
		}
	}

	destroy(): void {
		if (this.pollTimer) clearInterval(this.pollTimer);
		if (this.cleanupTimer) clearInterval(this.cleanupTimer);
		this.pollTimer = null;
		this.cleanupTimer = null;
		this.started = false;
		this.store.clear();
		this.watermark = 0;
	}
}

/**
 * The process-wide denylist.
 *
 * `start()` is called once by `server.ts` rather than on import, for the reason given there.
 */
export const tokenDenylist = new TokenDenylist();

export type { DenylistEntry };
