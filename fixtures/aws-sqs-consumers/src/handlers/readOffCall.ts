// Reads one field straight off the parse.

import { save } from "../lib/ledger";

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<void> {
  const kinds = event.Records.map((record) => JSON.parse(record.body).kind);
  await save(kinds);
}
