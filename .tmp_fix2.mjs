import fs from "fs";

const replacements = [
 // agent-orchestrator
 {
 file: "services/agent-orchestrator/src/index.ts",
 search: "import express from 'express';\nimport cors from 'cors';\nimport helmet from 'helmet';\nimport morgan from 'morgan';\nimport { agentRoutes } from './routes/agents';",
 replace: "import express from 'express';\nimport cors from 'cors';\nimport helmet from 'helmet';\nimport morgan from 'morgan';\nimport compression from 'compression';\nimport { healthRoutes } from './routes/health.js';\nimport { agentRoutes } from './routes/agents';",
 },
 {
 file: "services/agent-orchestrator/src/index.ts",
 search: "app.use(helmet());\napp.use(cors({ origin: ['https://nova.leadup.in', 'https://admin.nova.leadup.in'] }));\napp.use(express.json({ limit: '1mb' }));\napp.use(morgan('combined'));\n\napp.get('/health/live', (_req, res) => res.json({ status: 'alive', timestamp: new Date().toISOString() }));\napp.use('/api/agents', agentRoutes);\n\napp.listen(PORT, () => console.log(`[agent-orchestrator] listening on :${PORT}`));",
 replace: "app.use(helmet());\napp.use(cors({ origin: ['https://nova.leadup.in', 'https://admin.nova.leadup.in'] }));\napp.use(compression());\napp.use(express.json({ limit: '10mb' }));\napp.use(morgan('combined'));\napp.use('/health', healthRoutes);\napp.use('/api/agents', agentRoutes);\n\nconst server = app.listen(PORT, () => console.log(`[agent-orchestrator] listening on :${PORT}`));\nserver.timeout('30s');\nserver.setTimeout(30 * 1000);",
 },
 // admin
 {
 file: "services/admin/src/index.ts",
 search: "app.use(helmet());\napp.use(cors({ origin: ['https://nova.leadup.in', 'https://admin.nova.leadup.in'] }));\napp.use(express.json({ limit: '10mb' }));\napp.use(morgan('combined'));\n\napp.get('/health/live', (_req, res) => res.json({ status: 'alive', timestamp: new Date().toISOString() }));",
 replace: "app.use(helmet());\napp.use(cors({ origin: ['https://nova.leadup.in', 'https://admin.nova.leadup.in'] }));\napp.use(require('compression')());\napp.use(express.json({ limit: '10mb' }));\napp.use(morgan('combined'));\nimport { healthRoutes } from './routes/health.js';\napp.use('/health', healthRoutes);",
 },
 // integration-service
 {
 file: "services/integration-service/src/index.ts",
 search: "import express from 'express';\nimport cors from 'cors';\nimport helmet from 'helmet';\nimport morgan from 'morgan';\nimport { integrationRoutes } from './routes/integrations';",
 replace: "import express from 'express';\nimport cors from 'cors';\nimport helmet from 'helmet';\nimport morgan from 'morgan';\nimport compression from 'compression';\nimport { healthRoutes } from './routes/health.js';\nimport { integrationRoutes } from './routes/integrations';",
 },
 {
 file: "services/integration-service/src/index.ts",
 search: "app.use(helmet());\napp.use(cors({ origin: ['https://nova.leadup.in', 'https://admin.nova.leadup.in'] }));\napp.use(express.json({ limit: '2mb' }));\napp.use(morgan('combined'));\n\napp.get('/health/live', (_req, res) => res.json({ status: 'alive', timestamp: new Date().toISOString() }));\napp.use('/api/integrations', integrationRoutes);\n\napp.listen(PORT, () => {\n console.log(`[integration-service] listening on :${PORT}`);\n});",
 replace: "app.use(helmet());\napp.use(cors({ origin: ['https://nova.leadup.in', 'https://admin.nova.leadup.in'] }));\napp.use(compression());\napp.use(express.json({ limit: '10mb' }));\napp.use(morgan('combined'));\napp.use('/health', healthRoutes);\napp.use('/api/integrations', integrationRoutes);\n\nconst server = app.listen(PORT, () => {\n console.log(`[integration-service] listening on :${PORT}`);\n});\nserver.timeout('30s');\nserver.setTimeout(30 * 1000);",
 },
 // notification-service
 {
 file: "services/notification-service/src/server.ts",
 search: "import 'dotenv/config';\nimport { validateEnv } from './utils/env';\nvoid validateEnv();\nimport express from 'express';\nimport cors from 'cors';\nimport helmet from 'helmet';\nimport morgan from 'morgan';\nimport { notificationRoutes } from './routes/notifications';\nimport { sendNotification, triageNotifications } from './index';",
 replace: "import 'dotenv/config';\nimport { validateEnv } from './utils/env';\nvoid validateEnv();\nimport express from 'express';\nimport cors from 'cors';\nimport helmet from 'helmet';\nimport morgan from 'morgan';\nimport compression from 'compression';\nimport { notificationRoutes } from './routes/notifications';\nimport { sendNotification, triageNotifications } from './index';",
 },
 {
 file: "services/notification-service/src/server.ts",
 search: "app.use(helmet());\napp.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? '*' }));\napp.use(express.json({ limit: '2mb' }));\napp.use(morgan('combined'));\n\napp.get('/health', (_req, res) => {\n res.json({ status: 'ok', service: 'notification-service', timestamp: new Date().toISOString() });\n});",
 replace: "app.use(helmet());\napp.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? '*' }));\napp.use(compression());\napp.use(express.json({ limit: '10mb' }));\napp.use(morgan('combined'));\nimport { healthRoutes } from './routes/health.js';\napp.use('/health', healthRoutes);",
 },
 {
 file: "services/notification-service/src/server.ts",
 search: "app.listen(PORT, () => {\n console.log(`[notification-service] listening on :${PORT}`);\n});",
 replace: "const server = app.listen(PORT, () => {\n console.log(`[notification-service] listening on :${PORT}`);\n});\nserver.timeout('30s');\nserver.setTimeout(30 * 1000);",
 },
];

