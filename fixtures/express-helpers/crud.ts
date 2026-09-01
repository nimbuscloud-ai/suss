// A helper whose path and handlers both come from the call site. The
// path is built from argument 1 and each handler is read off argument
// 2, so reading these routes means following two parameters back.

import type { Express, Request, Response } from "express";

interface Handlers {
  list(req: Request, res: Response): void;
  create(req: Request, res: Response): void;
}

export function registerCrud(
  app: Express,
  name: string,
  handlers: Handlers,
): void {
  app.get(`/${name}`, handlers.list);
  app.post(`/${name}`, handlers.create);
}
