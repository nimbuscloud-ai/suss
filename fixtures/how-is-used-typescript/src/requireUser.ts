// The middleware every route that needs a user runs first. It refuses
// anyone without a token, so each route it wraps can end in a 401.

import type { NextFunction, Request, Response } from "express";

export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization) {
    res.status(401).json({ error: "Log in first" });
    return;
  }
  next();
}
