import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NotificationService } from '../NotificationService';
import type { NotificationPayload, NotificationCategory, NotificationCategoryAction, NotificationOptions, NotificationAction } from '../types';

const buildCategoryAction = (overrides: Partial<NotificationCategoryAction> = {}): NotificationCategoryAction => ({
	id: 'action-1',
	title: 'Reply',
	options: ['foreground'],
	foreground: true,
	...overrides,
});

const buildCategory = (actions: NotificationCategoryAction[]): NotificationCategory => ({
	id: 'message',
	actions,
});

const buildPayload = (overrides: Partial<NotificationPayload> = {}): NotificationPayload => ({
	id: 'notification-1',
	title: 'Test Notification',
	body: 'This is a test',
	data: { route: '/tasks' },
	categoryId: 'message',
	sound: 'default',
	priority: 'normal',
	deliveredAt: new Date().toISOString(),
	read: false,
	...overrides,
});

const createPlugin = (overrides: {
	initialize?: () => Promise<void>;
	requestPermission?: () => Promise<boolean>;
	getPushToken?: () => Promise<string | null>;
	registerCategories?: (categories: NotificationCategory[]) => Promise<void>;
	schedule?: (options: NotificationOptions) => Promise<string>;
	cancel?: (id: string) => Promise<void>;
	getDeliveredNotifications?: () => Promise<NotificationPayload[]>;
	removeDeliveredNotifications?: (ids: string[]) => Promise<void>;
	getPendingNotifications?: () => Promise<NotificationPayload[]>;
} = {}): {
	plugin: {
		initialize: () => Promise<void>;
		requestPermission: () => Promise<boolean>;
		getPushToken: () => Promise<string | null>;
		registerCategories: (categories: NotificationCategory[]) => Promise<void>;
		schedule: (options: NotificationOptions) => Promise<string>;
		cancel: (id: string) => Promise<void>;
		getDeliveredNotifications: () => Promise<NotificationPayload[]>;
		removeDeliveredNotifications: (ids: string[]) => Promise<void>;
		getPendingNotifications: () => Promise<NotificationPayload[]>;
	};
	restore: () => void;
} => {
	const defaultImpl = {
		initialize: async () => {},
		requestPermission: async () => true,
		getPushToken: async () => 'mock-push-token',
		registerCategories: async () => {},
		schedule: async () => 'notification-1',
		cancel: async () => {},
		getDeliveredNotifications: async () => [],
		removeDeliveredNotifications: async () => {},
		getPendingNotifications: async () => [],
	};

	const plugin = { ...defaultImpl, ...overrides };

	const restore = () => {
		if (typeof globalThis.localStorage !== 'undefined') {
			localStorage.clear();
		}
	};

	return { plugin, restore };
};

