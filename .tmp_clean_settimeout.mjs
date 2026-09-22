import fs from "fs";

const files = [
 "services/agent-orchestrator/src/index.ts",
 "services/integration-service/src/index.ts",
 "services/voice-api/src/index.ts",
 "services/worker/src/index.ts",
 "services/workers/src/index.ts",
 "services/workflow-engine/src/index.ts",
 "services/realtime-gateway/src/server.ts",
 "services/auth/src/index.ts",
 "services/api/src/server.ts",
 "services/notification-service/src/server.ts",
];

files.forEach((f) => {
 let content = fs.readFileSync(f, "utf8");
 content = content.replace(/server\.setTimeout\(30 \* 1000\);?\n?/g, "");
 fs.writeFileSync(f, content);
 console.log("Removed setTimeout from: " + f);
});
