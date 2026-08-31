/**
 * Sends `data.invoiceId`, the same field the worker on this queue
 * reads. Nothing should be reported here.
 */

import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({});

export async function handler(event: {
  invoiceId: string;
}): Promise<{ ok: boolean }> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.VOIDED_QUEUE_URL,
      MessageBody: JSON.stringify({
        subject: "billing.invoiceVoided",
        data: { invoiceId: event.invoiceId },
      }),
    }),
  );
  return { ok: true };
}
