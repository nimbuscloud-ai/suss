// A typed loop over the batch, destructuring the body behind a cast.

import { type Order, save } from "../lib/ledger";

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const { id, total: amount } = JSON.parse(record.body) as Order;
    await save(id, amount);
  }
}
