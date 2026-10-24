// Target of a SAM EventBridgeRule that filters the source with a prefix.
// suss does not read prefix filters, so a send of OrderAudited only
// possibly reaches it, and it is reported (info) rather than paired.

interface AuditEvent {
  "detail-type": string;
  detail: unknown;
}

export async function handler(event: AuditEvent): Promise<{ ok: boolean }> {
  void event["detail-type"];
  return { ok: true };
}
