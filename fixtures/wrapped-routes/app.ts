// A Hono service whose 401 and 500 are produced by code registered
// around the routes, so neither status is anywhere in the handler.

import { Hono } from "hono";

import { requireCaller } from "./requireCaller";

declare const store: {
  read(id: string): Promise<{ id: string; status: string } | null>;
};

const app = new Hono();

app.use("/v1/*", requireCaller);

app.onError((err, c) => {
  return c.json({ error: err.message }, 500);
});

app.get("/v1/tenants/:id", async (c) => {
  const tenant = await store.read(c.req.param("id"));

  if (tenant === null) {
    return c.json({ error: "not found" }, 404);
  }

  return c.json(tenant, 200);
});

export default app;
