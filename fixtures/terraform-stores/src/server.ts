// The service entry. Discovery starts at the routes, and the store
// modules are summarized by being called from them.

import { Router } from "express";

import { archiveOrder } from "./orderArchive.js";
import { publishReport, readReport } from "./reportStore.js";
import { readSession, touchSession } from "./sessionCache.js";

const router = Router();

router.get("/report", async (req, res) => {
  res.json({ report: String(await readReport()) });
});

router.post("/report", async (req, res) => {
  await publishReport(req.body);
  res.status(204).end();
});

router.post("/orders/:id/archive", async (req, res) => {
  await archiveOrder(req.params.id, req.body);
  res.status(202).json({ accepted: true });
});

router.get("/sessions/:id", async (req, res) => {
  await touchSession(req.params.id);
  res.json({ session: await readSession(req.params.id) });
});

export default router;
