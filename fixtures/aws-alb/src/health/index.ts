// Lambda handler behind the ALB's /api/health target group.

import type { ALBHandler, ALBResult } from "aws-lambda";

export const handler: ALBHandler = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true }),
  } as ALBResult;
};
