import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
// Not installed, and nothing describes it. Whatever it returns is opaque.
import { lookup } from "some-unpublished-internal-lib";
import { json } from "./response.js";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const id = event.pathParameters?.id;
  if (!id) {
    return json(400, { error: "missing id" });
  }
  const thing = await lookup(id);
  return json(200, { id, name: thing.name });
};
