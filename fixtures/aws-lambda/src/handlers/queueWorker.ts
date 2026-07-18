import type { SQSHandler } from "aws-lambda";

// SQS consumer — imports from "aws-lambda" so the pack sees it, but it
// declares no HTTP route. The pack surfaces it as recognized-not-http.
export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    await process.stdout.write(`${record.body}\n`);
  }
};
