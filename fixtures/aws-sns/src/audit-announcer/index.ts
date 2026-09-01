// Lambda that publishes two audit records in one batch to AuditEvents.
// Nothing subscribes to that topic, so both publishes are orphans.

import { PublishBatchCommand, SNSClient } from "@aws-sdk/client-sns";

const sns = new SNSClient({});

export async function handler(event: {
  orderId: string;
}): Promise<{ ok: boolean }> {
  await sns.send(
    new PublishBatchCommand({
      TopicArn: process.env.AUDIT_EVENTS_TOPIC_ARN,
      PublishBatchRequestEntries: [
        { Id: "opened", Message: JSON.stringify({ id: event.orderId }) },
        { Id: "closed", Message: JSON.stringify({ id: event.orderId }) },
      ],
    }),
  );
  return { ok: true };
}
