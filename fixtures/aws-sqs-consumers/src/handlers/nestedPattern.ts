// Takes a nested object apart in the same pattern.

import { save } from "../lib/ledger";

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const {
      customer: { email },
      id,
    } = JSON.parse(record.body);
    await save(email, id);
  }
}
