import type { SQSBatchItemFailure, SQSHandler } from "aws-lambda";

// SQS consumer. It imports from "aws-lambda" so the pack sees it, and
// it declares no HTTP route, so the pack surfaces it as
// recognized-not-http.
//
// It answers Lambda with the records that failed, which is how a
// consumer asks for those to be retried and the rest to be dropped.
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
