import { Router } from "express";

declare const orders: {
  insert(order: { sku: string; quantity: number }): Promise<{ id: string }>;
  findOpen(sku: string): Promise<{ id: string } | null>;
};

export const ordersRouter = Router();

ordersRouter.post("/orders", async (req, res) => {
  const { sku, quantity } = req.body;
  if (!sku || !quantity) {
    res.status(400).json({ error: "sku and quantity are required" });
    return;
  }
  const created = await orders.insert({ sku, quantity });
  res.status(201).json(created);
});
