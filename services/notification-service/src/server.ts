import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { authenticateJwt } from '@nova/auth';
import { notificationRoutes } from './routes/notifications.js';
import { sendNotification, triageNotifications } from './index.js';

const app = express();
const PORT = parseInt(process.env.NOTIFICATION_SERVICE_PORT || '3004', 10);

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('combined'));

function isInternalIp(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('10.') || ip.startsWith('172.') || ip.startsWith('192.168.');
}

app.get('/health', (req, res) => {
  if (!isInternalIp(req.ip)) {
    return res.sendStatus(404);
  }
  res.json({ status: 'ok', service: 'notification-service', timestamp: new Date().toISOString() });
});

app.use('/api/v1/notifications', authenticateJwt, notificationRoutes);

app.listen(PORT, () => {
 console.log(`[notification-service] listening on :${PORT}`);
});
