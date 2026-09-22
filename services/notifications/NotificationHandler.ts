/**
 * Notification handler — typed dispatchers for each notification channel.
 */

import type {
	NotificationPayload,
	PushNotification,
	EmailNotification,
	SmsNotification,
} from './types.js';

/**
 * Base notification handler interface.
 */
export interface NotificationHandler {
	/**
	 * Send a notification through this channel.
	 * Returns true if the notification was accepted for delivery.
	 */
	send(payload: NotificationPayload): Promise<boolean>;

	/**
	 * Check if this handler is properly configured.
	 */
	isConfigured(): boolean;
}

/**
 * Push notification handler — delegates to device-token push provider.
 */
export class PushNotificationHandler implements NotificationHandler {
	constructor(private readonly pushService?: { send: (notification: PushNotification) => Promise<void> }) {}

	isConfigured(): boolean {
		return !!this.pushService;
	}

	async send(payload: NotificationPayload): Promise<boolean> {
		if (!this.pushService) {
			console.warn('[PushNotificationHandler] Not configured, skipping push');
			return false;
		}

		try {
			await this.pushService.send({
				userId: payload.userId,
				title: payload.title,
				body: payload.body,
				data: payload.data,
				priority: payload.priority,
			});
			return true;
		} catch (err) {
			console.error(`[PushNotificationHandler] Failed for user ${payload.userId}:`, err);
			return false;
		}
	}
}

/**
 * Email notification handler — delegates to email provider (SendGrid, SES, etc.).
 */
export class EmailNotificationHandler implements NotificationHandler {
	constructor(private readonly emailService?: { send: (email: EmailNotification) => Promise<void> }) {}

	isConfigured(): boolean {
		return !!this.emailService;
	}

	async send(payload: NotificationPayload): Promise<boolean> {
		if (!this.emailService) {
			console.warn('[EmailNotificationHandler] Not configured, skipping email');
			return false;
		}

		try {
			await this.emailService.send({
				to: payload.userId,
				subject: payload.title,
				body: payload.body,
				html: payload.data?.html as string | undefined,
				priority: payload.priority,
			});
			return true;
		} catch (err) {
			console.error(`[EmailNotificationHandler] Failed for user ${payload.userId}:`, err);
			return false;
		}
	}
}

/**
 * SMS notification handler — delegates to SMS provider (Twilio, etc.).
 */
export class SmsNotificationHandler implements NotificationHandler {
	constructor(private readonly smsService?: { send: (sms: SmsNotification) => Promise<void> }) {}

	isConfigured(): boolean {
		return !!this.smsService;
	}

	async send(payload: NotificationPayload): Promise<boolean> {
		if (!this.smsService) {
			console.warn('[SmsNotificationHandler] Not configured, skipping SMS');
			return false;
		}

		try {
			await this.smsService.send({
				to: payload.userId,
				body: payload.body,
				priority: payload.priority,
			});
			return true;
		} catch (err) {
			console.error(`[SmsNotificationHandler] Failed for user ${payload.userId}:`, err);
			return false;
		}
	}
}

/**
 * Composite handler — fans out to multiple handlers and returns which channels succeeded.
 */
export class CompositeNotificationHandler implements NotificationHandler {
	constructor(private readonly handlers: NotificationHandler[]) {}

	isConfigured(): boolean {
		return this.handlers.some((h) => h.isConfigured());
	}

	async send(payload: NotificationPayload): Promise<string[]> {
		const results = await Promise.all(
			this.handlers.map(async (handler) => ({
				name: handler.constructor.name,
				ok: await handler.send(payload),
			}))
		);

		return results.filter((r) => r.ok).map((r) => r.name);
	}
}
