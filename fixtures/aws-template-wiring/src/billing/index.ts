// Target of BillingRule, whose source no producer here sends from.

export async function handler(event: { detail: unknown }): Promise<void> {
  void event.detail;
}
