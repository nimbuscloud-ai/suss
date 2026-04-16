// The consumer that breaks: handles 200 without checking body.status.
// Assumes 200 means the user is active and usable.

import { initClient } from "@ts-rest/core";
import { contract } from "./contract";

declare const baseUrl: string;

const client = initClient(contract, { baseUrl });

export async function loadUser(id: string) {
  const result = await client.getUser({ params: { id } });

  if (result.status === 404) {
    return null;
  }

  if (result.status === 200) {
    // BUG: assumes 200 means active user, never checks body.status
    return {
      displayName: result.body.name,
      email: result.body.email,
    };
  }

  throw new Error(`unexpected status ${result.status}`);
}
