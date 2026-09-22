/**
 * NOVA — `@nova/workflow-engine` HTTP entry point.
 *
 * Why this file exists: the service was deployed as a container
 * (`docker-compose.prod.yml` → `nova-workflow-engine:latest`, built by
 * `services/workflow-engine/Dockerfile` with `EXPOSE 3010`) and had a health router at
 * `src/routes/health.ts` plus JWT middleware at `src/middleware/auth.ts`, but **no
 * entry point that listened on anything**. `package.json`'s `dev` script pointed at
 * this non-existent file, and the Dockerfile's `CMD ["node", "dist/index.js"]` ran
 * `src/index.ts` — the job-registry library — which has no event loop and exits
 * immediately, so the container could never be healthy.
 *
 * This mounts the router that already existed. It deliberately does **not** apply
 * `authenticateJwt` globally: `/health*` must stay reachable for container health
 * checks, and there are no other routes yet. Apply it per-route when there are.
 */
import 'dotenv/config';
import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { healthRoutes } from './routes/health.js';

const app: Express = express();

// `process.env.PORT` is a string; `listen('3010')` would be treated as a unix socket
// path. Parse it, like services/api and services/integration-service do.
const PORT = parseInt(process.env.PORT || '3010', 10);

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use('/', healthRoutes);

const server = app.listen(PORT, () => {
	// eslint-disable-next-line no-console
	console.log(`[workflow-engine] listening on :${PORT}`);
});

// The production image runs read-only; make sure a stop signal still closes cleanly.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		server.close(() => process.exit(0));
	});
}

export default app;
