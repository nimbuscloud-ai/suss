// Two admin routes that each record who did what in audit_log. The
// suspend route writes the row on every branch past the admin check.
// The delete route skips it when the user is not found.

import express from "express";

import { pool } from "./db.js";

const app = express();

app.delete("/admin/users/:id", async (req, res) => {
  const actor = req.headers["x-actor-id"];
  if (!actor) {
    res.status(403).json({ error: "admins only" });
    return;
  }

  const found = await pool.query("SELECT id FROM users WHERE id = $1", [
    req.params.id,
  ]);
  if (found.rowCount === 0) {
    res.status(404).json({ error: "no such user" });
    return;
  }

  await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
  await pool.query(
    "INSERT INTO audit_log (actor_id, action) VALUES ($1, $2)",
    [actor, "delete-user"],
  );
  res.status(200).json({ deleted: req.params.id });
});

app.post("/admin/users/:id/suspend", async (req, res) => {
  const actor = req.headers["x-actor-id"];
  if (!actor) {
    res.status(403).json({ error: "admins only" });
    return;
  }

  const updated = await pool.query(
    "UPDATE users SET suspended = true WHERE id = $1",
    [req.params.id],
  );
  await pool.query(
    "INSERT INTO audit_log (actor_id, action) VALUES ($1, $2)",
    [actor, "suspend-user"],
  );
  if (updated.rowCount === 0) {
    res.status(404).json({ error: "no such user" });
    return;
  }

  res.status(200).json({ suspended: req.params.id });
});

export default app;
