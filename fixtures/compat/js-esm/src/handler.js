/** @import { APIGatewayProxyHandlerV2 } from "aws-lambda" */
import { json } from "./response.js";

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const handler = async (event) => {
  const id = event.pathParameters?.id;
  if (!id) {
    return json(400, { error: "missing id" });
  }
  return json(200, { id, name: "widget" });
};
