// A fluent builder that only looks like Drizzle. Nothing here is a
// storage access.

const qb = {
  select() {
    return { from: (table: string) => [table] };
  },
  insert(table: string) {
    return { values: (row: unknown) => [table, row] };
  },
};

export function lookalike() {
  qb.select().from("users");
  qb.insert("users").values({ a: 1 });
}
