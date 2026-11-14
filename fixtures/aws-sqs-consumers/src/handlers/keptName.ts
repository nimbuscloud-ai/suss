// Keeps the parsed body in a name and reads its fields off that name,
// marking it seen and checking a flag on the way.

import { save } from "../lib/ledger";

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const order = JSON.parse(record.body);
    order.seenAt = Date.now();
    if (order.priority) {
      await save(order.id, order["kind"], order.lines.length);
    }
  }
}
