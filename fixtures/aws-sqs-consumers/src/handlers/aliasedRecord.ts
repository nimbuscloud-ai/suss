// Hands each record to a helper typed with the project's alias.

import { save } from "../lib/ledger";
import { readQueued } from "../lib/readQueued";

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    await save(readQueued(record));
  }
}
