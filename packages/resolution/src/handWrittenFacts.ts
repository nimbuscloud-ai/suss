import type { Database } from "@suss/datalog";

/**
 * States `callOutsideTests` for every call these facts mention, as an
 * adapter does for each call in a file that is not test code. The rules'
 * own tests write their facts by hand to stand for production code, and
 * only a call outside test code fills a production function's parameter.
 */
export function stateCallsOutsideTests(db: Database): void {
  for (const relation of ["call", "callArg", "callKeywordArg"]) {
    for (const [call] of db.facts(relation)) {
      db.add("callOutsideTests", [String(call)]);
    }
  }
}
