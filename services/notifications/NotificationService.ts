/**
 * Notification service — core business logic for sending notifications.
 */

import type { NotificationPayload, NotificationResult } from './types.js';
import { CompositeNotificationHandler, EmailNotificationHandler, PushNotificationHandler, SmsNotificationHandler } from './NotificationHandler.js';

/**
 * Stub services for notification providers.
 * Replace with real provider adapters (e.g., FCM, APNs, SendGrid, Twilio).
 */
const pushProvider = process.env.FCM_SERVER_KEY
	? {
		send: async (notification: Parameters<PushNotificationHandler['send']>[0]) => {
			// Stub: integrate with Firebase Cloud Messaging
			console.log(`[Push] Sending to ${notification.userId}: ${notification.title}`);
		},
	}
	: undefined;

const emailProvider = process.env.SENDGRID_API_KEY
	? {
		send: async (email: Parameters<EmailNotificationHandler['send']>[0]) => {
			// Stub: integrate with SendGrid
			console.log(`[Email] Sending to ${email.to}: ${email.subject}`);
		},
	}
	: undefined;

const smsProvider = process.env.TWILIO_ACCOUNT_SID
	? {
		send: async (sms: Parameters<SmsNotificationHandler['send']>[0]) => {
			// Stub: integrate with Twilio
			console.log(`[SMS] Sending to ${sms.to}: ${sms.body}`);
		},
	}
	: undefined;

const compositeHandler = new CompositeNotificationHandler([
	new PushNotificationHandler(pushProvider),
	new EmailNotificationHandler(emailProvider),
	new SmsNotificationHandler(smsProvider),
]);

export class NotificationService {
	/**
	 * Send a notification through all configured channels.
	 */
	async send(payload: NotificationPayload): Promise<NotificationResult> {
		const channelsUsed = await compositeHandler.send(payload);

		const result: NotificationResult = {
			success: channelsUsed.length > 0,
			channelsUsed,
			userId: payload.userId,
			type: payload.type,
			timestamp: new Date().toISOString(),
		};

		if (!result.success) {
			console.warn(`[NotificationService] No channels available for notification to ${payload.userId}`);
		}

		return result;
	}

	/**
	 * Send a push notification only.
	 */
	async sendPush(payload: Omit<NotificationPayload, 'channels'>): Promise<boolean> {
		const handler = new PushNotificationHandler(pushProvider);
		return handler.send(payload as NotificationPayload);
	}

	/**
	 * Send an email notification only.
	 */
	async sendEmail(payload: Omit<NotificationPayload, 'channels'>): Promise<boolean> {
		const handler = new EmailNotificationHandler(emailProvider);
		return handler.send(payload as NotificationPayload);
	}

	/**
	 * Send an SMS notification only.
	 */
	async sendSms(payload: Omit<NotificationPayload, 'channels'>): Promise<boolean> {
		const handler = new SmsNotificationHandler(smsProvider);
		return handler.send(payload as NotificationPayload);
	}

	/**
	 * Health check — returns which channels are configured.
	 */
	getHealth() {
		return {
			push: !!pushProvider,
			email: !!emailProvider,
			sms: !!smsProvider,
			healthy: compositeHandler.isConfigured(),
		};
	}
}
