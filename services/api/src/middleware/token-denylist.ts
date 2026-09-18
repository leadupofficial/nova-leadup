/**
 * In-memory token denylist for logout revocation.
 *
 * Security: When a user logs out, their access token is added to this denylist
 * so it cannot be reused even before its natural expiration. Tokens are stored
 * as JTI (JWT ID) claims with their expiration time and owning user ID, and
 * auto-expired when the token's TTL elapses.
 *
 * Entries are scoped to a user (`sub`) so that:
 *   - isRevoked checks reject cross-user token confusion
 *   - revokeAllForSubject only invalidates tokens for one user
 *
 * For distributed deployments, replace with Redis (SET with EXPIRE).
 */

interface DenylistEntry {
	sub: string;          // user ID — required for ownership validation
	expiresAt: number;    // Unix ms — when the token naturally expires
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
	 * @param jti  JWT ID — must not be empty
	 * @param sub  user ID the token belongs to — required for ownership scoping
	 * @param expiresAt  Unix ms when the token naturally expires
	 */
	revoke(jti: string, sub: string, expiresAt: number): void {
		if (!jti || !sub) return;
		this.store.set(jti, { sub, expiresAt });
	}

	/**
	 * Check whether a token's jti has been revoked **and** belongs to the
	 * expected user. Returns true only if the jti is in the store, not yet
	 * expired, and was issued to the supplied `sub`.
	 */
	isRevoked(jti: string | undefined, sub: string | undefined): boolean {
		if (!jti || !sub) return false;
		const entry = this.store.get(jti);
		if (!entry) return false;
		if (entry.sub !== sub) {
			// Cross-user jti lookup — reject as revoked to prevent token confusion
			return true;
		}
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
		if (!sub) return;
		for (const [jti, entry] of this.store.entries()) {
			if (entry.sub === sub) {
				this.store.delete(jti);
			}
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
 */
export const tokenDenylist = new TokenDenylist();

export { TokenDenylist };
export type { DenylistEntry };
