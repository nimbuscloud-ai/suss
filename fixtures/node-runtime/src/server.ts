// An HTTP service whose handlers hand work to the runtime. A callback
// written in place at the top of a handler becomes a unit of its own;
// one written inside another arrow stays part of the handler.

import express, { type Request, type Response } from "express";

import { requireEnv } from "./requireEnv.js";

const app = express();

app.post("/reports", (_req, res) => {
  setTimeout(() => {
    console.log("report queued");
  }, 100);
  setTimeout(() => {
    process.stdout.write("second timer\n");
  });
  setImmediate(() => {
    console.error("accepted");
  });
  queueMicrotask(() => {
    console.log("microtask");
  });
  process.nextTick(() => {
    console.warn("tick");
  });
  res.status(202).json({ queued: true });
});

app.get("/health", async (_req, res) => {
  await Promise.resolve().then(() => {
    setTimeout(() => {
      console.log("late");
    }, 5);
  });
  res.json({ ok: true, region: process.env.AWS_REGION ?? "local" });
});

function heartbeat(_req: Request, res: Response): void {
  setInterval(function beat() {
    console.info("heartbeat", requireEnv("HEARTBEAT_TARGET"));
  }, 1000);
  res.sendStatus(204);
}

app.post("/heartbeat", heartbeat);

app.listen(Number(process.env.PORT ?? 3000));
