// An edge service that signs and posts the DynamoDB request itself, so
// there is no SDK command class anywhere. What the operation is and
// what the request is are both parameters of this one function.

interface Signer {
  fetch(url: string, init: unknown): Promise<Response>;
}

export async function sendRequest(
  region: string,
  signer: Signer,
  operation: string,
  request: object,
): Promise<Response> {
  return signer.fetch(`https://dynamodb.${region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.0",
      "X-Amz-Target": `DynamoDB_20120810.${operation}`,
    },
    body: JSON.stringify(request),
  });
}
