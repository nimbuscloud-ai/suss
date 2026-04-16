// The motivating example from docs/motivation.md.
// Provider returns 200 with status: "deleted" for soft-deleted users,
// but consumer assumes 200 means active.

import { initContract } from "@ts-rest/core";

const c = initContract();

export const contract = c.router({
  getUser: {
    method: "GET",
    path: "/users/:id",
    responses: {
      200: c.type<{
        id: string;
        name: string;
        email: string;
        status: "active" | "deleted";
      }>(),
      404: c.type<{ error: string }>(),
    },
  },
});
