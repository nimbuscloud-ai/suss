import type { APIGatewayProxyHandlerV2 } from "aws-lambda";

// One handler wired to both GET and DELETE on /widgets/{widgetId}. The
// two SAM route Events produce two summaries sharing this body.
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const widgetId = event.pathParameters?.widgetId;
  if (!widgetId) {
    return { statusCode: 400, body: JSON.stringify({ error: "missing id" }) };
  }
  if (event.requestContext.http.method === "DELETE") {
    return { statusCode: 204, body: "" };
  }
  return { statusCode: 200, body: JSON.stringify({ widgetId }) };
};
