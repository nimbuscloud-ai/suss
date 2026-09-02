/**
 * Sends `id` at the top of the message, where the worker on the other
 * end reads `invoiceId`. Same drift as the paid queue, one level up.
 */

import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({});

export async function handler(event: {
  invoiceId: string;
}): Promise<{ ok: boolean }> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.SHIPPED_QUEUE_URL,
      MessageBody: JSON.stringify({
        subject: "billing.invoiceShipped",
        id: event.invoiceId,
      }),
    }),
  );
  return { ok: true };
}
