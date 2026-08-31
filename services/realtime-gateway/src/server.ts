/**
 * @nova/realtime-gateway — Server entry point.
 */

import http from 'http';
import dotenv from 'dotenv';
import { createRealtimeGateway } from './gateway';

dotenv.config();

const PORT = parseInt(process.env.REALTIME_GATEWAY_PORT ?? '3002', 10);

const server = http.createServer((_req, res) => {
 res.writeHead(200, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ status: 'ok', service: 'realtime-gateway', timestamp: new Date().toISOString() }));
});

createRealtimeGateway(server);

server.listen(PORT, () => {
 console.log(`[realtime-gateway] listening on :${PORT}`);
});
