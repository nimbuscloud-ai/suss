/**
 * Reads `invoiceId` at the top of the message. The producer on this
 * queue sends `id` there, so the check should report the read. The
 * payload is one level deep, which is the shape a handler reading the
 * platform's envelope would also have.
 */

import { makeSubjectHandler } from "../lib/makeSubjectHandler";

interface ShippedMessage {
  subject: "billing.invoiceShipped";
  invoiceId: unknown;
}

export const handler = makeSubjectHandler(
  { name: "shipped-worker", subject: "billing.invoiceShipped" as const },
  async (message: ShippedMessage) => {
    const invoiceId = message.invoiceId;
    if (typeof invoiceId !== "string") {
      throw new Error("invoice message has no invoiceId");
    }
    return { shipped: invoiceId };
  },
);
