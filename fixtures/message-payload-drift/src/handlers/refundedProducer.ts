/**
 * Sends `data.refundId` to the queue whose worker forwards the whole
 * message on. Nothing should be reported: the worker can read any
 * field of it somewhere the summary cannot see.
 */

import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({});

export async function handler(event: {
  refundId: string;
}): Promise<{ ok: boolean }> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.REFUNDED_QUEUE_URL,
      MessageBody: JSON.stringify({
        subject: "billing.invoiceRefunded",
        data: { refundId: event.refundId },
      }),
    }),
  );
  return { ok: true };
}
