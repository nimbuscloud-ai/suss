// Takes each record apart in the loop's head.

import { save } from "../lib/ledger";

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<void> {
  for (const { body } of event.Records) {
    const { id } = JSON.parse(body);
    await save(id);
  }
}
