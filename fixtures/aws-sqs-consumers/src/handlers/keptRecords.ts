// Keeps the batch in a name before looping over it, with the event typed
// in place.

import { save } from "../lib/ledger";

import type { Context } from "aws-lambda";

export async function handler(
  event: { Records: Array<{ body: string }> },
  context: Context,
): Promise<void> {
  const records = event.Records;
  for (const message of records) {
    const { id } = JSON.parse(message.body);
    await save(id, context.awsRequestId);
  }
}
