// A Hono service whose 400, 401 and 500 are produced by code registered
// around the routes, so none of those statuses is anywhere in a handler.

import { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";

import { requireCaller } from "./requireCaller";
import { validationHook } from "./validationHook";

declare const store: {
  read(id: string): Promise<{ id: string; status: string } | null>;
  create(name: string): Promise<{ id: string; status: string }>;
};

// A factory with no body in this project, so what it returns cannot be
// read and every route on the app says so.
declare function pickMiddleware(): MiddlewareHandler;

// The hook is handed to the constructor rather than registered on the
// app, and it runs for every route.
const app = new OpenAPIHono({ defaultHook: validationHook });

app.use("/v1/*", requireCaller({ header: "authorization" }));
app.use(pickMiddleware());

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

app.post("/v1/tenants", async (c) => {
  const body = await c.req.json();

  if (typeof body.name !== "string") {
    throw new Error("name is required");
  }

  return c.json(await store.create(body.name), 201);
});

// Outside the middleware's pattern, so nothing asks this one for a
// caller and it returns 200 to anybody.
app.get("/health", (c) => {
  return c.json({ status: "ok" }, 200);
});

export default app;
