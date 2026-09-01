// Spelled like a registration and serving no request. The file imports
// express for its request types and calls `.get` on what it was passed,
// so only the receiver tells this apart from the two helpers beside it.

import type { Request, Response } from "express";

interface Cache {
  get(key: string, onHit: (req: Request, res: Response) => void): void;
}

export function registerCache(cache: Cache): void {
  cache.get("/health", (_req, res) => {
    res.json({ cached: true });
  });
}
