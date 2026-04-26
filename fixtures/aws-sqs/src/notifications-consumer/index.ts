// Lambda consumer wired to NotificationsQueue via SAM Events:SQS.
// No code in the fixture sends to NotificationsQueue, so this should
// surface as messageBusConsumerOrphan — declared integration with no
// producer behind it. Body-shape pairing is unreachable without a
// producer to compare against.

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<{ ok: boolean }> {
  for (const record of event.Records) {
    const notification = JSON.parse(record.body);
    void notification;
  }
  return { ok: true };
}
