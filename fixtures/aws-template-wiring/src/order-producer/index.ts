// Publishes OrderPlaced, which OrdersRule matches, and InvoicePaid from
// a source BillingRule does not list.

import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

const eventBridge = new EventBridgeClient({});

export async function handler(event: {
  orderId: string;
}): Promise<{ ok: boolean }> {
  await eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: process.env.ORDER_EVENT_BUS_NAME,
          Source: "orders.service",
          DetailType: "OrderPlaced",
          Detail: JSON.stringify({ orderId: event.orderId }),
        },
      ],
    }),
  );
  await eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: process.env.ORDER_EVENT_BUS_NAME,
          Source: "billing.service",
          DetailType: "InvoicePaid",
          Detail: JSON.stringify({ orderId: event.orderId }),
        },
      ],
    }),
  );
  return { ok: true };
}
