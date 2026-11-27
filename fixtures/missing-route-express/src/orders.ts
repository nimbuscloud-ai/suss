import { Router } from "express";

export const ordersRouter = Router();

// Renamed from `summary`, and the order panel still calls the old name.
ordersRouter.get("/:id/totals", (req, res) => {
  res.json({ id: req.params.id, total: 42 });
});
