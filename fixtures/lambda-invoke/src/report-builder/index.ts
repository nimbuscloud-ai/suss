// Invoked by OrderApi. Hands the finished report to ArchiveWorker
// without waiting for it.

import { InvokeAsyncCommand, LambdaClient } from "@aws-sdk/client-lambda";

const lambda = new LambdaClient({});

export async function handler(event: { orderId: string }): Promise<{
  reportId: string;
}> {
  const reportId = `report-${event.orderId}`;

  await lambda.send(
    new InvokeAsyncCommand({
      FunctionName: process.env.ARCHIVE_WORKER_FUNCTION,
      InvokeArgs: JSON.stringify({ reportId }),
    }),
  );

  return { reportId };
}
