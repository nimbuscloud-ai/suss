// Records sales with the ledger service through the client generated from
// openapi/ledger.json, which builds each request in its own runtime.
import { AccountsApi, Configuration } from "./generated/ledger/index.js";

const accounts = new AccountsApi(
  new Configuration({ basePath: process.env.LEDGER_URL }),
);

export async function recordSale(accountId: string, amountCents: number) {
  return accounts.createEntry({
    accountId,
    createEntryRequest: { amount_cents: amountCents },
  });
}

export async function account(accountId: string) {
  return accounts.getAccount({ accountId });
}
