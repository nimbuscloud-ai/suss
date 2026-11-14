// Parses three things in a consumer, none of them a message's body.

import { save } from "../lib/ledger";

import type { SQSEvent } from "aws-lambda";

const settings = {
  parse: (text: string): Record<string, string> => ({ raw: text }),
};

function readDefaults(input: string): unknown {
  return JSON.parse(input);
}

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const id = JSON.parse(record.messageId);
    const overrides = settings.parse(record.body);
    await save(id, overrides, readDefaults("{}"));
  }
}
