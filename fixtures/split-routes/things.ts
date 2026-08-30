// A route registered on the app the caller passed, so the middleware
// scoped to /v1/* in app.ts covers it.

import type { Hono } from "hono";

export function registerThings(app: Hono): void {
  app.get("/v1/things/:id", async (c) => {
    return c.json({ id: c.req.param("id") }, 200);
  });
}
