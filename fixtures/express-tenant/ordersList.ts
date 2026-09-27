// A third app, whose orders query is scoped to the tenant in the
// caller's token. The middleware registered around the route is what
// puts the token's claims on the request.

import express from "express";
import { Pool } from "pg";

import { authenticate } from "./authenticate";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = express();

app.use(authenticate);

app.get("/orders", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, total FROM orders WHERE tenant_id = $1",
    [req.auth.tenantId],
  );
  res.json(rows);
});

export default app;
