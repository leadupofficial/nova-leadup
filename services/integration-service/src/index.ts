import 'dotenv/config';
import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { integrationRoutes } from './routes/integrations.js';

const app: Express = express();
// `process.env.PORT` is a STRING. Passing it straight to `listen()` makes Node treat
// it as a unix socket path rather than a TCP port, which fails with EADDRINUSE
// against a stale socket file - indistinguishable at a glance from a real port
// clash, and it reproduces on any port number. services/api already parses; this one
// did not.
const PORT = parseInt(process.env.PORT || '3005', 10);

app.use(helmet());
app.use(cors({ origin: ['http://localhost:3000', 'http://localhost:3004', 'http://localhost:3005'] }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('combined'));

app.get('/health/live', (_req, res) => res.json({ status: 'alive', timestamp: new Date().toISOString() }));
app.use('/api/integrations', integrationRoutes);

app.listen(PORT, () => {
 console.log(`[integration-service] listening on :${PORT}`);
});

export default app;
