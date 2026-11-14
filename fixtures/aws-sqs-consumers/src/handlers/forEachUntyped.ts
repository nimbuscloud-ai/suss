// A callback over a batch the handler types in place.

import { save } from "../lib/ledger";

import type { Context } from "aws-lambda";

export async function handler(
  event: { Records: Array<{ body: string }> },
  context: Context,
): Promise<void> {
  event.Records.forEach((record) => {
    const { id } = JSON.parse(record.body);
    void save(id, context.functionName);
  });
}
