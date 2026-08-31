import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { agentRoutes } from './routes/agents';

const app = express();
const PORT = process.env.PORT || 3006;

app.use(helmet());
app.use(cors({ origin: ['http://localhost:3000', 'http://localhost:3004', 'http://localhost:3005'] }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));

app.get('/health/live', (_req, res) => res.json({ status: 'alive', timestamp: new Date().toISOString() }));
app.use('/api/agents', agentRoutes);

app.listen(PORT, () => console.log(`[agent-orchestrator] listening on :${PORT}`));

export default app;
