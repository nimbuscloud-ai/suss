/**
 * Reads `data.invoiceId`, which the producer on this queue sends.
 */

import { makeSubjectHandler } from "../lib/makeSubjectHandler";

export const handler = makeSubjectHandler(
  { name: "voided-worker", subject: "billing.invoiceVoided" as const },
  async (message) => {
    const invoiceId = message.data.invoiceId;
    if (typeof invoiceId !== "string") {
      throw new Error("invoice message has no invoiceId");
    }
    return { voided: invoiceId };
  },
);
