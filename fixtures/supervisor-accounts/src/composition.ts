import { AccountService } from "./accountService";

export function getAccountService(): AccountService {
  return new AccountService({
    table: process.env.ACCOUNTS_TABLE ?? "accounts",
  });
}
