// fixtures/hono/api.ts
//
// Hono routes covering the response methods the pack recognizes: a guard
// returning early, a second guard, a body-carrying success, a text
// response with an explicit status, and a redirect taking its default.

import { Hono } from "hono";

const app = new Hono();

app.get("/users/:id", async (c) => {
  const user = await findUser(c.req.param("id"));

  if (!user) {
    return c.json({ error: "not found" }, 404);
  }

  if (user.deletedAt) {
    return c.json({ error: "gone" }, 410);
  }

  return c.json({ id: user.id, name: user.name });
});

app.post("/users", async (c) => {
  const body = await c.req.json();

  if (!body.name) {
    return c.text("name is required", 400);
  }

  return c.json({ id: "new", name: body.name }, 201);
});

app.get("/legacy/:id", (c) => {
  return c.redirect(`/users/${c.req.param("id")}`);
});

declare function findUser(
  id: string,
): Promise<{ id: string; name: string; deletedAt: string | null } | null>;

export default app;
