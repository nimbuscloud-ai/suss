/**
 * The method a class has under a name, its bases' included, for a walk
 * that looks a method up on a subclass the call was sent to rather than
 * on the class the calling method is written in.
 */

import { askResolution } from "./program.js";
import { MEMBERS_QUESTION } from "./receiverSelf.js";

import type { Database, OnDemandRules } from "@suss/datalog";

/**
 * The member a class has under a name, its bases' included, once the
 * members a nearer one overrides are set aside. Null when there is none,
 * or more than one, as with two bases that both write it.
 */
export function memberOf(
  db: Database,
  classKey: string,
  name: string,
  program: OnDemandRules,
): string | null {
  askResolution(db, [classKey], MEMBERS_QUESTION, program);
  const overridden = new Set(
    db
      .lookup("wantedMemberOverridden", 0, classKey)
      .filter((row) => String(row[1]) === name)
      .map((row) => String(row[2])),
  );
  const found = [
    ...new Set(
      db
        .lookup("wantedMemberOf", 0, classKey)
        .filter((row) => String(row[1]) === name)
        .map((row) => String(row[2]))
        .filter((held) => !overridden.has(held)),
    ),
  ];
  const [only] = found;
  return found.length === 1 && only !== undefined ? only : null;
}
