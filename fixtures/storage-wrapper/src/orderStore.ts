// A storage layer that is told which table to read. The table name is a
// field of the argument its caller passes, so nothing in this file says
// which table the code reaches.

import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

declare const client: DynamoDBClient;

export interface RowLocation {
  table: string;
  customer: string;
}

export async function readRow(location: RowLocation) {
  return client.send(
    new GetItemCommand({
      TableName: location.table,
      // The table keys on orderId, so picking a row by customerId is a
      // request DynamoDB refuses. The template beside this fixture is
      // what says so.
      Key: { customerId: { S: location.customer } },
      ProjectionExpression: "orderId, total",
    }),
  );
}
