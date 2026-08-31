/**
 * Passes the message on whole instead of reading fields off it. The
 * fields it ends up using are decided in `recordRefund`, so this
 * summary's read list is not the whole story and nothing is reported.
 */

import { makeSubjectHandler } from "../lib/makeSubjectHandler";
import { recordRefund } from "../lib/recordRefund";

export const handler = makeSubjectHandler(
  { name: "refunded-worker", subject: "billing.invoiceRefunded" as const },
  async (message) => {
    await recordRefund(message);
    return { forwarded: true };
  },
);
