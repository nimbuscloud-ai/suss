// An Express route that reads the tenant header itself and turns the
// request away when it is missing.

import express from "express";

declare const invoices: {
  find(tenant: string, id: string): Promise<{ id: string } | null>;
};

const app = express();

app.get("/invoices/:id", async (req, res) => {
  const tenant = req.headers["x-tenant-id"];

  if (!tenant) {
    res.status(401).json({ error: "tenant required" });
    return;
  }

  const invoice = await invoices.find(String(tenant), req.params.id);

  if (!invoice) {
    res.status(404).json({ error: "not found" });
    return;
  }

  res.json(invoice);
});

export default app;
