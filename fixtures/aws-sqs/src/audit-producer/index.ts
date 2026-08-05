// Lambda producer whose queue URL sits in a const in another file.
// The send names its channel through resolution, not at the call.

import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

import { AUDIT_QUEUE_URL } from "./config";

const sqs = new SQSClient({});

export async function handler(event: { id: string }): Promise<{
  ok: boolean;
}> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: AUDIT_QUEUE_URL,
      MessageBody: JSON.stringify({ id: event.id }),
    }),
  );
  return { ok: true };
}
