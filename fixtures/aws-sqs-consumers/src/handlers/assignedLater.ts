// Parses into a name declared before the try, as code that logs a bad
// message does.

import { save } from "../lib/ledger";

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    let message: { id: string } | undefined;
    try {
      message = JSON.parse(record.body);
    } catch {
      message = undefined;
    }
    await save(message?.id);
  }
}
