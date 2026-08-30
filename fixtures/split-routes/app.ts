// A Hono service that builds its apps inside a factory and registers on
// them from two other files, which is how a service outgrows one file.
// Nothing here is at the top level, and the routes are two files away.

import { Hono } from "hono";

import { requireCaller } from "./requireCaller";
import { registerThings } from "./things";
import { mountUsers } from "./users";

export function build(): Hono {
  const root = new Hono();
  const api = new Hono();

  api.use("/*", requireCaller);

  registerThings(api);
  mountUsers(api);

  root.route("/api", api);

  return root;
}
