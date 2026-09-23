/**
 * Records which BigQuery tables a Ruby body reads and writes through the
 * google-cloud-bigquery gem. Ruby has no type annotations, so the adapter
 * types a receiver by following it back to the gem call that produced
 * it. The README lists the calls this reaches and what it leaves out.
 */

import type { RbRawSqlPattern, RubyPack } from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";

/** The store name from OpenTelemetry's semantic conventions. */
const STORAGE_SYSTEM = "gcp.bigquery";

const DIALECT = "bigquery";

const ADDRESSING: NonNullable<RbRawSqlPattern["addressing"]> = {
  dataset: { says: "scope", at: 0 },
  table: { says: "container", at: 0 },
};

/** A client and a dataset both accept these. */
const STATEMENTS: NonNullable<RbRawSqlPattern["statements"]> = {
  query: { at: 0 },
  query_job: { at: 0 },
};

/**
 * Called on a dataset these take the table as the first argument, and
 * called on a table they leave it out. The adapter falls back to the
 * chain's own table, so one entry covers both.
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
 * The gem builds a client from `Google::Cloud::Bigquery.new` or from the
 * shorthand `Google::Cloud.bigquery`. Calls on the client read the same
 * way whichever one built it.
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
 * Adds BigQuery to the pack a run already uses. A Rails app reaches
 * BigQuery through the gem, outside ActiveRecord, so the web framework's
 * pack still discovers the units and this adds the table accesses.
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

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-bigquery-ruby",
  dependencies: [{ ecosystem: "rubygems", name: "google-cloud-bigquery" }],
  reads:
    "google-cloud-bigquery calls (Ruby): a call matches when its receiver follows back to a client the gem handed out, and the statement it was given is parsed for the tables it touches.",
};

export default bigqueryRubyFramework;
