// A second app, whose route never touches the tenant header because the
// middleware registered around it is what checks for one.

import express from "express";

import { requireTenant } from "./requireTenant";

declare const reports: { list(id: string): Promise<{ id: string }[]> };

const app = express();

app.use(requireTenant);

app.get("/reports/:id", async (req, res) => {
  res.json(await reports.list(req.params.id));
});

export default app;
