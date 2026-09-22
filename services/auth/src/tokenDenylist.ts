/**
 * In-memory token denylist for JWT revocation on logout.
 *
 * Security: When a user logs out, their access token's jti (JWT ID) is added
 * to this denylist so it cannot be reused even before its natural expiration.
 * Entries auto-expire when the token's TTL elapses.
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

	revoke(jti: string | undefined, sub: string | undefined, expiresAt: number): void {
		if (!jti || !sub) return;
		this.store.set(jti, { sub, expiresAt });
	}

	isRevoked(jti: string | undefined, sub: string | undefined): boolean {
		if (!jti || !sub) return false;
		const entry = this.store.get(jti);
		if (!entry) return false;
		if (entry.sub !== sub) {
			// Cross-user jti lookup — reject as revoked to prevent token confusion
			return true;
		}
		if (Date.now() > entry.expiresAt) {
			this.store.delete(jti);
			return false;
		}
		return true;
	}

	clear(): void {
		this.store.clear();
	}

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

export const tokenDenylist = new TokenDenylist();
export { TokenDenylist };
export type { DenylistEntry };
