// Lambda consumer that processes order messages from OrdersQueue.
// Pairs against OrderProducer.
//
// Destructures `{ id, totalAmount }` from the parsed body — an
// intentional `total` vs `totalAmount` mismatch with the producer.
// The body-shape check should surface boundaryShapeMismatch
// (aspect: send) for the missing `totalAmount` field.

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<{ ok: boolean }> {
  for (const record of event.Records) {
    const { id, totalAmount } = JSON.parse(record.body);
    await processOrder(id, totalAmount);
  }
  return { ok: true };
}

async function processOrder(
  _id: unknown,
  _totalAmount: unknown,
): Promise<void> {
  // Stub — the integration test only cares about pairing, not
  // consumer downstream behaviour.
}
