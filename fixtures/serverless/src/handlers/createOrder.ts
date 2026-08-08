// The handler behind the POST /api/orders route in serverless.yml.
export const handler = async (event: {
  body?: string;
}): Promise<{ statusCode: number; body: string }> => {
  if (event.body === undefined) {
    return { statusCode: 400, body: JSON.stringify({ error: "empty body" }) };
  }

  return { statusCode: 201, body: JSON.stringify({ ok: true }) };
};
