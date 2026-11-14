// Takes one field out and keeps the rest together.

import { save } from "../lib/ledger";

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const { id, ...details } = JSON.parse(record.body);
    await save(id, details);
  }
}
