// fixtures/ts-rest-client/consumer.ts — ts-rest client consumers
// Three functions exercising different coverage scenarios:
//   - loadUser: handles 200 + 404 (matches provider contract)
//   - loadUserMissingBranch: handles only 200 (provider also produces 404 → unhandledProviderCase)
//   - loadUserDeadBranch: handles 200 + 410 (provider never produces 410 → deadConsumerBranch)

import { initClient } from "@ts-rest/core";
import { contract } from "../ts-rest/contract";

declare const baseUrl: string;

const client = initClient(contract, { baseUrl });

export async function loadUser(id: string) {
  const result = await client.getUser({ params: { id } });
  if (result.status === 404) {
    return null;
  }
  if (result.status === 200) {
    return result.body;
  }
  throw new Error(`unexpected status ${result.status}`);
}

export async function loadUserMissingBranch(id: string) {
  const result = await client.getUser({ params: { id } });
  if (result.status === 200) {
    return result.body;
  }
  throw new Error("unexpected");
}

export async function loadUserDeadBranch(id: string) {
  const result = await client.getUser({ params: { id } });
  if (result.status === 200) {
    return result.body;
  }
  if (result.status === 410) {
    return { gone: true };
  }
  throw new Error("unexpected");
}
