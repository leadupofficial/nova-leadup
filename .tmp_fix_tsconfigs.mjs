import fs from "fs";

const services = [
 "agent-orchestrator",
 "integration-service",
 "worker",
 "realtime-gateway",
 "notification-service",
 "workflow-engine",
 "voice-api",
 "auth",
];

services.forEach((s) => {
 const p = `services/${s}/tsconfig.json`;
 if (!fs.existsSync(p)) {
 const tsc = {
 extends: "../../tsconfig.base.json",
 compilerOptions: {
 outDir: "./dist",
 rootDir: "./src",
 baseUrl: ".",
 paths: {
 "@nova/*": ["../../packages/*/src"],
 "express": ["../../node_modules/express"],
 "cors": ["../../node_modules/cors"],
 "helmet": ["../../node_modules/helmet"],
 "compression": ["../../node_modules/compression"],
 "morgan": ["../../node_modules/morgan"],
 },
 },
 include: ["src/**/*"],
 exclude: ["node_modules", "dist", "**/*.test.ts", "**/*.spec.ts"],
 };
 fs.writeFileSync(p, JSON.stringify(tsc, null, 2) + "\n");
 console.log("Created: " + p);
 } else {
 try {
 const existing = JSON.parse(fs.readFileSync(p, "utf8"));
 existing.compilerOptions = existing.compilerOptions || {};
 existing.compilerOptions.baseUrl = ".";
 existing.compilerOptions.paths = existing.compilerOptions.paths || {};
 const sharedPaths = {
 "@nova/*": ["../../packages/*/src"],
 "express": ["../../node_modules/express"],
 "cors": ["../../node_modules/cors"],
 "helmet": ["../../node_modules/helmet"],
 "compression": ["../../node_modules/compression"],
 "morgan": ["../../node_modules/morgan"],
 };
 Object.entries(sharedPaths).forEach(([k, v]) => {
 if (!existing.compilerOptions.paths[k]) existing.compilerOptions.paths[k] = v;
 });
 fs.writeFileSync(p, JSON.stringify(existing, null, 2) + "\n");
 console.log("Updated: " + p);
 } catch (err) {
 console.log("ERROR parsing " + p + ": " + err.message);
 }
 }
});
