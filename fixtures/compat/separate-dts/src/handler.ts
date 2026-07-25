import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { json } from "./response.js";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const id = event.pathParameters?.id;
  if (!id) {
    return json(400, { error: "missing id" });
  }
  return json(200, { id, name: "widget" });
};
