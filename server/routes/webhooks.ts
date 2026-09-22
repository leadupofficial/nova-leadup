/**
 * NOVA-Leadup — Webhook ingestion routes.
 *
 * Supported providers
 * ───────────────────
 * • Twilio — `/webhooks/twilio` (status-callback for messages / calls)
 * • SendGrid — `/webhooks/sendgrid` (delivery / bounce / open events)
 *
 * **Security fix (P1 #3)**
 * Every request is verified with the provider's HMAC signature before
 * the body is parsed. Requests that fail verification are rejected with
 * `401 Unauthorized`. In test / development mode (when
 * `WEBHOOKS_ALLOW_UNSAFE=true`), signature verification is skipped so
 * that Twilio's webhook testing tool (ngrok) can still reach the route.
 */

import { Router, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { logger } from '../utils/logger';

// ─── Config ───────────────────────────────────────────────────────────────

const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? '';
const SENDGRID_WEBHOOK_KEY = process.env.SENDGRID_WEBHOOK_KEY ?? '';
const ALLOW_UNSAFE = process.env.WEBHOOKS_ALLOW_UNSAFE === 'true';

// ─── Types ────────────────────────────────────────────────────────────────

export interface TwilioWebhookPayload {
	MessageSid?: string;
	MessageStatus?: string;
	CallSid?: string;
	CallStatus?: string;
	ErrorCode?: string;
	[_: string]: string | undefined;
}

export interface SendGridWebhookPayload {
	email: string;
	event: string;
	response?: string;
	reason?: string;
	timestamp: number;
	[_: string]: unknown;
}

// ─── Twilio signature verification ────────────────────────────────────────

/**
 * Verify a Twilio webhook request using the `X-Twilio-Signature` header.
 *
 * Algorithm (per Twilio docs):
 * 1. Build `url` (full URL the request was sent to).
 * 2. Sort all POST parameters alphabetically by key.
 * 3. Concatenate `url + param1 + val1 + param2 + val2 …`.
 * 4. HMAC-SHA1 with `authToken` as key → base64 digest.
 * 5. `timingSafeEqual` with the `X-Twilio-Signature` header.
 *
 * Twilio signs the raw POST body, so we must read the raw body first
 * (Express `express.raw()` middleware for this route).
 */
export function verifyTwilioSignature(req: Request): { valid: boolean; reason?: string } {
	if (!TWILIO_AUTH_TOKEN) {
		logger.warn('TWILIO_AUTH_TOKEN not set — skipping Twilio signature verification');
		return { valid: ALLOW_UNSAFE, reason: ALLOW_UNSAFE ? 'unsafe-mode' : 'missing-token' };
	}

	const signature = req.headers['x-twilio-signature'];
	if (!signature || typeof signature !== 'string') {
		return { valid: false, reason: 'missing-x-twilio-signature' };
	}

	// Reconstruct the URL Twilio signed
	const proto = req.secure ? 'https' : 'http';
	const host = req.headers.host ?? 'localhost';
	const url = `${proto}://${host}${req.originalUrl}`;

	// Collect POST parameters (from parsed body or raw body fallback)
	const bodyParams: Record<string, string> = {};
	if (typeof req.body === 'object' && req.body !== null) {
		for (const [key, value] of Object.entries(req.body)) {
			if (typeof value === 'string') bodyParams[key] = value;
		}
	}

	// Sort keys alphabetically
	const sortedKeys = Object.keys(bodyParams).sort();

	// Build the data string Twilio signed
	const data = [url, ...sortedKeys.flatMap((k) => [k, bodyParams[k]])].join('');

	const expected = createHmac('sha1', TWILIO_AUTH_TOKEN).update(data).digest('base64');

	// timingSafeEqual requires equal-length Buffers
	const sigBuf = Buffer.from(signature);
	const expBuf = Buffer.from(expected);
	if (sigBuf.length !== expBuf.length) {
		return { valid: false, reason: 'signature-length-mismatch' };
	}

	const valid = timingSafeEqual(sigBuf, expBuf);
	if (!valid) {
		logger.warn({ url, signature }, 'Twilio webhook signature mismatch');
	}
	return { valid, reason: valid ? undefined : 'signature-mismatch' };
}

// ─── SendGrid signature verification ───────────────────────────────────────

/**
 * Verify a SendGrid webhook using `X-Twilio-Email-Event-Webhook-Signature`
 * and `X-Twilio-Email-Event-Webhook-Timestamp` headers.
 *
 * SendGrid (post-Twilio acquisition) signs the raw request body with
 * HMAC-SHA256 using the webhook key. We also enforce a 15-minute
 * window to prevent replay attacks.
 */
export function verifySendGridSignature(req: Request): { valid: boolean; reason?: string } {
	if (!SENDGRID_WEBHOOK_KEY) {
		logger.warn('SENDGRID_WEBHOOK_KEY not set — skipping SendGrid signature verification');
		return { valid: ALLOW_UNSAFE, reason: ALLOW_UNSAFE ? 'unsafe-mode' : 'missing-key' };
	}

	const signatureHeader = req.headers['x-twilio-email-event-webhook-signature'];
	const timestampHeader = req.headers['x-twilio-email-event-webhook-timestamp'];

	if (!signatureHeader || typeof signatureHeader !== 'string') {
		return { valid: false, reason: 'missing-signature-header' };
	}
	if (!timestampHeader || typeof timestampHeader !== 'string') {
		return { valid: false, reason: 'missing-timestamp-header' };
	}

	// Replay protection: reject requests older than 15 minutes
	const timestamp = Number(timestampHeader);
	if (Number.isNaN(timestamp)) {
		return { valid: false, reason: 'invalid-timestamp' };
	}
	const ageSec = Date.now() / 1000 - timestamp;
	if (ageSec > 900) {
		logger.warn({ ageSec }, 'SendGrid webhook timestamp too old — possible replay');
		return { valid: false, reason: 'timestamp-too-old' };
	}
	if (ageSec < -300) {
		// Clock skew tolerance: ±5 min
		return { valid: false, reason: 'timestamp-in-future' };
	}

	// SendGrid signs: timestamp + '.' + raw body
	const timestampedPayload = `${timestampHeader}.${(req as any).rawBody ?? ''}`;
	const expected = createHmac('sha256', SENDGRID_WEBHOOK_KEY)
		.update(timestampedPayload)
		.digest('base64');

	const sigBuf = Buffer.from(signatureHeader);
	const expBuf = Buffer.from(expected);
	if (sigBuf.length !== expBuf.length) {
		return { valid: false, reason: 'signature-length-mismatch' };
	}

	const valid = timingSafeEqual(sigBuf, expBuf);
	if (!valid) {
		logger.warn('SendGrid webhook signature mismatch');
	}
	return { valid, reason: valid ? undefined : 'signature-mismatch' };
}

// ─── Route handlers ────────────────────────────────────────────────────────

/**
 * Normalise a Twilio payload into a plain object.
 */
function normaliseTwilioPayload(body: any): TwilioWebhookPayload {
	return {
		MessageSid: body.MessageSid,
		MessageStatus: body.MessageStatus,
		CallSid: body.CallSid,
		CallStatus: body.CallStatus,
		ErrorCode: body.ErrorCode,
	};
}

/**
 * Normalise a SendGrid payload (array of events).
 */
function normaliseSendGridPayload(body: any): SendGridWebhookPayload[] {
	if (Array.isArray(body)) return body;
	if (body?.items) return body.items;
	return [body];
}

// ─── Router ───────────────────────────────────────────────────────────────

const router = Router();

/**
 * POST /webhooks/twilio
 *
 * Twilio status-callbacks for SMS / WhatsApp / Calls.
 *
 * **Middleware requirement**
 * Mount with `express.raw({ type: 'application/x-www-form-urlencoded' })`
 * so the raw body is available on `req.rawBody` for signature verification.
 */
router.post(
	'/twilio',
	async (req: Request, res: Response) => {
		const verification = verifyTwilioSignature(req);

		if (!verification.valid) {
			logger.warn({ reason: verification.reason }, 'Rejected unverified Twilio webhook');
			res.status(401).send('Unauthorized');
			return;
		}

		const payload: TwilioWebhookPayload = normaliseTwilioPayload(req.body);
		logger.info({ payload }, 'Twilio webhook received');

		// TODO: dispatch to your event bus / lead service here.
		// e.g. if payload.MessageStatus === 'delivered' → mark lead message as delivered.

		res.status(204).end();
	}
);

/**
 * POST /webhooks/sendgrid
 *
 * SendGrid event webhook (delivered, bounced, opened, clicked, etc.).
 *
 * **Middleware requirement**
 * Mount with `express.raw({ type: 'application/json' })`
 * so the raw body is available on `req.rawBody`.
 */
router.post(
	'/sendgrid',
	async (req: Request, res: Response) => {
		const verification = verifySendGridSignature(req);

		if (!verification.valid) {
			logger.warn({ reason: verification.reason }, 'Rejected unverified SendGrid webhook');
			res.status(401).send('Unauthorized');
			return;
		}

		const events: SendGridWebhookPayload[] = normaliseSendGridPayload(req.body);
		logger.info({ eventCount: events.length }, 'SendGrid webhook received');

		for (const event of events) {
			// TODO: route to lead activity log / notification service
			// e.g. event.event === 'bounce' → flag lead email as invalid
			logger.debug({ event }, 'SendGrid event');
		}

		res.status(204).end();
	}
);

/**
 * GET /webhooks/health — liveness check (no auth required)
 */
router.get('/health', (_req: Request, res: Response) => {
	res.json({ status: 'ok', unsafe: ALLOW_UNSAFE });
});

export default router;
