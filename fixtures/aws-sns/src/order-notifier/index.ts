// Lambda that the OrderEvents topic triggers. The subscription in the
// template says which topic, so this signature does not say.

import type { SNSEvent } from "aws-lambda";

export async function handler(event: SNSEvent): Promise<{ ok: boolean }> {
  for (const record of event.Records) {
    const { id, total } = JSON.parse(record.Sns.Message);
    await notify(id, total);
  }
  return { ok: true };
}

async function notify(_id: unknown, _total: unknown): Promise<void> {
  // Stub: the integration test is about pairing, not about what the
  // notifier does downstream.
}
