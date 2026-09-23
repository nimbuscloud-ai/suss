// Builds the detail type from a type alias declared in another file.

import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

import type { ReportPeriod } from "./periods";

const client = new EventBridgeClient({});

export async function handler(period: ReportPeriod): Promise<{ ok: boolean }> {
  await client.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: process.env.DOMAIN_EVENT_BUS_NAME,
          DetailType: `report.${period}`,
          Detail: JSON.stringify({ period }),
        },
      ],
    }),
  );
  return { ok: true };
}
