// The middleware the orders app registers. It checks the caller's token
// and puts the token's claims on the request, so a route reads the
// tenant from there and never from anything the caller wrote.

import type { NextFunction, Request, Response } from "express";

declare function verifyToken(header: string): { tenantId: string } | null;

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const claims = verifyToken(String(req.headers.authorization ?? ""));
  if (claims === null) {
    res.status(401).json({ error: "sign in first" });
    return;
  }

  req.auth = claims;
  next();
}
