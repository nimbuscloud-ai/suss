// Sends a string enum member as the detail type.

import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

const client = new EventBridgeClient({});

enum AccountEvent {
  Opened = "account.opened",
  Closed = "account.closed",
}

export async function handler(event: {
  kind: AccountEvent;
  accountId: string;
}): Promise<{ ok: boolean }> {
  await client.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: process.env.DOMAIN_EVENT_BUS_NAME,
          DetailType: event.kind,
          Detail: JSON.stringify({ accountId: event.accountId }),
        },
      ],
    }),
  );
  return { ok: true };
}
