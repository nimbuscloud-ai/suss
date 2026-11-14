// Helpers that take one record, typed as the Lambda record in three ways.

import { save } from "../lib/ledger";

import type { SQSEvent, SQSRecord } from "aws-lambda";

type RetriedRecord = SQSRecord & { attempt: number };
type MaybeRecord = SQSRecord | undefined;

function readOrder(record: SQSRecord): string {
  const { id } = JSON.parse(record.body);
  return id;
}

function readRetried(record: RetriedRecord): string {
  const { reason } = JSON.parse(record.body);
  return `${reason} after ${record.attempt}`;
}

function readMaybe(record: MaybeRecord): string | null {
  if (record === undefined) {
    return null;
  }
  const { region } = JSON.parse(record.body);
  return region;
}

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    await save(
      readOrder(record),
      readRetried({ ...record, attempt: 1 }),
      readMaybe(record),
    );
  }
}
