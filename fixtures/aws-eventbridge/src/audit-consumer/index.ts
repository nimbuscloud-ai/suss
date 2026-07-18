// Lambda target of a SAM EventBridgeRule whose Pattern uses a
// detail-type prefix filter. v0 reduces routing to exact detail-type
// match, so the pattern is unresolvable and the pairing check surfaces
// this target as unpaired-unresolvable rather than dropping it.

interface AuditEvent {
  "detail-type": string;
  detail: unknown;
}

export async function handler(event: AuditEvent): Promise<{ ok: boolean }> {
  void event["detail-type"];
  return { ok: true };
}
