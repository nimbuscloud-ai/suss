/**
 * environmentReach.ts: which environment objects the rules followed into
 * one value, for an adapter that states a file's facts before it asks
 * anything, as Python and Ruby do.
 *
 * A schema parsed against the environment is often handed it through a
 * parameter, `def load(env=os.environ)`, so the value the parse is given
 * is a name the source never spells as the environment. The
 * `wantedEnvironmentValue` question follows the environment into it the
 * way a read site's object is followed.
 */

import { askResolution } from "./program.js";

import type { Database, OnDemandRules } from "@suss/datalog";

/** The environment objects the rules followed into the value at `key`. Empty in a run that states none. */
export function environmentsReaching(
  db: Database,
  key: string,
  program: OnDemandRules,
): string[] {
  if (db.size("environmentObject") === 0) {
    return [];
  }
  askResolution(db, [key], "wanted", program);
  return db
    .lookup("wantedEnvironmentValue", 0, key)
    .map((row) => String(row[1]));
}
