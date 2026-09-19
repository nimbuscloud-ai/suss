// One route reading the User table through the generated client.

import { Hono } from "hono";

import { db } from "./db.js";

const app = new Hono();

app.get("/users/:id", async (c) => {
  const user = await db.user.findUnique({
    where: { id: Number(c.req.param("id")) },
    select: { id: true, email: true },
  });
  return c.json({ user });
});

export default app;
