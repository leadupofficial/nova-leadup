/**
 * @nova/notification-service — Server entry point.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { sendNotification, triageNotifications } from './index';

dotenv.config();

const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? '*' }));
app.use(express.json({ limit: '2mb' }));

// Health check
app.get('/health', (_req, res) => {
 res.json({ status: 'ok', service: 'notification-service', timestamp: new Date().toISOString() });
});

app.post('/api/v1/notifications/send', async (req, res) => {
 try {
 const payload = req.body;
 if (!payload?.userId || !payload?.title) {
 res.status(400).json({ error: 'userId and title are required' });
 return;
 }
 const results = await sendNotification(payload);
 res.status(200).json({ success: true, data: results });
 } catch (err) {
 res.status(500).json({ error: 'Internal server error', message: (err as Error).message });
 }
});

app.post('/api/v1/notifications/triage', async (req, res) => {
 try {
 const { notifications } = req.body ?? {};
 if (!Array.isArray(notifications)) {
 res.status(400).json({ error: 'notifications array is required' });
 return;
 }
 const results = await triageNotifications('user', notifications);
 res.status(200).json({ success: true, data: results });
 } catch (err) {
 res.status(500).json({ error: 'Internal server error', message: (err as Error).message });
 }
});

const PORT = parseInt(process.env.NOTIFICATION_SERVICE_PORT ?? '3004', 10);
app.listen(PORT, () => {
 console.log(`[notification-service] listening on :${PORT}`);
});
