/** Where the refunded worker's message ends up. */
export async function recordRefund(message: {
  subject: string;
  data: Record<string, unknown>;
}): Promise<void> {
  if (typeof message.data.ledgerEntryId !== "string") {
    throw new Error("refund message has no ledger entry");
  }
}
