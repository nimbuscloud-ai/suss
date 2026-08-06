import type { Request, Response } from "express";

const orders = [
  { id: "123", status: "shipped" },
  { id: "456", status: "pending" },
];

export function listOrders(_req: Request, res: Response): void {
  res.json(orders);
}
