// The call site a registration helper's config is written against. The
// helper is one of the project's own, so what it registers arrives
// through `-f express=express.json` beside this file.

import express from "express";

import { registerCrud } from "./crud";

const app = express();

registerCrud(app, "users", {
  list(_req, res) {
    res.json([{ id: 1 }]);
  },
});

export default app;
