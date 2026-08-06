import type { Request, Response } from "express";

// Stand-in for an orders store, keyed by id.
const orders: Record<string, { id: string; status: string }> = {
  "123": { id: "123", status: "shipped" },
  "456": { id: "456", status: "pending" },
};

export function getOrder(req: Request, res: Response): void {
  const { id } = req.params;
  const order = orders[id];

  if (order === undefined) {
    res.status(404).json({ error: "not found" });
    return;
  }

  res.json(order);
}
