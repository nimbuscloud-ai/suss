// Lambda producer that sends order messages to ORDERS_QUEUE_URL.
// Pairs against OrderConsumer (which receives from the same queue).

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
      MessageBody: JSON.stringify(event.order),
    }),
  );
  return { ok: true };
}
