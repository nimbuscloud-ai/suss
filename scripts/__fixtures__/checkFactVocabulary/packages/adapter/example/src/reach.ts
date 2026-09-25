import { lit, rule, variable as v } from "@suss/datalog";

import type { Database } from "@suss/datalog";

export const REACH_RULES = [
  rule("reachable", [v("f")], [lit("entry", v("f"))]),
];

export function seed(db: Database, key: string): void {
  db.add("entry", [key]);
}
