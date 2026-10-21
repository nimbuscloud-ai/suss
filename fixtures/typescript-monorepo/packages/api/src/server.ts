import express from "express";

const app = express();

const orders = new Map<string, { id: string; total: number }>();

app.get("/status", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/orders/:id", (req, res) => {
  const order = orders.get(req.params.id);
  if (order === undefined) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.status(200).json({ id: order.id, total: order.total });
});

export default app;
