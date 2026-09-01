// A route written inside the helper's own body. The only mention of
// express here is the parameter's type, which Express spells with a
// different name from the constructor that builds the app.

import type { Express } from "express";

export function registerHealth(app: Express): void {
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
}
