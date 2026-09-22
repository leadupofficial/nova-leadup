/**
 * In-memory token denylist for JWT logout revocation.
 *
 * Security: When a user logs out, their access token's jti (JWT ID) is added
 * to this denylist so it cannot be reused even before its natural expiration.
 * Tokens are auto-expired from the store when their TTL elapses.
 *
 * For distributed deployments, replace with Redis (SET with EXPIRE).
 */

interface DenylistEntry {
	expiresAt: number; // Unix ms — when the token naturally expires
}

class TokenDenylist {
	private readonly store = new Map<string, DenylistEntry>();
	private readonly cleanupIntervalMs = 60_000;
	private timer: NodeJS.Timeout | null = null;

	constructor() {
		this.startCleanup();
	}

	/**
	 * Add a token's jti to the denylist until its natural expiration.
	 * No-op if jti is empty or undefined.
	 */
	revoke(jti: string | undefined, expiresAt: number): void {
		if (!jti) return;
		this.store.set(jti, { expiresAt });
	}

	/**
	 * Check whether a token's jti has been revoked.
	 * Returns false when jti is missing or unknown.
	 */
	isRevoked(jti: string | undefined): boolean {
		if (!jti) return false;
		const entry = this.store.get(jti);
		if (!entry) return false;
		// Auto-expire if the token's natural TTL has passed
		if (Date.now() > entry.expiresAt) {
			this.store.delete(jti);
			return false;
		}
		return true;
	}

	/**
	 * Remove all entries — used for tests and mass revocation (e.g., password reset).
	 */
	clear(): void {
		this.store.clear();
	}

	/**
	 * Current denylist size (for diagnostics / tests).
	 */
	size(): number {
		return this.store.size;
	}

	private startCleanup(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			const now = Date.now();
			for (const [jti, entry] of this.store.entries()) {
				if (now > entry.expiresAt) {
					this.store.delete(jti);
				}
			}
		}, this.cleanupIntervalMs);
		// Don't keep the process alive solely for cleanup
		if (typeof this.timer.unref === 'function') this.timer.unref();
	}

	destroy(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.store.clear();
	}
}

/**
 * Singleton denylist — shared across the process.
 * Replace with a Redis-backed denylist for multi-instance deployments.
 */
export const tokenDenylist = new TokenDenylist();

export { TokenDenylist };
export type { DenylistEntry };
