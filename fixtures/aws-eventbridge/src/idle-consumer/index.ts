// Lambda target of the disabled IdleRule. The handler exists to back
// the rule's CodeUri; the consumer summaries come from the CFN
// template, and the checker reports them disabled rather than orphaned.

interface OrderEvent {
  "detail-type": string;
  detail: { id: string };
}

export async function handler(event: OrderEvent): Promise<{ ok: boolean }> {
  void event.detail.id;
  return { ok: true };
}
