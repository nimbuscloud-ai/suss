// A helper typed with the project's own record type, which lives in a
// folder named after the Lambda types.

import { save } from "../lib/ledger";

import type { Context } from "aws-lambda";
import type { SQSRecord } from "../aws-lambda/types";

function readReceived(record: SQSRecord): string {
  const { id } = JSON.parse(record.body);
  return `${id} at ${record.receivedAt}`;
}

export async function handler(
  event: { Records: SQSRecord[] },
  context: Context,
): Promise<void> {
  for (const record of event.Records) {
    await save(readReceived(record), context.awsRequestId);
  }
}
