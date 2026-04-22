import { initServer } from "@ts-rest/express";

import { apiContract } from "../contract/index";

const s = initServer();

export const eventsResource = s.router(apiContract.events, {
  recordEvent: async ({ body }) => {
    if (!body) {
      return { status: 400 as const, body: { error: "missing body" } };
    }
    return { status: 204 as const, body: null };
  },
});
