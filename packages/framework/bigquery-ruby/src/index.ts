/**
 * Which BigQuery tables a Ruby body reads and writes through the
 * google-cloud-bigquery gem.
 *
 * The gem hands a client out from its own constant, and everything
 * after that is a call on what the client gave back. Ruby writes no
 * types, so the adapter types a receiver by following it back to the
 * gem call that produced it. The README says what that reaches and what
 * it leaves out.
 */

import type { RbRawSqlPattern, RubyPack } from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";

/** The store, in the words OpenTelemetry's semantic conventions use. */
const STORAGE_SYSTEM = "gcp.bigquery";

/** BigQuery's own SQL, which is none of the three the other stores write. */
const DIALECT = "bigquery";

/** The calls that narrow a client down to a dataset and a table. */
const ADDRESSING: NonNullable<RbRawSqlPattern["addressing"]> = {
  dataset: { says: "scope", at: 0 },
  table: { says: "container", at: 0 },
};

/** The calls that take a statement, which a project and a dataset both answer. */
const STATEMENTS: NonNullable<RbRawSqlPattern["statements"]> = {
  query: { at: 0 },
  query_job: { at: 0 },
};

/**
 * The calls that reach rows with no statement. A dataset takes the table
 * as its first argument where a table has it already, and the adapter
 * falls back to the chain's own table, so one entry covers both.
 */
const ROW_CALLS: NonNullable<RbRawSqlPattern["rowCalls"]> = {
  insert: { kind: "write", container: { at: 0 } },
  insert_async: { kind: "write", container: { at: 0 } },
  load: { kind: "write", container: { at: 0 } },
  load_job: { kind: "write", container: { at: 0 } },
  data: { kind: "read" },
  "exists?": { kind: "read" },
  delete: { kind: "write" },
};

/**
 * The two constants the gem hands a client out from:
 * `Google::Cloud::Bigquery.new` and the shorthand `Google::Cloud.bigquery`.
 * Everything after the client is the same either way.
 */
export function bigqueryRawSql(): RbRawSqlPattern[] {
  const calls = {
    addressing: ADDRESSING,
    statements: STATEMENTS,
    rowCalls: ROW_CALLS,
    storageSystem: STORAGE_SYSTEM,
    dialect: DIALECT,
  };
  return [
    {
      constantName: "Google::Cloud::Bigquery",
      clientBuilders: ["new"],
      ...calls,
    },
    { constantName: "Google::Cloud", clientBuilders: ["bigquery"], ...calls },
  ];
}

/**
 * Add BigQuery to whichever pack a run already uses. A Rails app reaches
 * BigQuery through the gem rather than through ActiveRecord, so this
 * composes with the web framework's pack rather than replacing it.
 */
export function withBigquery(pack: RubyPack): RubyPack {
  return {
    ...pack,
    rawSql: [...(pack.rawSql ?? []), ...bigqueryRawSql()],
  };
}

export function bigqueryRubyFramework(): RubyPack {
  return {
    name: "bigquery-ruby",
    protocol: STORAGE_SYSTEM,
    discovery: [],
    rawSql: bigqueryRawSql(),
  };
}

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-bigquery-ruby",
  dependencies: [{ ecosystem: "rubygems", name: "google-cloud-bigquery" }],
  reads:
    "google-cloud-bigquery calls (Ruby): a call matches when its receiver follows back to a client the gem handed out, and the statement it was given is parsed for the tables it touches.",
};

export default bigqueryRubyFramework;
