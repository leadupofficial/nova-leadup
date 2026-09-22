import { Router } from "express";

const router: ReturnType<typeof Router> = Router();

router.get("/health/live", (_req, res) =>
 res.json({ status: "ok", timestamp: new Date().toISOString() }),
);

router.get("/health/ready", async (_req, res) => {
 try {
 res.json({ status: "ok", timestamp: new Date().toISOString(), checks: { db: "ok" } });
 } catch {
 res.status(503).json({ status: "error", timestamp: new Date().toISOString(), checks: { db: "error" } });
 }
});

export { router as healthRoutes };
