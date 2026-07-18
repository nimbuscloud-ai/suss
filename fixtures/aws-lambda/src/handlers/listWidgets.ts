import type { APIGatewayProxyHandlerV2 } from "aws-lambda";

const widgets = [
  { id: "w1", name: "sprocket" },
  { id: "w2", name: "flange" },
];

export const handler: APIGatewayProxyHandlerV2 = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify({ widgets }),
  };
};
