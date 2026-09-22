/**
 * NOVA API — verifying a Firebase ID token.
 *
 * The mobile client signs a user in with Firebase Phone Authentication and receives a
 * Firebase ID token. That token is **not** a NOVA session: it proves the phone number to
 * Google, not to us. Something on this side has to check it and then mint the NOVA
 * access/refresh pair the rest of the API already understands.
 *
 * ## Why this verifies locally instead of calling Google
 *
 * An ID token is an RS256 JWT signed by Google. Verifying it needs Google's *public*
 * certificates, which are published, cacheable and identical for every project — so this
 * fetches them and verifies the signature here rather than making a network round trip
 * per sign-in, and without needing `firebase-admin` (which would want the service-account
 * private key on the auth hot path, where it has no business being).
 *
 * Every check below is load-bearing, and each one is a real attack if omitted:
 *
 *   * **signature** — the token was signed by the key it names, by a key Google publishes;
 *   * **`aud` = our project id** — the token was minted for *this* Firebase project, not a
 *     different one the attacker controls;
 *   * **`iss` = our project's issuer** — same reasoning from the other side;
 *   * **`exp` / `iat`** — the token is current, not one replayed from an old capture;
 *   * **`sub` non-empty** — there is a user behind it;
 *   * **`firebase.sign_in_provider`** — the token came from a real sign-in, so a custom
 *     token or an anonymous session cannot be passed off as a verified phone number.
 *
 * The key id (`kid`) in the token header selects the certificate; unknown ids are refused
 * rather than tried against every key.
 */
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger.js';

const FIREBASE_CERTS_URL =
	'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

/** How long to keep the certificates when Google sends no usable `max-age`. */
const DEFAULT_CERT_TTL_MS = 60 * 60 * 1000;

/** Refuse to serve a stale key set for longer than this, whatever the header asks. */
const MAX_CERT_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedCerts {
	certs: Record<string, string>;
	expiresAt: number;
}

let cache: CachedCerts | null = null;
let inFlight: Promise<Record<string, string>> | null = null;

/** The Firebase project this deployment trusts. */
export function firebaseProjectId(): string | null {
	const explicit = process.env.FIREBASE_PROJECT_ID?.trim();
	if (explicit) return explicit;
	// The service account names the project, so the id is already configured for the
	// push path and does not need a second setting kept in step with it.
	const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as { project_id?: string };
		return parsed.project_id?.trim() || null;
	} catch {
		return null;
	}
}

function ttlFromCacheControl(header: string | null): number {
	const match = header ? /max-age=(\d+)/i.exec(header) : null;
	const seconds = match ? Number(match[1]) : NaN;
	if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_CERT_TTL_MS;
	return Math.min(seconds * 1000, MAX_CERT_TTL_MS);
}

/**
 * Google's current public certificates, keyed by `kid`.
 *
 * Concurrent callers share one fetch: the auth endpoint is a burst target, and a cold
 * cache under load would otherwise mean one outbound request per sign-in attempt.
 */
async function certificates(): Promise<Record<string, string>> {
	const now = Date.now();
	if (cache && cache.expiresAt > now) return cache.certs;
	if (inFlight) return inFlight;

	inFlight = (async () => {
		try {
			const response = await fetch(FIREBASE_CERTS_URL, {
				headers: { Accept: 'application/json' },
			});
			if (!response.ok) {
				throw new Error(`certificate endpoint answered ${response.status}`);
			}
			const certs = (await response.json()) as Record<string, string>;
			if (!certs || typeof certs !== 'object' || Object.keys(certs).length === 0) {
				throw new Error('certificate endpoint returned no keys');
			}
			cache = { certs, expiresAt: Date.now() + ttlFromCacheControl(response.headers.get('cache-control')) };
			return certs;
		} finally {
			inFlight = null;
		}
	})();

	return inFlight;
}

