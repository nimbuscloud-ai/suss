// One helper, two calls. Following the helper's parameters back from
// here leaves the path with two values and the handler with two, so
// reading the helper once and filling it in per call is what gets both.

import express from "express";

import { registerCrud } from "./crud";

const app = express();

registerCrud(app, "users", {
  list(_req, res) {
    res.json([{ id: 1 }]);
  },
});

registerCrud(app, "orders", {
  list(_req, res) {
    res.json([{ id: 2 }]);
  },
});

export default app;
