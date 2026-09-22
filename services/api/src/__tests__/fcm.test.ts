/**
 * The push transport behind proactive reminders and follow-ups.
 *
 * `devices.push_token` existed, the admin console reported `hasPushToken`, and
 * nothing ever wrote a token or sent a message — so every nudge the assistant
 * decided to make stayed a row in a table. These tests pin the sender's real
 * behaviour: what it does with no credential, with a live FCM, and with a token
 * FCM says is dead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

import { sendPush, fcmConfigured, resetFcmCache } from '../services/fcm.js';

const ENV_KEY = 'FIREBASE_SERVICE_ACCOUNT_JSON';

function serviceAccountJson(): string {
	const { privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		publicKeyEncoding: { type: 'spki', format: 'pem' },
	});
	return JSON.stringify({
		project_id: 'nova-test-project',
		client_email: 'pusher@nova-test-project.iam.gserviceaccount.com',
		private_key: privateKey,
	});
}

/** Routes the OAuth token call and the FCM send call to scripted responses. */
function stubFetch(sendResponses: Array<{ status: number; body: string }>) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	let sendIndex = 0;
	const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const href = String(url);
		calls.push({ url: href, init });
		if (href.startsWith('https://oauth2.googleapis.com')) {
			return new Response(JSON.stringify({ access_token: 'test-access-token', expires_in: 3600 }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		const scripted = sendResponses[sendIndex++] ?? { status: 200, body: '{}' };
		return new Response(scripted.body, { status: scripted.status });
	});
	vi.stubGlobal('fetch', fetchMock);
	return calls;
}

describe('fcm sender', () => {
	const original = process.env[ENV_KEY];

	beforeEach(() => resetFcmCache());
	afterEach(() => {
		vi.unstubAllGlobals();
		resetFcmCache();
		if (original === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = original;
	});

	it('reports itself unconfigured instead of pretending to send', async () => {
		delete process.env[ENV_KEY];
		resetFcmCache();
		const calls = stubFetch([]);

		expect(fcmConfigured()).toBe(false);
		const result = await sendPush(['token-a'], { title: 'Hi' });

		expect(result.configured).toBe(false);
		expect(result.sent).toBe(0);
		expect(result.failed).toBe(1);
		expect(result.errors.join(' ')).toContain('not configured');
		// Nothing was asked of FCM, because there is no credential to ask with.
		expect(calls).toHaveLength(0);
	});

	it('sends one message per device and counts the successes', async () => {
		process.env[ENV_KEY] = serviceAccountJson();
		resetFcmCache();
		const calls = stubFetch([
			{ status: 200, body: '{"name":"projects/x/messages/1"}' },
			{ status: 200, body: '{"name":"projects/x/messages/2"}' },
		]);

		const result = await sendPush(['token-a', 'token-b'], {
			title: 'Call Arun',
			body: 'You have a reminder.',
			data: { notificationId: 'n-1' },
		});

		expect(result.configured).toBe(true);
		expect(result.sent).toBe(2);
		expect(result.failed).toBe(0);

		const sends = calls.filter((c) => c.url.includes('fcm.googleapis.com'));
		expect(sends).toHaveLength(2);
		expect(sends[0]!.url).toContain('/v1/projects/nova-test-project/messages:send');

		// The authorization header carries a minted bearer token, not the key.
		const headers = sends[0]!.init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer test-access-token');

		const body = JSON.parse(String(sends[0]!.init?.body));
		expect(body.message.token).toBe('token-a');
		expect(body.message.notification.title).toBe('Call Arun');
		expect(body.message.data.notificationId).toBe('n-1');
		// The channel must exist on the device or Android drops the notification.
		// `_v2` is the sounding one; the original was created silent and Android
		// never updates an existing channel's sound.
		expect(body.message.android.notification.channel_id).toBe('nova_reminders_v2');
	});

	it('de-duplicates tokens so one device is not messaged twice', async () => {
		process.env[ENV_KEY] = serviceAccountJson();
		resetFcmCache();
		const calls = stubFetch([{ status: 200, body: '{}' }]);

		const result = await sendPush(['same', 'same', '  '], { title: 'Once' });

		expect(result.sent).toBe(1);
		expect(calls.filter((c) => c.url.includes('fcm.googleapis.com'))).toHaveLength(1);
	});

	it('hands back a token FCM says is unregistered, so it can be dropped', async () => {
		process.env[ENV_KEY] = serviceAccountJson();
		resetFcmCache();
		stubFetch([
			{ status: 404, body: '{"error":{"status":"NOT_FOUND","message":"Requested entity was not found."}}' },
			{ status: 200, body: '{}' },
		]);

		const result = await sendPush(['dead-token', 'good-token'], { title: 'Hi' });

		expect(result.sent).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.invalidTokens).toEqual(['dead-token']);
	});

	it('surfaces a rejected send rather than counting it as delivered', async () => {
		process.env[ENV_KEY] = serviceAccountJson();
		resetFcmCache();
		stubFetch([{ status: 403, body: '{"error":{"status":"PERMISSION_DENIED"}}' }]);

		const result = await sendPush(['token-a'], { title: 'Hi' });

		expect(result.sent).toBe(0);
		expect(result.failed).toBe(1);
		expect(result.errors.join(' ')).toContain('403');
		// A permission problem is not an unregistered token: the token stays.
		expect(result.invalidTokens).toHaveLength(0);
	});

	it('reuses one access token across sends', async () => {
		process.env[ENV_KEY] = serviceAccountJson();
		resetFcmCache();
		const calls = stubFetch([
			{ status: 200, body: '{}' },
			{ status: 200, body: '{}' },
			{ status: 200, body: '{}' },
		]);

		await sendPush(['a'], { title: 'One' });
		await sendPush(['b'], { title: 'Two' });

		expect(calls.filter((c) => c.url.startsWith('https://oauth2.googleapis.com'))).toHaveLength(1);
	});
});