describe('NotificationService', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		if (typeof globalThis.localStorage !== 'undefined') {
			localStorage.clear();
		}
	});

	afterEach(() => {
		vi.useRealTimers();
		if (typeof globalThis.localStorage !== 'undefined') {
			localStorage.clear();
		}
	});

	describe('initialize', () => {
		it('should initialize the plugin successfully', async () => {
			const { plugin, restore } = createPlugin();
			const service = new NotificationService({ plugin });

			await service.initialize();

			restore();
		});

		it('should restore stored push token during initialization', async () => {
			const { plugin, restore } = createPlugin();
			const service = new NotificationService({ plugin, storageKey: '@nova/notifications/push-token' });

			if (typeof globalThis.localStorage !== 'undefined') {
				localStorage.setItem('@nova/notifications/push-token', 'stored-token');
			}

			await service.initialize();

			expect(service.getPushToken()).toBe('stored-token');

			restore();
		});

		it('should throw on initialization failure', async () => {
			const { plugin, restore } = createPlugin({
				initialize: async () => {
					throw new Error('Plugin init failed');
				},
			});
			const service = new NotificationService({ plugin });

			await expect(service.initialize()).rejects.toThrow('Failed to initialize notification service');

			restore();
		});
	});

	describe('registerForPush', () => {
		it('should request permission and return a token', async () => {
			const { plugin, restore } = createPlugin({
				requestPermission: async () => true,
				getPushToken: async () => 'new-push-token',
			});
			const service = new NotificationService({ plugin });

			const token = await service.registerForPush();

			expect(token).toBe('new-push-token');
			expect(service.getPushToken()).toBe('new-push-token');

			restore();
		});

		it('should return null when permission is denied', async () => {
			const { plugin, restore } = createPlugin({
				requestPermission: async () => false,
			});
			const service = new NotificationService({ plugin });

			const token = await service.registerForPush();

			expect(token).toBeNull();
			expect(service.getPushToken()).toBeNull();

			restore();
		});

		it('should throw on token fetch failure', async () => {
			const { plugin, restore } = createPlugin({
				requestPermission: async () => true,
				getPushToken: async () => {
					throw new Error('Token fetch failed');
				},
			});
			const service = new NotificationService({ plugin });

			await expect(service.registerForPush()).rejects.toThrow('Failed to register for push notifications');

			restore();
		});
	});

	describe('token management', () => {
		it('getPushToken should return null before registration', async () => {
			const { plugin, restore } = createPlugin();
			const service = new NotificationService({ plugin });

			expect(service.getPushToken()).toBeNull();

			restore();
		});

		it('setPushToken should update the stored token', async () => {
			const { plugin, restore } = createPlugin();
			const service = new NotificationService({ plugin });

			service.setPushToken('manually-set-token');

			expect(service.getPushToken()).toBe('manually-set-token');

			restore();
		});
	});

	describe('categories', () => {
		it('should register notification categories', async () => {
			const { plugin, restore } = createPlugin();
			const service = new NotificationService({ plugin });

			const categories = [buildCategory([buildCategoryAction()])];

			await service.registerCategories(categories);

			restore();
		});

		it('should throw on category registration failure', async () => {
			const { plugin, restore } = createPlugin({
				registerCategories: async () => {
					throw new Error('Category registration failed');
				},
			});
			const service = new NotificationService({ plugin });

			await expect(service.registerCategories([buildCategory([buildCategoryAction()])])).rejects.toThrow(
				'Failed to register notification categories',
			);

			restore();
		});
	});

	describe('scheduleLocal', () => {
		it('should schedule a notification and return an id', async () => {
			const { plugin, restore } = createPlugin({
				schedule: async () => 'scheduled-1',
			});
			const service = new NotificationService({ plugin });

			const options: NotificationOptions = {
				title: 'Scheduled Task',
				body: 'Task reminder',
				categoryId: 'task',
				scheduleAt: new Date(Date.now() + 60_000).toISOString(),
			};

			const id = await service.scheduleLocal(options);

			expect(id).toBe('scheduled-1');

			restore();
		});

		it('should throw on scheduling failure', async () => {
			const { plugin, restore } = createPlugin({
				schedule: async () => {
					throw new Error('Schedule failed');
				},
			});
			const service = new NotificationService({ plugin });

			await expect(
				service.scheduleLocal({
					title: 'Test',
					body: 'Body',
				}),
			).rejects.toThrow('Failed to schedule local notification');

			restore();
		});
	});

	describe('cancelLocal', () => {
		it('should cancel a scheduled notification', async () => {
			const { plugin, restore } = createPlugin({
				cancel: async () => {},
			});
			const service = new NotificationService({ plugin });

			await expect(service.cancelLocal('notification-1')).resolves.toBeUndefined();

			restore();
		});

		it('should throw on cancellation failure', async () => {
			const { plugin, restore } = createPlugin({
				cancel: async () => {
					throw new Error('Cancel failed');
				},
			});
			const service = new NotificationService({ plugin });

			await expect(service.cancelLocal('notification-1')).rejects.toThrow('Failed to cancel notification');

			restore();
		});
	});

	describe('notification history', () => {
		it('getNotificationHistory should return delivered notifications', async () => {
			const delivered = [buildPayload()];
			const { plugin, restore } = createPlugin({
				getDeliveredNotifications: async () => delivered,
			});
			const service = new NotificationService({ plugin });

			const history = await service.getNotificationHistory();

			expect(history).toHaveLength(1);
			expect(history[0]).toEqual(delivered[0]);

			restore();
		});

		it('clearHistory should remove delivered notifications', async () => {
			const delivered = [buildPayload()];
			const { plugin, restore } = createPlugin({
				getDeliveredNotifications: async () => delivered,
				removeDeliveredNotifications: async (ids) => {
					expect(ids).toEqual(['notification-1']);
				},
			});
			const service = new NotificationService({ plugin });

			await service.clearHistory();

			restore();
		});

		it('should limit history to maxHistoryItems', async () => {
			const delivered = Array.from({ length: 150 }, (_, index) =>
				buildPayload({
					id: `notification-${index}`,
					deliveredAt: new Date(Date.now() - index * 1000).toISOString(),
				}),
			);

			const { plugin, restore } = createPlugin({
				getDeliveredNotifications: async () => delivered,
			});
			const service = new NotificationService({ plugin, maxHistoryItems: 100 });

			const history = await service.getNotificationHistory();

			expect(history).toHaveLength(100);

			restore();
		});
	});

	describe('background notifications', () => {
		it('processBackgroundNotification should validate and store notification', async () => {
			const { plugin, restore } = createPlugin();
			const service = new NotificationService({ plugin });

			const payload = await service.processBackgroundNotification({
				id: 'bg-1',
				title: 'Background',
				body: 'Background body',
				data: { route: '/alerts' },
			});

			expect(payload.id).toBe('bg-1');
			expect(payload.title).toBe('Background');

			restore();
		});

		it('processBackgroundNotification should reject invalid payloads', async () => {
			const { plugin, restore } = createPlugin();
			const service = new NotificationService({ plugin });

			await expect(service.processBackgroundNotification({ id: 'bg-1' })).rejects.toThrow(
				'Invalid notification payload: title is required',
			);

			restore();
		});
	});

	describe('silent notifications', () => {
		it('processSilentNotification should return a validated payload', () => {
			const { plugin, restore } = createPlugin();
			const service = new NotificationService({ plugin });

			const payload = service.processSilentNotification({
				id: 'silent-1',
				title: 'Silent',
				data: { sync: true },
			});

			expect(payload.id).toBe('silent-1');
			expect(payload.data.sync).toBe(true);

			restore();
		});

		it('processSilentNotification should throw on invalid payloads', () => {
			const { plugin, restore } = createPlugin();
			const service = new NotificationService({ plugin });

			expect(() =>
				service.processSilentNotification({
					body: 'No id',
				} as unknown as Record<string, unknown>),
			).toThrow('Invalid notification payload: id is required');

			restore();
		});
	});

	describe('action handling', () => {
		it('handleAction should mark payload as read and remove delivered notification', async () => {
			const payload = buildPayload();
			const { plugin, restore } = createPlugin({
				removeDeliveredNotifications: async (ids) => {
					expect(ids).toEqual(['notification-1']);
				},
			});
			const service = new NotificationService({ plugin });

			const action: NotificationAction = {
				id: 'reply',
				title: 'Reply',
				foreground: true,
				options: ['foreground'],
			};

			await service.handleAction(action, payload);

			restore();
		});

		it('handleAction should throw when payload has no id', async () => {
			const { plugin, restore } = createPlugin();
			const service = new NotificationService({ plugin });

			const action: NotificationAction = {
				id: 'reply',
				title: 'Reply',
				foreground: true,
				options: ['foreground'],
			};

			await expect(
				service.handleAction(action, { ...buildPayload({ id: '' }), id: '' }),
			).rejects.toThrow("Cannot handle action for notification without ID");

			restore();
		});
	});

	describe('category builder', () => {
		it('buildCategories should map category configs to types', async () => {
			const { plugin, restore } = createPlugin();
			const service = new NotificationService({ plugin });

			const categories = service.buildCategories([
				{
					id: 'message',
					actions: [
						{ id: 'reply', title: 'Reply', options: ['foreground'], foreground: true },
						{ id: 'mark-read', title: 'Mark Read', options: [], foreground: false },
					],
				},
			]);

			expect(categories).toHaveLength(1);
			expect(categories[0].id).toBe('message');
			expect(categories[0].actions).toHaveLength(2);
			expect(categories[0].actions[0].id).toBe('reply');

			restore();
		});
	});
});
