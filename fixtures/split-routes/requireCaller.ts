// The middleware app.ts registers for /v1/*, which is where the 401
// comes from for every route under that prefix.

import type { Context, Next } from "hono";

export const requireCaller = async (c: Context, next: Next) => {
  if (c.req.header("authorization") === undefined) {
    return c.json({ error: "unauthorized" }, 401);
  }

  await next();
};
