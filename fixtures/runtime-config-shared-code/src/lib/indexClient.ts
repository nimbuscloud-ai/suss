// Imported by both handlers. Only the indexer builds it with no argument,
// so only IndexerFunction runs the default and reads INDEX_TABLE_NAME.
// The notifier passes a table, and its function declares no such variable.

export class IndexClient {
  constructor(
    private readonly table: string | undefined = process.env.INDEX_TABLE_NAME,
  ) {}

  tableName(): string | undefined {
    return this.table;
  }
}
