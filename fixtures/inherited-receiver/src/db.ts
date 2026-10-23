export const db = {
  async insert(table: string, row: Record<string, unknown>): Promise<void> {
    await fetch(`https://db.internal/${table}`, {
      method: "POST",
      body: JSON.stringify(row),
    });
  },

  async update(
    table: string,
    where: Record<string, unknown>,
    changes: Record<string, unknown>,
  ): Promise<void> {
    await fetch(`https://db.internal/${table}`, {
      method: "PATCH",
      body: JSON.stringify({ where, changes }),
    });
  },
};
