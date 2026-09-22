/**
 * Notification processor — dispatches notifications via configured channels.
 */

import type { NotificationJobData } from '../queues/types.js';
import { NotificationService } from '../../notifications/NotificationService.js';

export interface NotificationProcessorOptions {
	notificationService: NotificationService;
}

export class NotificationProcessor {
	private readonly notificationService: NotificationService;

	constructor(opts: NotificationProcessorOptions) {
		this.notificationService = opts.notificationService;
	}

	/**
	 * Dispatch a notification through all enabled channels (push, email, SMS).
	 */
	async process(data: NotificationJobData): Promise<{ channels: string[]; success: boolean }> {
		const channels: string[] = [];

		try {
			const result = await this.notificationService.send({
				userId: data.userId,
				organizationId: data.organizationId,
				type: data.type,
				payload: data.payload,
				priority: data.priority,
				channels: ['push', 'email', 'sms'],
			});

			channels.push(...result.channelsUsed);
			return { channels, success: true };
		} catch (err) {
			console.error(`[notification-processor] Failed for user ${data.userId}:`, err);
			return { channels, success: false };
		}
	}
}
