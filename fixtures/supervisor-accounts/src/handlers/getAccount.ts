import { getAccountService } from "../composition";

interface AccountEvent {
  pathParameters?: { id?: string };
}

// Built once per cold start, outside the handler, so no request reaches
// the composition helper through a call.
const accounts = getAccountService();

export async function handler(event: AccountEvent) {
  const id = event.pathParameters?.id;
  if (id === undefined) {
    return { statusCode: 400, body: JSON.stringify({ error: "id required" }) };
  }

  const account = await accounts.find(id);
  if (account === null) {
    return { statusCode: 404, body: JSON.stringify({ error: "not found" }) };
  }
  return { statusCode: 200, body: JSON.stringify(account) };
}
