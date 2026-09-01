// The same helper body as the single-app fixture beside this one. What
// changes is the caller: two of them, passing two different apps.

import type { Express } from "express";

export function registerHealth(target: Express): void {
  target.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
}
