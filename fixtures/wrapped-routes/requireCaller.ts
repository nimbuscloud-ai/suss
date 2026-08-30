// The middleware the app registers, written in its own file, which is
// where most services put one.

import type { Context, Next } from "hono";

export const requireCaller = async (c: Context, next: Next) => {
  if (c.req.header("authorization") === undefined) {
    return c.json({ error: "unauthorized" }, 401);
  }

  await next();
};
