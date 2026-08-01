import type { APIGatewayProxyHandlerV2 } from "aws-lambda";

// HTTP handler that returns a variable, which the returnShape matcher
// does not resolve. The return stays unread, so the summary keeps its
// unread-return gap and low confidence.
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const response = {
    statusCode: 200,
    body: JSON.stringify({ path: event.rawPath }),
  };
  return response;
};
