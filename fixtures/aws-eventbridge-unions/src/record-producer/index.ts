// Builds the detail type from a field typed as three strings, so the
// send goes to one of three channels.

import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

const client = new EventBridgeClient({});

interface RecordChange {
  operation: "INSERT" | "UPDATE" | "DELETE";
  id: string;
}

export async function handler(event: RecordChange): Promise<{ ok: boolean }> {
  const eventType = `record.${event.operation.toLowerCase()}`;
  await client.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: process.env.DOMAIN_EVENT_BUS_NAME,
          DetailType: eventType,
          Detail: JSON.stringify({ id: event.id }),
        },
      ],
    }),
  );
  return { ok: true };
}