/** What a verified token tells us. Only the fields this service acts on. */
export interface VerifiedFirebaseUser {
	/** Firebase uid — stable per user per project. */
	uid: string;
	/** E.164, including the leading `+`. Null when the provider gave no number. */
	phoneNumber: string | null;
	email: string | null;
	/** `phone`, `password`, `google.com`, … as recorded by Firebase. */
	signInProvider: string | null;
	/** True when Firebase itself considers the phone verified. */
	phoneVerified: boolean;
}

/** A refusal that is safe to show the caller: which check failed, never why in detail. */
export class FirebaseTokenError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
		this.name = 'FirebaseTokenError';
	}
}

/**
 * Verifies [idToken] and returns the identity behind it.
 *
 * Throws [FirebaseTokenError] for anything that is not a currently-valid token for this
 * project. Callers translate that into a 401; the message never carries the token.
 */
export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseUser> {
	const projectId = firebaseProjectId();
	if (!projectId) {
		// Fails closed. An unverifiable token must never be accepted just because the
		// deployment forgot to say which project it trusts.
		throw new FirebaseTokenError(
			'Firebase sign-in is not configured on this server',
			'FIREBASE_NOT_CONFIGURED',
		);
	}

	const decodedHeader = jwt.decode(idToken, { complete: true });
	const kid = decodedHeader?.header?.kid;
	if (!kid) {
		throw new FirebaseTokenError('That sign-in token is not valid', 'FIREBASE_TOKEN_INVALID');
	}

	let certs: Record<string, string>;
	try {
		certs = await certificates();
	} catch (error) {
		logger.warn({ err: error }, '[firebase] could not fetch signing certificates');
		throw new FirebaseTokenError(
			'Could not reach the sign-in provider. Please try again.',
			'FIREBASE_UNAVAILABLE',
		);
	}

	const certificate = certs[kid];
	if (!certificate) {
		// A `kid` we do not know is either a token from another project or one old enough
		// that Google has rotated the key away. Neither is acceptable.
		throw new FirebaseTokenError('That sign-in token is not valid', 'FIREBASE_TOKEN_INVALID');
	}

	let claims: jwt.JwtPayload;
	try {
		claims = jwt.verify(idToken, certificate, {
			algorithms: ['RS256'],
			audience: projectId,
			issuer: `https://securetoken.google.com/${projectId}`,
		}) as jwt.JwtPayload;
	} catch (error) {
		const expired = error instanceof jwt.TokenExpiredError;
		throw new FirebaseTokenError(
			expired ? 'That sign-in has expired. Please try again.' : 'That sign-in token is not valid',
			expired ? 'FIREBASE_TOKEN_EXPIRED' : 'FIREBASE_TOKEN_INVALID',
		);
	}

	const uid = typeof claims.sub === 'string' ? claims.sub.trim() : '';
	if (!uid || !claims.sub) {
		throw new FirebaseTokenError('That sign-in token is not valid', 'FIREBASE_TOKEN_INVALID');
	}

	const firebase = (claims.firebase ?? {}) as {
		sign_in_provider?: string;
		identities?: Record<string, unknown>;
	};
	const signInProvider = firebase.sign_in_provider ?? null;

	// A token minted by a custom backend, or an anonymous session, must not be usable to
	// claim a phone number. Only a real sign-in counts, and only a phone one proves a phone.
	const phoneToken = (firebase.identities?.phone ?? null) as unknown;
	const phoneFromIdentities = Array.isArray(phoneToken) && typeof phoneToken[0] === 'string'
		? phoneToken[0]
		: null;
	const phoneNumber =
		(typeof claims.phone_number === 'string' && claims.phone_number.trim()) ||
		phoneFromIdentities ||
		null;

	return {
		uid,
		phoneNumber,
		email: typeof claims.email === 'string' ? claims.email : null,
		signInProvider,
		phoneVerified: signInProvider === 'phone' && Boolean(phoneNumber),
	};
}

/** Test seam: drops the cached certificates so a test can control the fetch. */
export function resetFirebaseCertCache(): void {
	cache = null;
	inFlight = null;
}
