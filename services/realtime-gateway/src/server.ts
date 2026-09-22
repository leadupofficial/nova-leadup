/**
 * @nova/realtime-gateway — Server entry point.
 *
 * The HTTP surface is health only; realtime traffic arrives as WebSocket upgrades on
 * `/ws/realtime`, which `createRealtimeGateway` handles on the same server.
 *
 * This used to install a static handler that answered **every** HTTP request with
 * `{"status":"ok","service":"realtime-gateway"}`. That made `/live` and `/ready`
 * indistinguishable, gave a 200 to any path at all, and answered `ok` with no Redis —
 * while `src/routes/health.ts` (which does check Redis) was never mounted. The express
 * app below is the request handler now, so the probes mean something and an unknown
 * path is an honest 404.
 */
import http from 'http';
import express from 'express';
import dotenv from 'dotenv';
import { createRealtimeGateway } from './gateway.js';
import { healthRoutes } from './routes/health.js';

dotenv.config();

const PORT = parseInt(process.env.REALTIME_GATEWAY_PORT ?? '3002', 10);

const app = express();
app.disable('x-powered-by');
app.use('/', healthRoutes);
app.use((_req, res) => {
	res.status(404).json({
		type: 'https://api.nova.leadup.in/problems/not-found',
		title: 'Not Found',
		status: 404,
	});
});

const server = http.createServer(app);

createRealtimeGateway(server);

server.listen(PORT, () => {
	console.log(`[realtime-gateway] listening on :${PORT}`);
});
