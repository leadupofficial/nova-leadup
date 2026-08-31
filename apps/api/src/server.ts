import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config';
import { logger } from './utils/logger';

// Import routes
import { healthRouter } from './routes/health';
import { chatRouter } from './routes/v1/chat';
import { memoryRouter } from './routes/v1/memory';
import { tasksRouter } from './routes/v1/tasks';
import { voiceRouter } from './routes/v1/voice';
import { streamingRouter } from './routes/v1/streaming';

export function createServer() {
 const app = express();

 // Security middleware
 app.use(helmet());
 app.use(cors({ origin: config.cors.origins, credentials: true }));
 app.use(express.json({ limit: '10mb' }));
 app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));

 // Health check
 app.use('/health', healthRouter);

 // API v1 routes
 app.use('/api/v1/chat', chatRouter);
 app.use('/api/v1/memory', memoryRouter);
 app.use('/api/v1/tasks', tasksRouter);
 app.use('/api/v1/voice', voiceRouter);
 app.use('/api/v1/stream', streamingRouter);

 // 404 handler
 app.use((req, res) => {
 res.status(404).json({ error: 'Not found', path: req.path });
 });

 // Global error handler
 app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
 logger.error(err, 'Unhandled error');
 res.status(500).json({
 error: 'Internal server error',
 message: config.nodeEnv === 'development' ? err.message : undefined,
 });
 });

 return app;
}
