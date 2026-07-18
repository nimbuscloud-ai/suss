// Lambda target of OrderEventsRule (OrderPlaced + OrderShipped). v0 has
// no consumer-side EventBridge body recognizer, so this handler exists
// to back the rule's CodeUri; the message-bus consumer summaries come
// from the CFN template, not from extracting this file.

interface OrderEvent {
  "detail-type": string;
  detail: { id: string; total: number };
}

export async function handler(event: OrderEvent): Promise<{ ok: boolean }> {
  void event.detail.id;
  return { ok: true };
}
