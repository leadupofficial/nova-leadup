/**
 * NOVA — Active realtime session registry.
 *
 * Tracks which voice WebSocket sessions this process currently holds, so the admin
 * console can answer "is anyone connected right now" with a real number instead of
 * a placeholder.
 *
 * **Scope is deliberately local.** A connection lives in the memory of the replica
 * that accepted it; an API process cannot enumerate sockets owned by a sibling
 * process. `snapshot()` therefore reports `local` counts and says so, rather than
 * presenting a single replica's view as the platform total. Making the count global
 * needs a shared registry (Redis), which is not wired up — see the admin realtime
 * route, which states the same limitation to the operator.
 *
 * The registry is also what the `CONTROL_REALTIME_ENABLED` kill switch consults to
 * decide whether to accept a new upgrade.
 */

export type RealtimeSessionInfo = {
	id: string;
	userId: string;
	email: string;
	role: string;
	connectedAt: number;
	/** Set once the client sends its first `start` frame. */
	lastActivityAt: number;
	state: 'connected' | 'starting' | 'listening' | 'speaking' | 'closing';
};

const sessions = new Map<string, RealtimeSessionInfo>();
const byUser = new Map<string, Set<string>>();

let sequence = 0;

export function registerRealtimeSession(input: {
	userId: string;
	email: string;
	role: string;
}): string {
	sequence += 1;
	const id = `rt_${Date.now().toString(36)}_${sequence.toString(36)}`;
	const now = Date.now();

	sessions.set(id, {
		id,
		userId: input.userId,
		email: input.email,
		role: input.role,
		connectedAt: now,
		lastActivityAt: now,
		state: 'connected',
	});

	let userSessions = byUser.get(input.userId);
	if (!userSessions) {
		userSessions = new Set();
		byUser.set(input.userId, userSessions);
	}
	userSessions.add(id);

	return id;
}

export function updateRealtimeSession(
	id: string,
	patch: Partial<Pick<RealtimeSessionInfo, 'state' | 'lastActivityAt'>>,
): void {
	const session = sessions.get(id);
	if (!session) return;
	if (patch.state) session.state = patch.state;
	session.lastActivityAt = patch.lastActivityAt ?? Date.now();
}

export function unregisterRealtimeSession(id: string): void {
	const session = sessions.get(id);
	if (!session) return;
	sessions.delete(id);

	const userSessions = byUser.get(session.userId);
	if (userSessions) {
		userSessions.delete(id);
		if (userSessions.size === 0) byUser.delete(session.userId);
	}
}

/** How many sessions this process is holding. */
export function getActiveRealtimeSessionCount(): number {
	return sessions.size;
}

/** How many distinct users this process is holding a session for. */
export function getActiveRealtimeUserCount(): number {
	return byUser.size;
}

export type RealtimeSnapshot = {
	localSessions: number;
	localUsers: number;
	sessions: RealtimeSessionInfo[];
	scope: 'this process only';
	generatedAt: string;
};

export function snapshotRealtimeSessions(): RealtimeSnapshot {
	return {
		localSessions: sessions.size,
		localUsers: byUser.size,
		sessions: [...sessions.values()].sort((a, b) => b.connectedAt - a.connectedAt),
		scope: 'this process only',
		generatedAt: new Date().toISOString(),
	};
}

/** Sessions held for one user — used by the user detail screen. */
export function realtimeSessionsForUser(userId: string): RealtimeSessionInfo[] {
	const ids = byUser.get(userId);
	if (!ids) return [];
	return [...ids].map((id) => sessions.get(id)).filter((s): s is RealtimeSessionInfo => s !== undefined);
}

/**
 * Closes every session for a user.
 *
 * Exposed so a suspension can drop live sockets immediately rather than waiting for
 * the client to notice its token is dead. The `close` callback is supplied by the
 * caller because the registry holds no socket references — keeping it free of `ws`
 * types means this module can be imported by the admin routes without pulling the
 * WebSocket server into that path.
 */
export function closeRealtimeSessionsForUser(
	userId: string,
	close: (sessionId: string) => void,
): number {
	const ids = byUser.get(userId);
	if (!ids) return 0;
	const list = [...ids];
	for (const id of list) {
		close(id);
		unregisterRealtimeSession(id);
	}
	return list.length;
}

/** Test-only: clears the registry. */
export function __resetRealtimeRegistry(): void {
	sessions.clear();
	byUser.clear();
}
