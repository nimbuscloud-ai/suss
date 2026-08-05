import { Router } from "express";

// Room for routes that skip the dispatch map entirely, such as a
// liveness probe scoped to the orders app.
export const ordersRouter = Router();

ordersRouter.get("/_health", (_req, res) => {
  res.json({ ok: true });
});
