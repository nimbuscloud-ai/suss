// Producer that sends to ORPHAN_QUEUE_URL — but no Lambda is wired
// as a consumer in the template. Should surface as a producer-with-
// no-consumer finding.

import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({});

export async function handler(event: { payload: unknown }): Promise<{
  ok: boolean;
}> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.ORPHAN_QUEUE_URL,
      MessageBody: JSON.stringify(event.payload),
    }),
  );
  return { ok: true };
}
