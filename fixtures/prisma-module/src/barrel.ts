// The same read, two hops from the package: the barrel re-exports the
// client the module below it built.

import { Hono } from "hono";

import { db } from "./lib/index.js";

const app = new Hono();

app.get("/barrel-users/:id", async (c) => {
  const user = await db.user.findUnique({
    where: { id: Number(c.req.param("id")) },
    select: { id: true, name: true },
  });
  return c.json({ user });
});

export default app;
