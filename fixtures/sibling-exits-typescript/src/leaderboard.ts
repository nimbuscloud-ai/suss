// The leaderboard and the admin dump. The leaderboard doesn't read the
// golden count, and the dump reads every column without naming any.

import express from "express";

import { pool } from "./db.js";

const app = express();

app.get("/leaderboard", async (_req, res) => {
  const found = await pool.query(
    "SELECT name, games FROM players ORDER BY games DESC",
  );
  res.status(200).json(found.rows);
});

app.get("/admin/players", async (_req, res) => {
  const found = await pool.query("SELECT * FROM players");
  res.status(200).json(found.rows);
});

export default app;
