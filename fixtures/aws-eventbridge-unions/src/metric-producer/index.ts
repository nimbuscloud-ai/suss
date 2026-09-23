// Builds the detail type from a union of twenty names, more than a send
// is spelled out for, so the channel keeps a hole.

import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

const client = new EventBridgeClient({});

type MetricName =
  | "m01"
  | "m02"
  | "m03"
  | "m04"
  | "m05"
  | "m06"
  | "m07"
  | "m08"
  | "m09"
  | "m10"
  | "m11"
  | "m12"
  | "m13"
  | "m14"
  | "m15"
  | "m16"
  | "m17"
  | "m18"
  | "m19"
  | "m20";

export async function handler(name: MetricName): Promise<{ ok: boolean }> {
  await client.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: process.env.DOMAIN_EVENT_BUS_NAME,
          DetailType: `metric.${name}`,
          Detail: JSON.stringify({ name }),
        },
      ],
    }),
  );
  return { ok: true };
}
