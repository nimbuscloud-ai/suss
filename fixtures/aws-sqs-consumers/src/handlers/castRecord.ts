// Reads the body through a cast of the loop's record.

import { save } from "../lib/ledger";

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const { id } = JSON.parse((record as any).body);
    await save(id);
  }
}
