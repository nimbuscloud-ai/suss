import { initServer } from "@ts-rest/express";

import { apiContract } from "../contract/index";

declare const db: {
  find(id: string): Promise<{ id: string; label: string } | null>;
};

const s = initServer();

export const internalResource = s.router(apiContract.internal, {
  fetchThing: async ({ params }) => {
    const row = await db.find(params.id);
    if (!row) {
      return { status: 404 as const, body: { error: "not found" } };
    }
    return { status: 200 as const, body: { id: row.id, label: row.label } };
  },
});
