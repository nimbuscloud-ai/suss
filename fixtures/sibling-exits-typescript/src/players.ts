// A player's stats on screen, and the same stats as a CSV download.
// Both read the golden count from the players table.

import express from "express";

import { pool } from "./db.js";

const app = express();

app.get("/players/:id/stats", async (req, res) => {
  const found = await pool.query(
    "SELECT name, games, golden FROM players WHERE id = $1",
    [req.params.id],
  );
  const player = found.rows[0] as {
    name: string;
    games: number;
    golden: number;
  };
  if (!player) {
    res.status(404).json({ error: "no such player" });
    return;
  }
  res
    .status(200)
    .json({ name: player.name, games: player.games, golden: player.golden });
});

export default app;
