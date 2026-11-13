// A promise timer imported under the global's own name. It takes the
// delay first and hands no callback over. It has a file of its own, since
// the import would bind the setTimeout the handlers in server.ts call.

import { setTimeout } from "node:timers/promises";

export async function waitBriefly(): Promise<void> {
  await setTimeout(10);
}
