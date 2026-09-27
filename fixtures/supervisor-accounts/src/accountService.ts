export interface Account {
  id: string;
  name: string;
}

export interface AccountServiceOptions {
  table: string;
}

export class AccountService {
  constructor(private readonly options: AccountServiceOptions) {}

  async find(id: string): Promise<Account | null> {
    return id.length > 0 ? { id, name: this.options.table } : null;
  }

  async rename(id: string, name: string): Promise<Account | null> {
    return id.length > 0 ? { id, name } : null;
  }
}
