// Routes that respond early and write afterwards: a guard before the
// write, a check inside a loop of writes, and cleanup in a `finally`.
// The same routes are written in Python and Ruby beside this fixture.

import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import express from "express";

const dynamo = new DynamoDBClient({});
const app = express();

app.put("/items/:id", async (req, res) => {
  const found = await dynamo.send(
    new GetItemCommand({ TableName: "items", Key: { id: { S: req.params.id } } }),
  );
  if (!found.Item) {
    return res.status(404).json({ error: "not found" });
  }
  if (found.Item.owner?.S !== req.body.owner) {
    return res.status(403).json({ error: "not yours" });
  }
  await dynamo.send(
    new PutItemCommand({
      TableName: "items",
      Item: { id: { S: req.params.id }, title: { S: req.body.title } },
    }),
  );
  res.json({ ok: true });
});

app.post("/items", async (req, res) => {
  for (const id of req.body.ids) {
    if (!id) {
      return res.status(400).json({ error: "empty id" });
    }
    await dynamo.send(
      new PutItemCommand({ TableName: "items", Item: { id: { S: id } } }),
    );
  }
  await dynamo.send(
    new PutItemCommand({ TableName: "audit", Item: { id: { S: "bulk" } } }),
  );
  res.status(201).json({ ok: true });
});

app.delete("/items/:id", async (req, res) => {
  if (!req.params.id) {
    return res.status(400).json({ error: "no id" });
  }
  try {
    const found = await dynamo.send(
      new GetItemCommand({ TableName: "items", Key: { id: { S: req.params.id } } }),
    );
    if (!found.Item) {
      return res.status(404).json({ error: "not found" });
    }
    await dynamo.send(
      new DeleteItemCommand({ TableName: "items", Key: { id: { S: req.params.id } } }),
    );
    return res.json({ ok: true });
  } finally {
    await dynamo.send(
      new PutItemCommand({ TableName: "audit", Item: { id: { S: "delete" } } }),
    );
  }
});

export default app;
