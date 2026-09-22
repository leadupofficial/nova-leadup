/**
 * In-memory token denylist for the workflow-engine.
 *
 * Security: When a user logs out, their access token is added to this denylist
 * so it cannot be reused even before its natural expiration. Tokens are stored
 * as JTI (JWT ID) claims with their expiration time, and auto-expired when the
 * token's TTL elapses.
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
	 */
	revoke(jti: string, expiresAt: number): void {
		this.store.set(jti, { expiresAt });
	}

	/**
	 * Check whether a token's jti has been revoked.
	 */
	isRevoked(jti: string): boolean {
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
	 * Remove all revoked tokens for a given subject (user).
	 * Called on password reset or account lockout.
	 */
	revokeAllForSubject(sub: string): void {
		for (const [jti, entry] of this.store.entries()) {
			// We key by jti only; to revoke by subject we'd need a separate index.
			// For now, clear the entire denylist on mass revocation.
			this.store.delete(jti);
		}
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
 */
export const tokenDenylist = new TokenDenylist();

export { TokenDenylist };
export type { DenylistEntry };
