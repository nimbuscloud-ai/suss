// The middleware the reports app registers. No route on that app reads
// the tenant header, and this is where its 401 comes from.

import type { NextFunction, Request, Response } from "express";

export function requireTenant(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.headers["x-tenant-id"]) {
    res.status(401).json({ error: "tenant required" });
    return;
  }

  next();
}
