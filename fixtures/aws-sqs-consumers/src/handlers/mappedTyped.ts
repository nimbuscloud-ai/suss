// A callback over the batch, whose record the checker types from the event.

import { type Order, save } from "../lib/ledger";

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<void> {
  await Promise.all(
    event.Records.map(async (record) => {
      const order: Order = JSON.parse(record.body);
      await save(order.id);
    }),
  );
}
