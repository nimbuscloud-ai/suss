/**
 * Recognize node-postgres queries and emit `storage-access` effects.
 *
 * Every query in the library goes through one method. `query` takes the
 * statement as its first argument, or as the `text` key of a config
 * object, and both spellings are the same call, so the method states
 * both picks.
 *
 * The receiver is settled by type rather than by what the program
 * called it. A `Client`, a `Pool` and the client a pool hands back all
 * declare `query` in the same package, so a project that exports its
 * pool from a module of its own is read without this knowing what that
 * module is called.
 */

import { declaredBy, pack, sqlStatements } from "@suss/recognize";

import type { PackDeclaration } from "@suss/ir-core";
import type { PatternPack, SqlMethod } from "@suss/recognize";

/**
 * The packages that declare the client's methods. node-postgres ships
 * no types of its own, so a project reaching it through TypeScript has
 * the declarations from DefinitelyTyped instead.
 */
const CLIENT_MODULES = ["pg", "@types/pg"];

/** Where a query states its statement, in the two spellings pg takes. */
const STATEMENT: SqlMethod = {
  statement: [{ at: 0 }, { at: 0, property: ["text"] }],
};

const QUERIES = sqlStatements({
  system: "postgresql",
  dialect: "postgresql",
  client: declaredBy(...CLIENT_MODULES),
})
  .methods({ query: STATEMENT })
  .example('pool.query("SELECT id, email FROM users WHERE id = $1", [id])');

/**
 * Pack export. One declaration, gated on a file reaching the client
 * library, since that is where a query can come from.
 */
export function pgFramework(): PatternPack {
  return pack("pg", [QUERIES], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-pg",
  });
}

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-pg",
  dependencies: [{ ecosystem: "npm", name: "pg" }],
  reads:
    "node-postgres queries, emits storage-access interactions with the tables each statement touches.",
};

export default pgFramework;
