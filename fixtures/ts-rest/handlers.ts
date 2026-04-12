// fixtures/ts-rest/handlers.ts — ts-rest handler implementations
// Exercises: early returns, nested conditions, dependency calls, default transition

import { initServer } from "@ts-rest/express";
import { contract } from "./contract";

declare const db: {
  findById(id: string): Promise<{
    id: string;
    name: string;
    email: string;
    deletedAt: string | null;
  } | null>;
  createUser(data: {
    name: string;
    email: string;
  }): Promise<{ id: string }>;
};

const s = initServer();

export const router = s.router(contract, {
  // getUser: exercises early return guard, nested condition, dependency call
  getUser: async ({ params }) => {
    // Guard: missing id
    if (!params.id) {
      return { status: 404 as const, body: { error: "missing id" } };
    }

    const user = await db.findById(params.id);

    // Guard: user not found
    if (!user) {
      return { status: 404 as const, body: { error: "not found" } };
    }

    // Nested: soft-deleted check
    if (user.deletedAt) {
      return { status: 404 as const, body: { error: "deleted" } };
    }

    // Default: success
    return {
      status: 200 as const,
      body: { id: user.id, name: user.name, email: user.email },
    };
  },

  // createUser: exercises validation guard + dependency call
  createUser: async ({ body }) => {
    if (!body.name || !body.email) {
      return { status: 400 as const, body: { error: "missing fields" } };
    }

    const created = await db.createUser({ name: body.name, email: body.email });

    return { status: 201 as const, body: { id: created.id } };
  },
});
