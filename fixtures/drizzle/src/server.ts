// Routes that call the queries, so the storage accesses sit under HTTP
// handlers as they do in an application.

import express from "express";

import { firstOrder, listUsers } from "./queries.js";
import { createUser, getUser, rename } from "./users.js";

const app = express();

app.get("/users", async (_req, res) => {
  res.json(await listUsers());
});

app.get("/users/:id", async (req, res) => {
  const rows = await getUser(Number(req.params.id));
  if (rows === undefined) {
    res.status(404).end();
    return;
  }
  res.json(rows);
});

app.post("/users", async (req, res) => {
  res.status(201).json(await createUser(req.body.email));
});

app.patch("/users/:id", async (req, res) => {
  res.json(await rename(Number(req.params.id), req.body.name));
});

app.get("/orders/first", async (_req, res) => {
  res.json(await firstOrder());
});

app.listen(3000);
