/**
 * NOVA API — Firebase Cloud Messaging sender.
 *
 * This is the transport the proactive half of the product was missing. The
 * `devices.push_token` column has always existed and the admin console even
 * reports `hasPushToken`, but nothing ever wrote a token and nothing ever sent a
 * message, so a reminder or a follow-up could only ever be a row in a table.
 *
 * Talks to the FCM HTTP v1 API directly: it mints an OAuth token from the
 * service-account JSON with `jsonwebtoken` (already a dependency) and uses the
 * global `fetch`, so no `firebase-admin` is needed.
 *
 * Every outcome is reported. A send that did not happen is never reported as one
 * that did: an unconfigured project returns `configured: false`, an unreachable
 * FCM returns the provider's own error text, and a token FCM rejects as
 * unregistered is handed back so the caller can stop using it.
 */
import jwt from 'jsonwebtoken';

import { logger } from '../utils/logger.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

interface ServiceAccount {
	project_id: string;
	client_email: string;
	private_key: string;
}

let cachedAccount: ServiceAccount | null | undefined;
let cachedToken: { value: string; expiresAt: number } | null = null;
let inflightToken: Promise<string | null> | null = null;

/** The service account, or null when it is absent or malformed. Parsed once. */
function serviceAccount(): ServiceAccount | null {
	if (cachedAccount !== undefined) return cachedAccount;

	const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
	if (!raw || raw.trim().length === 0) {
		cachedAccount = null;
		return null;
	}
	try {
		// Deployments sometimes carry the JSON base64-encoded to survive shell quoting.
		const text = raw.trim().startsWith('{')
			? raw
			: Buffer.from(raw, 'base64').toString('utf8');
		const parsed = JSON.parse(text) as Partial<ServiceAccount>;
		if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
			logger.warn('[fcm] service account is missing project_id, client_email or private_key');
			cachedAccount = null;
			return null;
		}
		cachedAccount = {
			project_id: parsed.project_id,
			client_email: parsed.client_email,
			private_key: parsed.private_key,
		};
		return cachedAccount;
	} catch (error) {
		logger.warn({ err: error }, '[fcm] FIREBASE_SERVICE_ACCOUNT_JSON is not usable JSON');
		cachedAccount = null;
		return null;
	}
}

export function fcmConfigured(): boolean {
	return serviceAccount() !== null;
}

/** A cached OAuth access token, refreshed shortly before it expires. */
async function accessToken(): Promise<string | null> {
	const account = serviceAccount();
	if (!account) return null;

	const now = Math.floor(Date.now() / 1000);
	if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.value;
	if (inflightToken) return inflightToken;

	inflightToken = (async () => {
		try {
			const assertion = jwt.sign(
				{
					iss: account.client_email,
					scope: SCOPE,
					aud: TOKEN_ENDPOINT,
					iat: now,
					exp: now + 3600,
				},
				account.private_key,
				{ algorithm: 'RS256' },
			);

			const response = await fetch(TOKEN_ENDPOINT, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
					assertion,
				}),
			});
			if (!response.ok) {
				logger.error(
					{ status: response.status, body: await response.text().catch(() => '') },
					'[fcm] could not mint an access token',
				);
				return null;
			}
			const payload = (await response.json()) as { access_token?: string; expires_in?: number };
			if (!payload.access_token) return null;
			cachedToken = {
				value: payload.access_token,
				expiresAt: now + (payload.expires_in ?? 3600),
			};
			return cachedToken.value;
		} catch (error) {
			logger.error({ err: error }, '[fcm] access token request failed');
			return null;
		} finally {
			inflightToken = null;
		}
	})();

	return inflightToken;
}

export interface PushMessage {
	title: string;
	body?: string | null;
	/** FCM data values must be strings. */
	data?: Record<string, string>;
	/** Android notification channel; defaults to the reminders channel. */
	channelId?: string;
}

export interface PushResult {
	/** False when no service account is configured — nothing was attempted. */
	configured: boolean;
	sent: number;
	failed: number;
	/** Tokens FCM reported as no longer registered, so the caller can clear them. */
	invalidTokens: string[];
	errors: string[];
}

/**
 * Sends [message] to every token, individually.
 *
 * One token per request rather than a multicast: the HTTP v1 API has no batch
 * send, and doing it this way means one dead token cannot fail the whole user's
 * delivery, and FCM's per-token error identifies exactly which token to drop.
 */
export async function sendPush(tokens: string[], message: PushMessage): Promise<PushResult> {
	const result: PushResult = {
		configured: false,
		sent: 0,
		failed: 0,
		invalidTokens: [],
		errors: [],
	};

	const unique = [...new Set(tokens.filter((token) => token && token.trim().length > 0))];
	if (unique.length === 0) return result;

	const account = serviceAccount();
	const token = await accessToken();
	if (!account || !token) {
		result.failed = unique.length;
		result.errors.push('Firebase push is not configured on this server.');
		return result;
	}
	result.configured = true;

	const url = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;

	for (const deviceToken of unique) {
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: {
						token: deviceToken,
						notification: { title: message.title, body: message.body ?? undefined },
						data: message.data ?? undefined,
						android: {
							priority: 'high',
							notification: {
								channel_id: message.channelId ?? 'nova_reminders',
							},
						},
					},
				}),
			});

			if (response.ok) {
				result.sent += 1;
				continue;
			}

			const text = await response.text().catch(() => '');
			result.failed += 1;
			result.errors.push(`${response.status}: ${text.slice(0, 300)}`);
			// 404 NOT_FOUND / 400 with UNREGISTERED means the app was uninstalled or the
			// token was rotated: the token is dead and must not be retried forever.
			if (response.status === 404 || text.includes('UNREGISTERED') || text.includes('INVALID_ARGUMENT')) {
				result.invalidTokens.push(deviceToken);
			}
			logger.warn({ status: response.status, body: text.slice(0, 300) }, '[fcm] send rejected');
		} catch (error) {
			result.failed += 1;
			result.errors.push(error instanceof Error ? error.message : String(error));
			logger.warn({ err: error }, '[fcm] send failed');
		}
	}

	return result;
}

/** Test seam: forget the parsed account and any cached token. */
export function resetFcmCache(): void {
	cachedAccount = undefined;
	cachedToken = null;
	inflightToken = null;
}
