// fixtures/hono/api.ts
//
// Hono routes covering the response methods the pack recognizes: a guard
// returning early, a second guard, a body-carrying success, a text
// response with an explicit status, and a redirect taking its default.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

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

app.delete("/users/:id", async (c) => {
  const user = await findUser(c.req.param("id"));
  if (!user) {
    // The status rides the constructor's first argument.
    throw new HTTPException(404, { message: "no such user" });
  }
  return c.json({ deleted: user.id });
});

app.post("/users/:id/retries", async (c) => {
  const user = await findUser(c.req.param("id"));
  if (!user) {
    // The first argument is a count; the class carries no status.
    throw new RetryBudgetExceeded(503, "no attempts left");
  }
  return c.json({ retried: user.id });
});

class RetryBudgetExceeded extends Error {
  constructor(attemptsUsed: number, message: string) {
    super(message);
    void attemptsUsed;
  }
}

declare function findUser(
  id: string,
): Promise<{ id: string; name: string; deletedAt: string | null } | null>;

export default app;
