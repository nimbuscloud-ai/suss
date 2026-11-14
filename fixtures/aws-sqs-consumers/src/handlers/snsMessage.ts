// An SNS subscriber, whose message is under Sns.Message rather than body.

import { save } from "../lib/ledger";

import type { SNSEvent } from "aws-lambda";

export async function handler(event: SNSEvent): Promise<void> {
  for (const record of event.Records) {
    const message = JSON.parse(record.Sns.Message);
    await save(message.user_id);
  }
}