replacements.forEach(r => {
 let content = fs.readFileSync(r.file, "utf8");
 if (content.includes(r.search)) {
 content = content.replace(r.search, r.replace);
 fs.writeFileSync(r.file, content);
 console.log("Patched: " + r.file);
 } else {
 console.log("SKIP (pattern not found): " + r.file);
 }
});

// Voice-api - add server timeout
const voicePath = "services/voice-api/src/index.ts";
let voice = fs.readFileSync(voicePath, "utf8");
if (!voice.includes("server.timeout")) {
 voice = voice.replace(
 "app.listen(PORT, () => {\n console.log(`[voice-api] listening on :${PORT}`);\n});",
 "const server = app.listen(PORT, () => {\n console.log(`[voice-api] listening on :${PORT}`);\n});\nserver.timeout('30s');\nserver.setTimeout(30 * 1000);"
 );
 fs.writeFileSync(voicePath, voice);
 console.log("Patched: " + voicePath);
} else {
 console.log("DONE: " + voicePath);
}

// Worker - create src/index.ts if missing
const workerIndexPath = "services/worker/src/index.ts";
if (!fs.existsSync(workerIndexPath)) {
 fs.writeFileSync(workerIndexPath, `import 'dotenv/config';\nimport { validateEnv } from './utils/env';\nvoid validateEnv();\nimport express from 'express';\nimport cors from 'cors';\nimport helmet from 'helmet';\nimport compression from 'compression';\nimport { healthRoutes } from './routes/health.js';\nimport { startWorker } from './worker';\n\nconst app = express();\nconst PORT = process.env.PORT || 3009;\napp.use(helmet());\napp.use(cors({ origin: '*' }));\napp.use(compression());\napp.use(express.json({ limit: '10mb' }));\napp.use('/health', healthRoutes);\n\nconst server = app.listen(PORT, () => {\n console.log(\`[worker] HTTP listening on :\${PORT}\`);\n});\nserver.timeout('30s');\nserver.setTimeout(30 * 1000);\n\nstartWorker().catch(err => { console.error('[worker] Fatal:', err); process.exit(1); });\n\nexport default app;\n`);
 console.log("Created: " + workerIndexPath);
} else {
 console.log("Exists: " + workerIndexPath);
}

// Workers (plural) - add health
const workersIndexPath = "services/workers/src/index.ts";
let workersIndex = fs.readFileSync(workersIndexPath, "utf8");
if (!workersIndex.includes("health")) {
 workersIndex = workersIndex.replace(
 "import { Worker } from 'bullmq';\nimport { validateEnv } from './utils/env';\nvoid validateEnv();",
 "import { Worker } from 'bullmq';\nimport express from 'express';\nimport cors from 'cors';\nimport helmet from 'helmet';\nimport compression from 'compression';\nimport { validateEnv } from './utils/env';\nvoid validateEnv();\nimport { healthRoutes } from './routes/health.js';"
 );
 workersIndex = workersIndex.replace(
 "process.on('SIGINT', async () => {\n await transcriptionWorker.close();\n process.exit(0);\n});\n\nconsole.log('Worker service started');",
 "process.on('SIGINT', async () => {\n await transcriptionWorker.close();\n process.exit(0);\n});\n\nconst wApp = express();\nwApp.use(helmet());\nwApp.use(cors({ origin: '*' }));\nwApp.use(compression());\nwApp.use('/health', healthRoutes);\nconst wServer = wApp.listen(3011, () => console.log('[workers] HTTP listening on :3011'));\nwServer.timeout('30s');\nwServer.setTimeout(30 * 1000);\n\nconsole.log('Worker service started');"
 );
 fs.writeFileSync(workersIndexPath, workersIndex);
 console.log("Patched: " + workersIndexPath);
} else {
 console.log("DONE: " + workersIndexPath);
}

console.log("Batch 2 done.");
