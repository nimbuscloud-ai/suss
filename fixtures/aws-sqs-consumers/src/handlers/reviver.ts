// Parses each body with a reviver that turns the amount back into a number.

import { save } from "../lib/ledger";

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const { id, amount } = JSON.parse(record.body, (key, value) =>
      key === "amount" ? Number(value) : value,
    );
    await save(id, amount);
  }
}
