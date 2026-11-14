// Parses only to reject a body that is not JSON, and reads nothing.

import { save } from "../lib/ledger";

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const {} = JSON.parse(record.body);
    await save(record.messageId);
  }
}
