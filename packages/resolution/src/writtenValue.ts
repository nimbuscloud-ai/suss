import { placeholderValues, singleAnswers } from "./singleAnswer.js";

import type { Database } from "@suss/datalog";

/**
 * The single expression a value was written as, once the caller has
 * asked the rules about `key`. A call to a project function is asked
 * about as well, through `ask`, so the answer is what that function
 * returns rather than the call itself.
 */
export function writtenValueOf(
  db: Database,
  key: string,
  ask: (keys: readonly string[]) => void,
): string | null {
  const placeholders = placeholderValues(db);
  const direct = singleAnswers(db.facts("wantedIsWrittenAs"), placeholders).get(
    key,
  );
  if (direct === undefined) {
    return null;
  }

  const isCall = db.facts("call").some((row) => String(row[0]) === direct);
  if (!isCall) {
    return direct;
  }

  ask([direct]);
  const deeper = singleAnswers(db.facts("wantedIsWrittenAs"), placeholders).get(
    direct,
  );
  return deeper ?? direct;
}
