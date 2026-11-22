import express from "express";

import { send } from "./outbound";
import { requireUser } from "./requireUser";
import { enabled, lookup } from "./settings";
import { syncQueue } from "./sync";

const app = express();

app.get("/orders", requireUser, async (req, res) => {
  const theme = await lookup(`user:${req.query.userId}:theme`);
  res.json({ theme });
});

app.get("/orders/:id", requireUser, async (req, res) => {
  const theme = await lookup(`user:${req.params.id}:theme`);
  res.json({ id: req.params.id, theme });
});

app.post("/orders", requireUser, async (req, res) => {
  if (req.body.total > 100) {
    await send("https://hooks.example.com/big-orders", "post");
  }
  await syncQueue.add("sync", { orderId: req.body.id });
  res.status(201).json({ total: req.body.total });
});

app.get("/account", async (_req, res) => {
  if (!(await enabled("site:accounts"))) {
    res.json({ banner: null });
    return;
  }
  res.json({ banner: await lookup("site:banner") });
});

app.put("/account", requireUser, async (req, res) => {
  await send(`https://hooks.example.com/accounts/${req.body.id}`);
  res.json({ id: req.body.id });
});

export default app;
