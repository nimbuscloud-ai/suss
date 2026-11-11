/**
 * Records which BigQuery tables a Ruby body reads and writes through the
 * google-cloud-bigquery gem. Ruby has no type annotations, so a receiver
 * counts when it follows back to the gem call that produced it. The
 * README lists the calls this reaches and what it leaves out.
 */

import {
  anyOf,
  constructedFrom,
  pack,
  returnedBy,
  sqlStatements,
  storageCalls,
} from "@suss/recognize";

import type { RubyPack } from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";
import type {
  ArgumentPick,
  CallStep,
  PatternPack,
  SqlMethod,
  StorageMethod,
} from "@suss/recognize";

/** The store name from OpenTelemetry's semantic conventions. */
const STORAGE_SYSTEM = "gcp.bigquery";

const DIALECT = "bigquery";

/** The extraction cache keys on this, so it goes up whenever what the pack reads changes. */
const VERSION = "1";

/**
 * The gem builds a client from `Google::Cloud::Bigquery.new` or from the
 * shorthand `Google::Cloud.bigquery`. The adapter reads a call to `new`
 * as a construction of the class it is called on, here `Bigquery`.
 */
const CLIENT = anyOf(
  constructedFrom({ from: ["Google::Cloud::Bigquery"], named: ["Bigquery"] }),
  constructedFrom({ from: ["Google::Cloud"], named: ["bigquery"] }),
);

const DATASET_OF_CLIENT = returnedBy("dataset", CLIENT);

/** The client, a dataset picked off it, or a table picked off either. */
const ADDRESSED = anyOf(
  CLIENT,
  DATASET_OF_CLIENT,
  returnedBy("table", anyOf(CLIENT, DATASET_OF_CLIENT)),
);

const DATASET_STEP: CallStep = { to: "receiver", method: "dataset" };
const TABLE_STEP: CallStep = { to: "receiver", method: "table" };

const DATASET: ArgumentPick = { of: [DATASET_STEP], at: 0 };

/** A client and a dataset both accept these. */
const STATEMENT: SqlMethod = { statement: { at: 0 } };

const QUERIES = sqlStatements({
  system: STORAGE_SYSTEM,
  dialect: DIALECT,
  client: ADDRESSED,
})
  .methods({ query: STATEMENT, query_job: STATEMENT })
  .scope(DATASET)
  .example('bigquery.dataset("core").query("SELECT id FROM events")');

const WRITE: StorageMethod = { kind: "write" };
const READ: StorageMethod = { kind: "read" };

/**
 * Called on a dataset these take the table as the first argument, and
 * called on a table they take the rows or a file there instead, so the
 * table the chain picked comes first.
 */
const ROWS = storageCalls({
  system: STORAGE_SYSTEM,
  client: ADDRESSED,
  unsettledName: "nothing",
})
  .methods({
    insert: WRITE,
    insert_async: WRITE,
    load: WRITE,
    load_job: WRITE,
    data: READ,
    "exists?": READ,
    delete: WRITE,
  })
  .container([{ of: [TABLE_STEP], at: 0 }, { at: 0 }], { qualified: true })
  .scope(DATASET)
  .example('bigquery.dataset("core").table("report_runs").insert(rows)');

/** The gem's queries and row calls, declared once for any adapter that runs them. */
export function bigqueryQueries(): PatternPack {
  return pack("bigquery-ruby", [QUERIES, ROWS], {
    languages: ["ruby"],
    recognizedAs: "ruby-raw-sql",
    version: VERSION,
  });
}

/**
 * Adds BigQuery to the pack a run already uses. A Rails app reaches
 * BigQuery through the gem, outside ActiveRecord, so the web framework's
 * pack still discovers the units and this adds the table accesses.
 */
export function withBigquery(pack: RubyPack): RubyPack {
  const queries = bigqueryQueries();
  return {
    ...pack,
    invocationRecognizers: [
      ...(pack.invocationRecognizers ?? []),
      ...(queries.invocationRecognizers ?? []),
    ],
    accessRecognizers: [
      ...(pack.accessRecognizers ?? []),
      ...(queries.accessRecognizers ?? []),
    ],
  };
}

export function bigqueryRubyFramework(): RubyPack {
  return withBigquery({
    name: "bigquery-ruby",
    version: VERSION,
    protocol: STORAGE_SYSTEM,
    discovery: [],
  });
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-bigquery-ruby",
  dependencies: [{ ecosystem: "rubygems", name: "google-cloud-bigquery" }],
  reads:
    "google-cloud-bigquery calls (Ruby): a call matches when its receiver follows back to a client the gem handed out, and the statement it was given is parsed for the tables it touches.",
};

export default bigqueryRubyFramework;
