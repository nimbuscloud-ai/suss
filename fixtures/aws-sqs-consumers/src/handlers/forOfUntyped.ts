// A loop over a batch the handler types in place, keeping the body in a name.

import { save } from "../lib/ledger";

import type { Context } from "aws-lambda";

export async function handler(
  event: { Records: Array<{ body: string }> },
  context: Context,
): Promise<void> {
  for (const record of event.Records) {
    const order = JSON.parse(record.body) as { id: string };
    await save(order.id, context.awsRequestId);
  }
}
