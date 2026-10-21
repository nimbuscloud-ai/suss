// Every player's stats as a CSV file, for the weekly spreadsheet.

import express from "express";

import { pool } from "./db.js";

const app = express();

app.get("/players/export.csv", async (_req, res) => {
  const found = await pool.query("SELECT name, games, golden FROM players");
  const rows = found.rows as Array<{
    name: string;
    games: number;
    golden: number;
  }>;
  const lines = rows.map((row) => `${row.name},${row.games},${row.golden}`);
  res
    .status(200)
    .type("text/csv")
    .send(["name,games,golden", ...lines].join("\n"));
});

export default app;
