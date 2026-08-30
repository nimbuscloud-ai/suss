// A sub-router built and mounted here, on the app the caller passed, so
// the route it declares serves /v1/users/:id.

import { Hono } from "hono";

export function mountUsers(app: Hono): void {
  const users = new Hono();

  users.get("/:id", async (c) => {
    return c.json({ id: c.req.param("id") }, 200);
  });

  app.route("/v1/users", users);
}
