// fixtures/fastify/handlers.ts — Fastify handler implementations
// Exercises: early return guard, nested condition, dependency call, default
// transition, and reply.redirect in both 1-arg and 2-arg forms.

import Fastify from "fastify";

declare const db: {
  findById(id: string): Promise<{
    id: string;
    name: string;
    role: string;
  } | null>;
};

const app = Fastify();

// GET /users/:id — exercises guards + dependency call + nested condition
app.get("/users/:id", async (request, reply) => {
  const { id } = request.params as { id: string };

  if (!id) {
    reply.code(400).send({ error: "missing id" });
    return;
  }

  const user = await db.findById(id);

  if (!user) {
    reply.code(404).send({ error: "not found" });
    return;
  }

  // Nested condition
  if (user.role === "admin") {
    reply.send({ ...user, admin: true });
    return;
  }

  reply.send(user);
});

// GET /old-profile — exercises redirect (1-arg form, no status code extractable)
app.get("/old-profile", (request, reply) => {
  reply.redirect("/profile");
});

// GET /moved — exercises redirect (2-arg form, status code at arg 0)
app.get("/moved", (request, reply) => {
  reply.redirect(301, "/new-location");
});

// GET /me — exercises bare-return path (Fastify serialises return value
// as the 200 response body). The early `return reply.code(401).send(...)`
// path stays a parameterMethodCall match; the trailing `return user`
// becomes a returnStatement match.
app.get("/me", async (request, reply) => {
  const id = (request.headers["x-user-id"] as string | undefined) ?? null;
  if (!id) {
    return reply.code(401).send({ error: "no auth" });
  }
  const user = await db.findById(id);
  if (!user) {
    return reply.code(404).send({ error: "not found" });
  }
  return user;
});

// GET /defaults — exercises bare object-literal return.
app.get("/defaults", () => {
  return { theme: "dark", locale: "en" };
});

export default app;
