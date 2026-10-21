// Handlers that schedule work through the wrappers, through the timer
// on a global object, and through node:timers imports.

import express from "express";
import { setTimeout as delay } from "node:timers/promises";

import { debounce, every, later, retry, sleep } from "./timers.js";
import { Batcher, shadowed, viaNodeTimers } from "./worker.js";

const app = express();
const batcher = new Batcher();

const flushSoon = debounce(() => {
  console.log("flushed");
}, 50);

app.post("/jobs", async (_req, res) => {
  later(() => {
    console.log("job started");
  }, 100);
  await sleep(10);
  flushSoon();
  res.status(202).end();
});

app.post("/poll", (_req, res) => {
  const stop = every(() => {
    process.stdout.write("polled\n");
  }, 1000);
  globalThis.setTimeout(stop, 10_000);
  res.sendStatus(204);
});

app.get("/slow", async (_req, res) => {
  await delay(250);
  const body = await retry(async () => {
    const response = await fetch("https://status.example.com/health");
    return response.json();
  }, 3);
  res.json(body);
});

app.post("/batch", (req, res) => {
  batcher.add(String(req.body.item));
  viaNodeTimers();
  shadowed();
  res.sendStatus(202);
});

app.get("/legacy", (_req, res) => {
  setTimeout("console.log('evaluated later')" as unknown as () => void, 5);
  res.end();
});

app.listen(Number(process.env.PORT ?? 3000));
