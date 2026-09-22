import { validateEnv } from './utils/env.js';
void validateEnv();
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { healthRoutes } from './routes/health.js';
import { startWorker } from './worker.js';

const app: ReturnType<typeof express> = express();
const PORT = process.env.PORT || 3009;

// Worker services are server-to-server — restrict CORS to internal origins only.
const INTERNAL_ORIGINS = ['https://nova.leadup.in', 'https://admin.nova.leadup.in', 'http://localhost:3001', 'http://localhost:3002'];
const workerAllowedOrigins = process.env.INTERNAL_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? INTERNAL_ORIGINS;

app.use(helmet());
app.use(
 cors({
 origin: (origin, cb) => {
 if (!origin) return cb(null, true); // server-to-server has no origin header
 if (workerAllowedOrigins.includes(origin)) return cb(null, true);
 return cb(new Error(`CORS: origin ${origin} not allowed`));
 },
 }),
);
app.use(compression() as any);
app.use(express.json({ limit: '10mb' }));
app.use('/health', healthRoutes);
app.get('/healthz', (_req, res) => res.json({ status: 'ok', service: 'worker', uptime: process.uptime() }));

const server = app.listen(PORT, () => {
 console.log(`[worker] HTTP listening on :${PORT}`);
});
(server as any).timeout('30s');

startWorker().catch(err => { console.error('[worker] Fatal:', err); process.exit(1); });

export default app;
