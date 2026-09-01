// The call sites, where the table and the operation are both literal.

import express from "express";

import { sendRequest } from "./signed";

declare const signer: Parameters<typeof sendRequest>[1];

const app = express();

app.get("/orders", async (_req, res) => {
  const found = await sendRequest(process.env.REGION ?? "", signer, "Query", {
    TableName: "orders-v1",
    IndexName: "byCustomer",
    KeyConditionExpression: "customerId = :c",
    ProjectionExpression: "orderId, total",
  });
  res.json(found);
});

app.post("/orders", async (req, res) => {
  await sendRequest(process.env.REGION ?? "", signer, "PutItem", {
    TableName: "orders-v1",
    Item: { orderId: { S: String(req.body.id) }, total: { N: "1" } },
  });
  res.status(201).json({ ok: true });
});

export default app;
