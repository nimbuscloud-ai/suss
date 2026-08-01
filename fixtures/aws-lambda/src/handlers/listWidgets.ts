import type {
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

const widgets = [
  { id: "w1", name: "sprocket" },
  { id: "w2", name: "flange" },
];

// The envelope names the type it answers with, at the return site.
// The cast wraps the same object, so this is one return and one
// response.
export const handler: APIGatewayProxyHandlerV2 = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify({ widgets }),
  } as APIGatewayProxyStructuredResultV2;
};
