// Invokes ReportBuilder through the env var the template points at it,
// and a pricing function in another stack by full ARN.

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

const lambda = new LambdaClient({});

export async function handler(event: { orderId: string }): Promise<{
  ok: boolean;
}> {
  await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.REPORT_BUILDER_FUNCTION,
      Payload: JSON.stringify({ orderId: event.orderId }),
    }),
  );

  await lambda.send(
    new InvokeCommand({
      FunctionName:
        "arn:aws:lambda:us-east-1:123456789012:function:legacy-pricing",
      Payload: JSON.stringify({ orderId: event.orderId }),
    }),
  );

  return { ok: true };
}
