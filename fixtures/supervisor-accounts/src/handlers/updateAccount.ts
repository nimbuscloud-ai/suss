import { getAccountService } from "../composition";

interface AccountEvent {
  pathParameters?: { id?: string };
  body?: string;
}

const accounts = getAccountService();

export async function handler(event: AccountEvent) {
  const id = event.pathParameters?.id;
  if (id === undefined) {
    return { statusCode: 400, body: JSON.stringify({ error: "id required" }) };
  }

  const { name } = JSON.parse(event.body ?? "{}") as { name?: string };
  const account = await accounts.rename(id, name ?? "");
  if (account === null) {
    return { statusCode: 404, body: JSON.stringify({ error: "not found" }) };
  }
  return { statusCode: 200, body: JSON.stringify(account) };
}
