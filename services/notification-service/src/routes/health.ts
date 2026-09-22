import { Router } from "express";
import type { Request, Response } from "express";

const router: ReturnType<typeof Router> = Router();
const startTime = Date.now();

function getUptimeSeconds(): number {
	return Math.floor((Date.now() - startTime) / 1000);
}

router.get("/health", (_req: any, res: any) =>
	res.json({ status: "ok", timestamp: new Date().toISOString(), uptime: getUptimeSeconds() }),
);

router.get("/health/live", (_req: any, res: any) =>
	res.json({ status: "alive", timestamp: new Date().toISOString(), uptime: getUptimeSeconds() }),
);

router.get("/health/ready", async (_req: any, res: any) => {
	let dbStatus: "up" | "down" = "down";
	let redisStatus: "up" | "down" = "down";
	let storageStatus: "up" | "down" = "down";
	let aiStatus: "up" | "down" | "disabled" = "disabled";

	try {
		const { getPool } = await import("../db.js");
		await getPool().query("SELECT 1");
		dbStatus = "up";
	} catch (err) {
		console.error("[health] database check failed:", err instanceof Error ? err.message : String(err));
	}

	try {
		const { getRedisClient } = await import("../redis.js");
		const redis = getRedisClient();
		await redis.ping();
		redisStatus = "up";
	} catch {
		console.warn("[health] redis check failed");
	}

	try {
		const { getStorageClient } = await import("../storage.js");
		const s3 = getStorageClient();
		await s3.listBuckets().promise();
		storageStatus = "up";
	} catch {
		console.warn("[health] storage check failed");
	}

	try {
		if (process.env.ANTHROPIC_API_KEY) {
			aiStatus = "up";
		}
	} catch {
		aiStatus = "down";
	}

	const overall = dbStatus === "up" && redisStatus === "up" ? "ready" : "degraded";
	const statusCode = overall === "ready" ? 200 : 503;

	res.status(statusCode).json({
		status: overall,
		timestamp: new Date().toISOString(),
		uptime: getUptimeSeconds(),
		checks: { db: dbStatus, redis: redisStatus, storage: storageStatus, aiService: aiStatus },
	});
});

export { router as healthRoutes };
