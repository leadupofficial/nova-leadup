import { Router } from "express";

const router: ReturnType<typeof Router> = Router();

router.get("/health/live", (_req, res) =>
	res.json({ status: "ok", timestamp: new Date().toISOString() }),
);

router.get("/health/ready", async (_req, res) => {
	try {
		const checks: Record<string, string> = {
			config: "ok",
			providers: "ok",
		};

		if (!process.env.ELEVENLABS_API_KEY && !process.env.SARVAM_API_KEY) {
			checks.providers = "degraded";
		}

		res.json({
			status: "ok",
			timestamp: new Date().toISOString(),
			uptime: process.uptime(),
			checks,
		});
	} catch (error) {
		console.error("[VoiceAPI] Health check failed:", error);
		res.status(503).json({
			status: "error",
			timestamp: new Date().toISOString(),
			checks: { providers: "error" },
		});
	}
});

router.get("/healthz", (_req, res) =>
	res.json({ status: "ok", service: "voice-api", uptime: process.uptime() }),
);

export { router as healthRoutes };
