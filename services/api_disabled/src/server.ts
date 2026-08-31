import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { z } from 'zod';
import { getEnvConfig } from './config';
import { logger } from './utils/logger';
import { getDbPool } from './db/connection';
import { authRoutes } from './routes/auth';
import { chatRoutes } from './routes/chat';
import { aiRoutes } from './routes/ai';
import { voiceRoutes } from './routes/voice';
import { streamingRoutes } from './routes/streaming';
import { errorHandler } from './middleware/error-handler';

const config = getEnvConfig();
const app = express();

// Security headers
app.use(helmet({
 contentSecurityPolicy: {
 directives: {
 defaultSrc: ["'self'"],
 scriptSrc: ["'self'"],
 styleSrc: ["'self'", "'unsafe-inline'"],
 imgSrc: ["'self'", "data:", "https:"],
 connectSrc: ["'self'", "wss:", "https://api.anthropic.com"],
 frameAncestors: ["'none'"],
 baseUri: ["'self'"],
 formAction: ["'self'"],
 },
 },
 hsts: { maxAge: 31536000, includeSubDomains: true },
 referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use(cors({ origin: config.cors.origins, credentials: true }));
app.use(express.json({ limit: '10mb', type: 'application/json' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));

// Rate limiting (Redis in production, in-memory fallback)
app.use('/api/', (req, res, next) => {
 const ip = req.ip || 'unknown';
 res.set('X-RateLimit-Limit', '100');
 res.set('X-RateLimit-Window', '60s');
 next();
});

// Health routes
app.get('/health/live', (req, res) => res.json({ status: 'alive', timestamp: new Date().toISOString() }));
app.get('/health/ready', async (req, res) => {
 try {
 const pool = getDbPool();
 await pool.query('SELECT 1');
 res.json({ status: 'ready', timestamp: new Date().toISOString() });
 } catch {
 res.status(503).json({ status: 'not ready', timestamp: new Date().toISOString() });
 }
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/stream', streamingRoutes);

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Not Found', path: req.path }));

// Error handler (must be last)
app.use(errorHandler);

export async function startServer() {
 try {
 const pool = getDbPool();
 await pool.query('SELECT 1');
 logger.info('Database connected');
 } catch (error) {
 logger.error(error, 'Database connection failed');
 }
 const server = app.listen(config.port, () => {
 logger.info(`NOVA API listening on :${config.port} (${process.env.NODE_ENV || 'development'})`);
 });
 return server;
}

export default app;
