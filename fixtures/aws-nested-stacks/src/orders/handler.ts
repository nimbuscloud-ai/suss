import type { SQSBatchItemFailure, SQSHandler } from "aws-lambda";

export const handler: SQSHandler = async (event) => {
  const batchItemFailures: SQSBatchItemFailure[] = [];
  for (const record of event.Records) {
    if (record.body.length === 0) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    await process.stdout.write(`${record.body}\n`);
  }
  return { batchItemFailures };
};
