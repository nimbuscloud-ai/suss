// The provider that triggers the motivating example.
// Returns 200 for BOTH active and soft-deleted users, with a
// distinguishing status field in the body.

import { initServer } from "@ts-rest/express";
import { contract } from "./contract";

declare const db: {
  findById(id: string): Promise<{
    id: string;
    name: string;
    email: string;
    deletedAt: string | null;
  } | null>;
};

const s = initServer();

export const router = s.router(contract, {
  getUser: async ({ params }) => {
    const user = await db.findById(params.id);

    if (!user) {
      return { status: 404 as const, body: { error: "not found" } };
    }

    // The behavioral split: deleted users get 200 with status: "deleted"
    if (user.deletedAt) {
      return {
        status: 200 as const,
        body: {
          id: user.id,
          name: user.name,
          email: user.email,
          status: "deleted" as const,
        },
      };
    }

    return {
      status: 200 as const,
      body: {
        id: user.id,
        name: user.name,
        email: user.email,
        status: "active" as const,
      },
    };
  },
});
