// Parses into a name and takes the fields apart a line later.

import { save } from "../lib/ledger";

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const parsed = JSON.parse(record.body);
    const { userId, services } = parsed;
    await save(userId, services);
  }
}
