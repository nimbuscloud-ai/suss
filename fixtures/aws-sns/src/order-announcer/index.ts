// Lambda that publishes order events to ORDER_EVENTS_TOPIC_ARN.
// OrderNotifier subscribes to the same topic, so the two pair.

import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";

const sns = new SNSClient({});

interface Order {
  id: string;
  total: number;
}

export async function handler(event: { order: Order }): Promise<{
  ok: boolean;
}> {
  await sns.send(
    new PublishCommand({
      TopicArn: process.env.ORDER_EVENTS_TOPIC_ARN,
      Subject: "OrderPlaced",
      Message: JSON.stringify({
        id: event.order.id,
        total: event.order.total,
      }),
    }),
  );
  return { ok: true };
}
