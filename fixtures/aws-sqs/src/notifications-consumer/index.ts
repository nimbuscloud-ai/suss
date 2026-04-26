// Lambda consumer wired to NotificationsQueue via SAM Events:SQS.
// No code in the fixture sends to NotificationsQueue, so this should
// surface as "consumer never receives messages" — a declared
// integration with no producer behind it.

interface SQSEvent {
  Records: Array<{ body: string }>;
}

export async function handler(event: SQSEvent): Promise<{ ok: boolean }> {
  for (const record of event.Records) {
    const notification = JSON.parse(record.body);
    void notification;
  }
  return { ok: true };
}
