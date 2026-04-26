// Lambda producer that sends order messages to ORDERS_QUEUE_URL.
// Pairs against OrderConsumer (which receives from the same queue).
//
// Body shape uses an inline object literal so the recognizer can
// extract the producer-side field set ({ id, total }) for body-shape
// pairing. The consumer destructures `{ id, totalAmount }`, an
// intentional `total` vs `totalAmount` mismatch the body-shape check
// surfaces as a boundaryShapeMismatch finding.

import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({});

interface Order {
  id: string;
  total: number;
}

export async function handler(event: { order: Order }): Promise<{
  ok: boolean;
}> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.ORDERS_QUEUE_URL,
      MessageBody: JSON.stringify({
        id: event.order.id,
        total: event.order.total,
      }),
    }),
  );
  return { ok: true };
}
