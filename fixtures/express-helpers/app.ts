// An Express service that hands its app to three functions of its own.
// Two of them register routes on it and one is handed something else
// entirely, which is the shape a receiver check has to tell apart.

import express from "express";

import { registerCache } from "./cache";
import { registerCrud } from "./crud";
import { registerHealth } from "./health";

const app = express();

registerHealth(app);

registerCrud(app, "users", {
  list(_req, res) {
    res.json([{ id: 1 }]);
  },
  create(_req, res) {
    res.status(201).json({ id: 2 });
  },
});

registerCache({
  get(key, onHit) {
    onHit(key);
  },
});

app.get("/direct", (_req, res) => {
  res.json({ direct: true });
});

export default app;
