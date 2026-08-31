import { Router } from 'express';
import { z } from 'zod';

const router = Router();

const NotificationSchema = z.object({ userId: z.string(), title: z.string().min(1), body: z.string(), data: z.record(z.string(), z.unknown()).optional() });

router.post('/send', async (req, res) => {
 try {
 NotificationSchema.parse(req.body);
 res.status(200).json({ success: true, messageId: 'placeholder' });
 } catch (err) {
 res.status(400).json({ error: 'Validation failed', message: err instanceof Error ? err.message : 'Unknown error' });
 }
});

router.post('/triage', async (req, res) => {
 const { notifications } = req.body;
 if (!Array.isArray(notifications)) {
 return res.status(400).json({ error: 'notifications array required' });
 }
 const results = notifications.map((n: any) => ({ ...n, triaged: true, priority: 'normal' }));
 res.status(200).json({ success: true, data: results });
});

export { router as notificationRoutes };
