// A record type the project declares under the Lambda type's name.

import { save } from "../lib/ledger";

import type { Context } from "aws-lambda";

interface SQSRecord {
  body: string;
}

function readOwn(record: SQSRecord): string {
  const { id } = JSON.parse(record.body);
  return id;
}

export async function handler(
  event: { Records: SQSRecord[] },
  context: Context,
): Promise<void> {
  for (const record of event.Records) {
    await save(readOwn(record), context.awsRequestId);
  }
}
