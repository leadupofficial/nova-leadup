import type { NotificationMessage, NotificationChannel } from '../types/notifications.js';

export class NotificationHandler {
 private handlers: Map<string, (message: NotificationMessage) => Promise<void>> = new Map();

 register(channel: NotificationChannel, handler: (message: NotificationMessage) => Promise<void>) {
 this.handlers.set(channel, handler);
 }

 async handle(message: NotificationMessage): Promise<void> {
 const handler = this.handlers.get(message.channel);
 if (!handler) {
 throw new Error(`No handler registered for channel: ${message.channel}`);
 }
 await handler(message);
 }
}
