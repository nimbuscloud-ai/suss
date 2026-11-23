// Two middleware in front of one route, each rejecting on a test of its
// own, and a handler that branches on what it read.

import express from "express";

import type { NextFunction, Request, Response } from "express";

declare const notes: {
  find(id: string): Promise<{ id: string; body: string } | null>;
};

declare function signedIn(req: Request): boolean;

declare function canEdit(req: Request): boolean;

const app = express();

function requireAccount(req: Request, res: Response, next: NextFunction) {
  if (!signedIn(req)) {
    return res.status(401).json({ error: "sign in first" });
  }
  next();
}

function requireEditor(req: Request, res: Response, next: NextFunction) {
  if (!canEdit(req)) {
    return res.status(403).json({ error: "editors only" });
  }
  next();
}

app.get(
  "/notes/:id",
  requireAccount,
  requireEditor,
  async (req: Request, res: Response) => {
    const note = await notes.find(req.params.id);
    if (!note) {
      return res.status(404).json({ error: "no such note" });
    }
    return res.status(200).json(note);
  },
);

export default app;
