// A queue with a batch size of one, so the handler reads the first record.

import { save } from "../lib/ledger";

import type { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<void> {
  const { id } = JSON.parse(event.Records[0].body);
  await save(id);
}
