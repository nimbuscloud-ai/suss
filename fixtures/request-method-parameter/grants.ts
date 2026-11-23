// Routes that call the helpers. Each passes its own method, except the
// list and audit routes, which leave it out and get the default.

import express from "express";

import { call, send } from "./httpClient";

const app = express();

app.get("/grants", async (_req, res) => {
  res.json(await send("https://api.example.com/grants"));
});

app.post("/grants", async (req, res) => {
  res.json(await send("https://api.example.com/grants", "POST", req.body));
});

app.delete("/grants/:id", async (req, res) => {
  res.json(await send(`https://api.example.com/grants/${req.params.id}`, "DELETE"));
});

app.put("/grants/:id", async (req, res) => {
  res.json(await call(`https://api.example.com/grants/${req.params.id}`, "put"));
});

app.get("/audit", async (_req, res) => {
  res.json(await call("https://api.example.com/audit"));
});
