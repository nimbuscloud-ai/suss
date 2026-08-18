// The caller. It is the only place that says which table the storage
// layer reads, and it says it as a literal.

import { readRow } from "./orderStore.js";

export const getOrder = async (event: {
  pathParameters: { customer: string };
}) => {
  const row = await readRow({
    table: "orders-v1",
    customer: event.pathParameters.customer,
  });
  if (row.Item === undefined) {
    return { statusCode: 404, body: JSON.stringify({ error: "not found" }) };
  }
  return { statusCode: 200, body: JSON.stringify(row.Item) };
};
