/**
 * A route whose outcome turns on what a storage read found: 404 when
 * the table has no such invoice, 409 when the one it has is already
 * settled, 200 otherwise.
 *
 * The guard tests the result of the call that reached the table, which
 * is the two-hop chain a drafted `when` clause says in one line.
 */

import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

const dynamo = new DynamoDBClient({});

interface LookupEvent {
  pathParameters: { invoiceId: string };
}

export async function handler(event: LookupEvent) {
  const found = await dynamo.send(
    new GetItemCommand({
      TableName: "Invoices",
      Key: { invoiceId: { S: event.pathParameters.invoiceId } },
    }),
  );
  if (!found.Item) {
    return { statusCode: 404, body: JSON.stringify({ error: "no invoice" }) };
  }
  if (found.Item.settledAt) {
    return { statusCode: 409, body: JSON.stringify({ error: "settled" }) };
  }
  return { statusCode: 200, body: JSON.stringify({ invoice: found.Item }) };
}
