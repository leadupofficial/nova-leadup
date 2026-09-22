import fs from "fs";

const fixes = [
 {
 file: "services/api/src/server.ts",
 match: /const server = app\.listen\(PORT, \(\) => \{[^}]+\}\);/,
 replace: (m) => m + " as any;",
 },
 {
 file: "services/auth/src/index.ts",
 match: /const server = app\.listen\(PORT, \(\) => \{[^}]+\}\);/,
 replace: (m) => m + " as any;",
 },
 {
 file: "services/realtime-gateway/src/server.ts",
 match: "const server = http.createServer(app);",
 replace: "const server = http.createServer(app) as any;",
 },
 {
 file: "services/agent-orchestrator/src/index.ts",
 match: /const server = app\.listen\(PORT, \(\) => .+?\);/,
 replace: (m) => m + " as any;",
 },
 {
 file: "services/integration-service/src/index.ts",
 match: /const server = app\.listen\(PORT, \(\) => \{[^}]+\}\);/,
 replace: (m) => m + " as any;",
 },
 {
 file: "services/notification-service/src/server.ts",
 match: /const server = app\.listen\(PORT, \(\) => \{[^}]+\}\);/,
 replace: (m) => m + " as any;",
 },
 {
 file: "services/worker/src/index.ts",
 match: /const server = app\.listen\(PORT, \(\) => \{[^}]+\}\);/,
 replace: (m) => m + " as any;",
 },
 {
 file: "services/workflow-engine/src/index.ts",
 match: "const wfServer = wfApp.listen(WF_PORT, () => console.log(`[workflow-engine] HTTP listening on :${WF_PORT}`));",
 replace: "const wfServer = wfApp.listen(WF_PORT, () => console.log(`[workflow-engine] HTTP listening on :${WF_PORT}`)) as any;",
 },
 {
 file: "services/voice-api/src/index.ts",
 match: /const server = app\.listen\(PORT, \(\) => \{[^}]+\}\);/,
 replace: (m) => m + " as any;",
 },
];

fixes.forEach((f) => {
 let content = fs.readFileSync(f.file, "utf8");
 if (typeof f.match === "string") {
 if (content.includes(f.match)) {
 content = content.replace(f.match, f.replace);
 fs.writeFileSync(f.file, content);
 console.log("Fixed: " + f.file);
 } else {
 console.log("SKIP: " + f.file);
 }
 } else {
 const m = content.match(f.match);
 if (m) {
 content = content.replace(f.match, f.replace(m[0]));
 fs.writeFileSync(f.file, content);
 console.log("Fixed: " + f.file);
 } else {
 console.log("SKIP: " + f.file);
 }
 }
});
