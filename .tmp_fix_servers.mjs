import fs from "fs";

// Fix API server.ts
const apiServerPath = "services/api/src/server.ts";
let apiServer = fs.readFileSync(apiServerPath, "utf8");

apiServer = apiServer.replace(/\t\tapp\.set\("trust proxy", 1\);\n\tserver\.timeout\("30s"\);\n\tserver\.setTimeout\(30 \* 1000\);\n\n\tconst server = app\.listen\(PORT/, "const server = app.listen(PORT");

apiServer = apiServer.replace("app.use(require(\"compression\")());\n", "");

apiServer = apiServer.replace(
 "import helmet from 'helmet';",
 "import helmet from 'helmet';\nimport compression from 'compression';"
);

apiServer = apiServer.replace(
 "app.use(corsMiddleware());\n",
 "app.use(corsMiddleware());\napp.use(compression());\n"
);

apiServer = apiServer.replace(
 "const server = app.listen(PORT, () => {",
 "const server = app.listen(PORT, () => {server.timeout('30s'); server.setTimeout(30 * 1000);"
);

fs.writeFileSync(apiServerPath, apiServer);
console.log("Fixed: " + apiServerPath);

const authIndexPath = "services/auth/src/index.ts";
let authIndex = fs.readFileSync(authIndexPath, "utf8");

authIndex = authIndex.replace(
 "import express from 'express';",
 "import express from 'express';\nimport compression from 'compression';"
);

authIndex = authIndex.replace(
 "// CORS (tighten in production)",
 "app.use(compression());\n\n// CORS (tighten in production)"
);

authIndex = authIndex.replace(
 "// Liveness\napp.get('/health/live', (_req, res) => res.json({ status: 'alive' }));",
 "import { healthRoutes } from './routes/health.js';\napp.use('/health', healthRoutes);"
);

authIndex = authIndex.replace(
 "app.listen(PORT, () => {\n console.log(`[auth] @nova/auth listening on :${PORT}`);\n});",
 "const server = app.listen(PORT, () => { console.log(`[auth] @nova/auth listening on :${PORT}`); }); server.timeout('30s'); server.setTimeout(30 * 1000);"
);

fs.writeFileSync(authIndexPath, authIndex);
console.log("Fixed: " + authIndexPath);

const rtsPath = "services/realtime-gateway/src/server.ts";
let rts = fs.readFileSync(rtsPath, "utf8");

rts = rts.replace(
 "import { createRealtimeGateway } from './gateway';",
 "import express from 'express';\nimport cors from 'cors';\nimport compression from 'compression';\nimport { createRealtimeGateway } from './gateway';\nimport { healthRoutes } from './routes/health.js';"
);

rts = rts.replace(
 "const server = http.createServer((_req, res) => {\n res.writeHead(200, { 'Content-Type': 'application/json' });\n res.end(JSON.stringify({ status: 'ok', service: 'realtime-gateway', timestamp: new Date().toISOString() }));\n});",
 "const app = express();\napp.use(cors({ origin: '*' }));\napp.use(compression());\napp.use('/health', healthRoutes);\nconst server = http.createServer(app);"
);

rts = rts.replace(
 "server.listen(PORT, () => {\n console.log(`[realtime-gateway] listening on :${PORT}`);\n});",
 "server.timeout('30s'); server.setTimeout(30 * 1000); server.listen(PORT, () => { console.log(`[realtime-gateway] listening on :${PORT}`); });"
);

fs.writeFileSync(rtsPath, rts);
console.log("Fixed: " + rtsPath);
