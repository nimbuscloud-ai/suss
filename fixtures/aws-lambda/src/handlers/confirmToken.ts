import type { APIGatewayProxyHandlerV2 } from "aws-lambda";

interface Envelope {
  statusCode: number;
  body: string;
}

// Same-module response helper — the pack traces the envelope shape from
// the `json(...)` call site rather than from this definition.
function json(payload: unknown, statusCode = 200): Envelope {
  return { statusCode, body: JSON.stringify(payload) };
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const tokenId = event.pathParameters?.tokenId;
  if (!tokenId) {
    return json({ error: "missing token id" }, 400);
  }
  return json({ tokenId, confirmed: true });
};
