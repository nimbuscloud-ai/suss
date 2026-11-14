// Keeps the body in a name before parsing it.

import { save } from "../lib/ledger";

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const text = record.body;
    const { id } = JSON.parse(text);
    await save(id);
  }
}
