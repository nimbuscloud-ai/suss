import { Router } from "express";

// Routes here skip the dispatch map entirely. The ALB health check
// hits /_health through the mount, as /api/orders/_health.
export const ordersRouter = Router();

ordersRouter.get("/_health", (_req, res) => {
  res.json({ ok: true });
});
