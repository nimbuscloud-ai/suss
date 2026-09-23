/**
 * Recognizes node-postgres queries and records each one as a storage
 * access on the tables its statement touches.
 *
 * A `Client`, a `Pool` and the client a pool hands back all declare
 * `query` in the same package, so the pack matches the receiver by its
 * type. A pool exported from a project module is read without the pack
 * needing that module's name. The README covers which statements it reads.
 */

import { declaredBy, pack, sqlStatements } from "@suss/recognize";

import type { PackDeclaration } from "@suss/ir-core";
import type { PatternPack, SqlMethod } from "@suss/recognize";

// node-postgres ships no types, so a TypeScript project gets the method
// declarations from DefinitelyTyped.
const CLIENT_MODULES = ["pg", "@types/pg"];

// `query` takes the statement as its first argument or as the `text` key
// of a config object.
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
 * A `query` counts only when node-postgres declares it, so a `query`
 * method on a class the project wrote is ignored.
 */
export function pgFramework(): PatternPack {
  return pack("pg", [QUERIES], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-pg",
  });
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-pg",
  dependencies: [{ ecosystem: "npm", name: "pg" }],
  reads:
    "node-postgres queries. Each one becomes a storage-access interaction on the tables its statement touches.",
};

export default pgFramework;
