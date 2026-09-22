/**
 * Core notification types shared across the notification service.
 */

/** Represents a delivered or scheduled notification. */
export interface NotificationPayload {
	/** Unique identifier for the notification. */
	id: string;

	/** Title displayed in the notification. */
	title: string;

	/** Body text of the notification. */
	body: string;

	/** Custom data payload attached to the notification. */
	data: Record<string, unknown>;

	/** Category identifier for grouped handling. */
	categoryId?: string;

	/** Sound file name or 'default'. */
	sound?: string;

	/** Badge number to display on the app icon. */
	badge?: number;

	/** Priority level controlling delivery urgency. */
	priority?: 'low' | 'normal' | 'high';

	/** ISO 8601 timestamp when the notification was delivered. */
	deliveredAt: string;

	/** Whether the notification has been read by the user. */
	read: boolean;
}

/** Represents an action button attached to a notification. */
export interface NotificationAction {
	/** Unique identifier for the action. */
	id: string;

	/** Display title for the action button. */
	title: string;

	/** Whether the action brings the app to the foreground. */
	foreground: boolean;

	/** Activation options for the action. */
	options: Array<'foreground' | 'authenticationRequired' | 'destructive'>;
}

/** Represents a notification category with grouped actions. */
export interface NotificationCategory {
	/** Unique identifier for the category. */
	id: string;

	/** Actions available within this category. */
	actions: NotificationCategoryAction[];
}

/** Represents a single action within a notification category. */
export interface NotificationCategoryAction {
	/** Unique identifier for the action. */
	id: string;

	/** Display title for the action button. */
	title: string;

	/** Activation options for the action. */
	options?: Array<'foreground' | 'authenticationRequired' | 'destructive'>;

	/** Whether the action brings the app to the foreground. */
	foreground?: boolean;
}

/** Represents a device push notification token. */
export interface PushToken {
	/** The raw token string. */
	token: string;

	/** Platform that issued the token. */
	platform: 'ios' | 'android';

	/** ISO 8601 timestamp when the token was registered. */
	registeredAt: string;

	/** ISO 8601 timestamp when the token expires, if known. */
	expiresAt?: string;
}

/** Represents the delivery record for a sent notification. */
export interface NotificationDelivery {
	/** Unique delivery identifier. */
	id: string;

	/** Notification payload that was delivered. */
	payload: NotificationPayload;

	/** Delivery status. */
	status: 'pending' | 'sent' | 'delivered' | 'failed';

	/** ISO 8601 timestamp when the notification was sent. */
	sentAt: string;

	/** ISO 8601 timestamp when the notification was delivered, if known. */
	deliveredAt?: string;

	/** Error message if delivery failed. */
	error?: string;
}

/** Options for scheduling a local notification. */
export interface NotificationOptions {
	/** Title of the notification. */
	title: string;

	/** Body text of the notification. */
	body?: string;

	/** Custom data payload attached to the notification. */
	data?: Record<string, unknown>;

	/** Category identifier for grouped handling. */
	categoryId?: string;

	/** Sound file name or 'default'. */
	sound?: string;

	/** Badge number to display on the app icon. */
	badge?: number;

	/** Priority level controlling delivery urgency. */
	priority?: 'low' | 'normal' | 'high';

	/** ISO 8601 timestamp when to trigger the notification. */
	scheduleAt?: string;

	/** Repeat interval for recurring notifications. */
	repeatInterval?: 'minute' | 'hour' | 'day' | 'week' | 'month';
}
