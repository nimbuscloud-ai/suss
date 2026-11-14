// Destructures a field whose name has to be quoted.

import { save } from "../lib/ledger";

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const { "order-id": orderId } = JSON.parse(record.body);
    await save(orderId);
  }
}
