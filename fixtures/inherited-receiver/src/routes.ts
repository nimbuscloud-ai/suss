import { Router } from "express";

import { CreateInvoice, VoidInvoice } from "./services";

const router = Router();

router.post("/invoices", async (req, res) => {
  await CreateInvoice.call({ amount: req.body.amount });
  res.status(201).json({});
});

router.post("/invoices/logged", async (req, res) => {
  await CreateInvoice.callLogged({ amount: req.body.amount });
  res.status(201).json({});
});

router.post("/invoices/:id/void", async (req, res) => {
  await VoidInvoice.call({ id: req.params.id });
  res.status(200).json({});
});

export default router;
