// Hands the parsed body on whole.

import { save } from "../lib/ledger";

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    await save(JSON.parse(record.body));
  }
}
