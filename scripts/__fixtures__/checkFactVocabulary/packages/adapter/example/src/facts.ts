import type { Database } from "@suss/datalog";

function fact(db: Database, relation: string, ...tuple: string[]): void {
  db.add(relation, tuple);
}

/** One call to ReportJob, its callee, and the table it imports. */
export function emitCallFacts(
  db: Database,
  call: string,
  callee: string,
  declared: boolean,
): void {
  fact(db, "call", call, callee);
  fact(db, declared ? "func" : "callArg", callee);
  db.add("reportImport", [call, "orders"]);
}
