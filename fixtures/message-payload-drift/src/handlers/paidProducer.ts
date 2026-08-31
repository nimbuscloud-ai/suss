/**
 * Sends `data.id`, where the worker on the other end reads
 * `data.invoiceId`. The disagreement is the one this fixture exists
 * for: the consumer throws on every message and nothing in the types
 * says so, because the queue is a string on the wire.
 */

import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({});

export async function handler(event: {
  invoiceId: string;
}): Promise<{ ok: boolean }> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.PAID_QUEUE_URL,
      MessageBody: JSON.stringify({
        subject: "billing.invoicePaid",
        data: { id: event.invoiceId },
      }),
    }),
  );
  return { ok: true };
}
