/**
 * Reads `data.invoiceId`. The producer on this queue sends `data.id`,
 * so the check should report the read.
 */

import { makeSubjectHandler } from "../lib/makeSubjectHandler";

export const handler = makeSubjectHandler(
  { name: "paid-worker", subject: "billing.invoicePaid" as const },
  async (message) => {
    const invoiceId = message.data.invoiceId;
    if (typeof invoiceId !== "string") {
      throw new Error("invoice message has no invoiceId");
    }
    return { recorded: invoiceId };
  },
);
