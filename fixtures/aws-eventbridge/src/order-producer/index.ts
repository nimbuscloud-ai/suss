/**
 * Lambda producer that publishes OrderPlaced and OrderCancelled to the
 * bus named by ORDER_EVENT_BUS_NAME (which the SAM template Refs to
 * OrderEventBus). The Detail payload uses an inline object literal so
 * the recognizer can extract the producer-side field set. OrderShipped
 * has no producer, so it surfaces as a consumer-orphan; OrderCancelled
 * is routed only by the disabled IdleRule, so it is a producer orphan.
 */

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
  await eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: process.env.ORDER_EVENT_BUS_NAME,
          Source: "orders.service",
          DetailType: "OrderCancelled",
          Detail: JSON.stringify({
            id: event.order.id,
          }),
        },
      ],
    }),
  );
  return { ok: true };
}
