// Two Express apps in one process, both handed to the same helper. The
// route the helper writes belongs to one of them and nothing here says
// which, so the run reports the call instead of picking an app.

import express from "express";

import { registerHealth } from "./health";

const app = express();
const admin = express();

registerHealth(app);
registerHealth(admin);

app.get("/direct", (_req, res) => {
  res.json({ direct: true });
});

export default app;
