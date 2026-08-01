import type { APIGatewayProxyHandlerV2 } from "aws-lambda";

// HTTP handler answering through a ternary at the return site. Each
// branch is an envelope, so the summary carries exactly two response
// transitions and nothing else.
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const enabled = event.body !== undefined;
  return enabled
    ? { statusCode: 200, body: JSON.stringify({ enabled: true }) }
    : { statusCode: 400, body: JSON.stringify({ error: "missing body" }) };
};
