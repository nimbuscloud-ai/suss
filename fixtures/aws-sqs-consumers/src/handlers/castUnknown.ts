// A helper that takes anything and casts it to the Lambda record.

import { save } from "../lib/ledger";

import type { SQSEvent, SQSRecord } from "aws-lambda";

function readAnything(record: unknown): string {
  const { id } = JSON.parse((record as SQSRecord).body);
  return id;
}

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    await save(readAnything(record));
  }
}
