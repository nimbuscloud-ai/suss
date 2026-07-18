// Lambda producer that publishes OrderPlaced events to the bus named by
// ORDER_EVENT_BUS_NAME (which the SAM template Refs to OrderEventBus).
//
// The Detail payload uses an inline object literal so the recognizer can
// extract the producer-side field set. Only OrderPlaced is published;
// the OrderShipped detail-type the same rule routes has no producer, so
// it surfaces as a consumer-orphan in the pairing check.

import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

const eventBridge = new EventBridgeClient({});

interface Order {
  id: string;
  total: number;
}

export async function handler(event: { order: Order }): Promise<{
  ok: boolean;
}> {
  await eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: process.env.ORDER_EVENT_BUS_NAME,
          Source: "orders.service",
          DetailType: "OrderPlaced",
          Detail: JSON.stringify({
            id: event.order.id,
            total: event.order.total,
          }),
        },
      ],
    }),
  );
  return { ok: true };
}
