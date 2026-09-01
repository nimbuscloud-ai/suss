/**
 * The consumer of `billing.invoicePaid`. It records the invoice in the
 * Invoices table, and it turns a message with no invoice id away.
 *
 * The channel comes from the template, which is the only place saying
 * which queue delivers here. The table comes from the SDK call, so the
 * doc can say the outcome results in a write to it.
 */

import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

import { makeSubjectHandler } from "../lib/makeSubjectHandler";

const dynamo = new DynamoDBClient({});

export const handler = makeSubjectHandler(
  { name: "invoice-worker", subject: "billing.invoicePaid" as const },
  async (message) => {
    const invoiceId = message.data.invoiceId;
    if (typeof invoiceId !== "string") {
      throw new Error("invoice message has no invoiceId");
    }
    await dynamo.send(
      new PutItemCommand({
        TableName: "Invoices",
        Item: {
          invoiceId: { S: invoiceId },
          paidAt: { S: new Date().toISOString() },
        },
      }),
    );
    return { recorded: true };
  },
);
