import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { userRoutes } from './routes/users.js';
import { orgRoutes } from './routes/organizations.js';
import { adminHealthRoutes } from './routes/adminHealth.js';
import { auditEventsRouter } from './routes/auditEvents.js';
import { incidentsRouter } from './routes/incidents.js';
import { featureFlagRoutes } from './routes/featureFlags.js';
import { costUsageRoutes } from './routes/costUsage.js';
import { policyRuleRoutes } from './routes/policyRules.js';
import { roleRoutes } from './routes/roles.js';
import { workspaceRoutes } from './routes/workspaces.js';

const app: Express = express();
const PORT = process.env.PORT || 3007;

app.use(helmet());
app.use(cors({ origin: ['http://localhost:3000', 'http://localhost:3004', 'http://localhost:3005'] }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));

app.get('/health/live', (_req, res) => res.json({ status: 'alive', timestamp: new Date().toISOString() }));
app.use('/api/admin', adminHealthRoutes);
app.use('/api/admin/users', userRoutes);
app.use('/api/admin/orgs', orgRoutes);
app.use('/api/admin/audit', auditEventsRouter);
app.use('/api/admin/incidents', incidentsRouter);
app.use('/api/admin/feature-flags', featureFlagRoutes);
app.use('/api/admin/cost', costUsageRoutes);
app.use('/api/admin/policies', policyRuleRoutes);
app.use('/api/admin/roles', roleRoutes);
app.use('/api/admin/workspaces', workspaceRoutes);

app.listen(PORT, () => {
 console.log(`[admin] listening on :${PORT}`);
});

export default app;
