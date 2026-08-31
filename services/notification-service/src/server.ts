import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { notificationRoutes } from './routes/notifications';
import { sendNotification, triageNotifications } from './index';

const app = express();
const PORT = parseInt(process.env.NOTIFICATION_SERVICE_PORT || '3004', 10);

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('combined'));

app.get('/health', (_req, res) => {
 res.json({ status: 'ok', service: 'notification-service', timestamp: new Date().toISOString() });
});

app.use('/api/v1/notifications', notificationRoutes);

app.listen(PORT, () => {
 console.log(`[notification-service] listening on :${PORT}`);
});
