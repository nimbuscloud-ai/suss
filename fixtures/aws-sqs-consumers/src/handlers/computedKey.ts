// Destructures a field whose name the environment picks.

import { save } from "../lib/ledger";

import type { SQSEvent } from "aws-lambda";

const REGION_FIELD = process.env.REGION_FIELD ?? "region";

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const { [REGION_FIELD]: region, id } = JSON.parse(record.body);
    await save(region, id);
  }
}
